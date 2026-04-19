import type { BrowserActionTrace, BrowserSnapshotResult } from "@turnkeyai/core-types/team";
import { DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS } from "@turnkeyai/core-types/team";
import type { RelayExecutableBrowserAction } from "@turnkeyai/browser-bridge/transport/relay-protocol";

import type { ChromeRuntimeLike } from "./chrome-extension-types";
import {
  isRelayContentScriptExecuteRequest,
  type RelayContentScriptExecuteResponse,
} from "./chrome-content-script-protocol";

type DocumentLikeCollection = DocumentLikeElement[] | ArrayLike<DocumentLikeElement>;
type DocumentLikeOptionCollection = DocumentLikeOption[] | ArrayLike<DocumentLikeOption>;

interface DocumentLikeElement {
  tagName?: string;
  innerText?: string;
  textContent?: string;
  value?: string;
  selectedIndex?: number;
  options?: DocumentLikeOptionCollection;
  dataset?: Record<string, string | undefined>;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  click?(): void;
  focus?(): void;
  dispatchEvent?(event: unknown): void;
  querySelectorAll?(selector: string): DocumentLikeCollection;
}

interface DocumentLikeOption {
  value?: string;
  label?: string;
  text?: string;
  textContent?: string;
  selected?: boolean;
}

interface DocumentLike {
  title?: string;
  querySelectorAll?(selector: string): DocumentLikeCollection;
}

interface WindowLike {
  location?: {
    href?: string;
  };
  scrollY?: number;
  pageYOffset?: number;
  scrollBy?(options: { top: number; behavior: "instant" | "smooth" }): void;
}

export interface ChromeRelayContentScriptEnvironment {
  document: DocumentLike;
  window: WindowLike;
}

const MAX_RELAY_WAIT_ACTION_MS = 60_000;

export function registerChromeRelayContentScript(
  runtime: ChromeRuntimeLike,
  environment: ChromeRelayContentScriptEnvironment = getDefaultContentScriptEnvironment()
): void {
  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isRelayContentScriptExecuteRequest(message)) {
      return undefined;
    }

    void executeChromeRelayContentScriptActions(environment, message.actions)
      .then((response) => sendResponse(response))
      .catch((error) =>
        sendResponse({
          ok: false,
          trace: [],
          errorMessage: error instanceof Error ? error.message : "content script execution failed",
        } satisfies RelayContentScriptExecuteResponse)
      );
    return true;
  });
}

export async function executeChromeRelayContentScriptActions(
  environment: ChromeRelayContentScriptEnvironment,
  actions: ReadonlyArray<RelayExecutableBrowserAction>
): Promise<RelayContentScriptExecuteResponse> {
  const trace: BrowserActionTrace[] = [];
  let latestSnapshot: BrowserSnapshotResult | undefined;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const stepId = `relay-step:${index + 1}`;
    const startedAt = Date.now();
    try {
      if (action.kind === "snapshot") {
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "snapshot",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: { note: typeof action.note === "string" ? action.note : null },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            title: latestSnapshot.title,
            interactiveCount: latestSnapshot.interactives.length,
          },
        });
        continue;
      }

      if (action.kind === "click") {
        const element = resolveElement(environment.document, action as {
          refId?: unknown;
          selectors?: unknown;
          text?: unknown;
        });
        element.click?.();
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "click",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            refId: typeof action.refId === "string" ? action.refId : null,
            selectors: Array.isArray(action.selectors) ? action.selectors : [],
            text: typeof action.text === "string" ? action.text : null,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
          },
        });
        continue;
      }

      if (action.kind === "type") {
        const element = resolveElement(environment.document, action as {
          refId?: unknown;
          selectors?: unknown;
          text?: unknown;
        });
        if ("focus" in element && typeof element.focus === "function") {
          element.focus();
        }
        if ("value" in element) {
          element.value = typeof action.text === "string" ? action.text : "";
        }
        element.dispatchEvent?.(createDomEvent("input"));
        if (action.submit && typeof element.dispatchEvent === "function") {
          element.dispatchEvent(createDomEvent("submit"));
        }
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "type",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            refId: typeof action.refId === "string" ? action.refId : null,
            selectors: Array.isArray(action.selectors) ? action.selectors : [],
            textLength: typeof action.text === "string" ? action.text.length : 0,
            submit: Boolean(action.submit),
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
          },
        });
        continue;
      }

      if (action.kind === "select") {
        const element = resolveElement(environment.document, action as {
          refId?: unknown;
          selectors?: unknown;
        });
        const selected = selectElementOption(element, action as {
          value?: unknown;
          label?: unknown;
          index?: unknown;
        });
        element.dispatchEvent?.(createDomEvent("input"));
        element.dispatchEvent?.(createDomEvent("change"));
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "select",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            refId: typeof action.refId === "string" ? action.refId : null,
            selectors: Array.isArray(action.selectors) ? action.selectors : [],
            value: typeof action.value === "string" ? action.value : null,
            label: typeof action.label === "string" ? action.label : null,
            index: typeof action.index === "number" ? action.index : null,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            selectedValue: selected.value,
            selectedLabel: selected.label,
            selectedIndex: selected.index,
          },
        });
        continue;
      }

      if (action.kind === "scroll") {
        const amount = typeof action.amount === "number" && Number.isFinite(action.amount) ? action.amount : 800;
        const delta = action.direction === "up" ? amount * -1 : amount;
        environment.window.scrollBy?.({ top: delta, behavior: "instant" });
        const nextScrollY =
          typeof environment.window.scrollY === "number"
            ? environment.window.scrollY
            : typeof environment.window.pageYOffset === "number"
              ? environment.window.pageYOffset
              : delta;
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "scroll",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            direction: action.direction === "up" ? "up" : "down",
            amount,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            scrollY: nextScrollY,
          },
        });
        continue;
      }

      if (action.kind === "console") {
        const probe = action.probe === "interactive-summary" ? "interactive-summary" : "page-metadata";
        const result = executeConsoleProbe(environment, probe);
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "console",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            probe,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            result,
          },
        });
        continue;
      }

      if (action.kind === "wait") {
        const timeoutMs =
          typeof action.timeoutMs === "number" && Number.isFinite(action.timeoutMs) && action.timeoutMs >= 0
            ? Math.min(Math.trunc(action.timeoutMs), MAX_RELAY_WAIT_ACTION_MS)
            : 0;
        await sleep(timeoutMs);
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "wait",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            timeoutMs,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
          },
        });
        continue;
      }

      if (action.kind === "waitFor") {
        const timeoutMs =
          typeof action.timeoutMs === "number" && Number.isFinite(action.timeoutMs) && action.timeoutMs >= 0
            ? Math.min(Math.trunc(action.timeoutMs), MAX_RELAY_WAIT_ACTION_MS)
            : DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS;
        const element = await waitForElement(environment.document, action, timeoutMs);
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "waitFor",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            refId: typeof action.refId === "string" ? action.refId : null,
            selectors: Array.isArray(action.selectors) ? action.selectors : [],
            text: typeof action.text === "string" ? action.text : null,
            timeoutMs,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            tagName: element.tagName ?? null,
            label: extractElementText(element),
          },
        });
        continue;
      }

      if (action.kind === "open") {
        trace.push({
          stepId,
          kind: "open",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            url: action.url,
          },
          output: {
            finalUrl: environment.window.location?.href ?? "",
          },
        });
        continue;
      }

      throw new Error(`unsupported content script action: ${action.kind}`);
    } catch (error) {
      trace.push({
        stepId,
        kind: action.kind,
        startedAt,
        completedAt: Date.now(),
        status: "failed",
        input: {},
        errorMessage: error instanceof Error ? error.message : "content script action failed",
      });
      return {
        ok: false,
        trace,
        errorMessage: error instanceof Error ? error.message : "content script action failed",
      };
    }
  }

  return {
    ok: true,
    page: latestSnapshot ?? captureSnapshot(environment),
    trace,
  };
}

function captureSnapshot(environment: ChromeRelayContentScriptEnvironment): BrowserSnapshotResult {
  const elements = toElementArray(
    environment.document.querySelectorAll?.("a,button,input,textarea,select,[role='button'],[contenteditable='true']")
  );
  let refCounter = 0;
  const interactives = elements.slice(0, 50).map((element) => {
    const existingRef = element.dataset?.turnkeyaiRef;
    const refId = existingRef || `turnkeyai-ref-${++refCounter}`;
    if (!existingRef) {
      if (!element.dataset) {
        element.dataset = {};
      }
      element.dataset.turnkeyaiRef = refId;
      element.setAttribute?.("data-turnkeyai-ref", refId);
    }
    const label = extractElementText(element);
    return {
      refId,
      tagName: (element.tagName ?? "div").toLowerCase(),
      role: element.getAttribute?.("role") ?? inferRoleFromTag(element.tagName ?? "div"),
      label,
      selectors: [`[data-turnkeyai-ref="${refId}"]`],
    };
  });

  return {
    requestedUrl: environment.window.location?.href ?? "",
    finalUrl: environment.window.location?.href ?? "",
    title: environment.document.title ?? "",
    textExcerpt: interactives.map((item) => item.label).filter(Boolean).slice(0, 3).join(" ").slice(0, 240),
    statusCode: 200,
    interactives,
  };
}

function executeConsoleProbe(
  environment: ChromeRelayContentScriptEnvironment,
  probe: "page-metadata" | "interactive-summary"
): unknown {
  if (probe === "page-metadata") {
    return {
      title: environment.document.title ?? "",
      href: environment.window.location?.href ?? "",
      interactiveCount: toElementArray(
        environment.document.querySelectorAll?.(
          "a,button,input,textarea,select,[role='button'],[contenteditable='true']"
        )
      ).length,
    };
  }

  return toElementArray(
    environment.document.querySelectorAll?.("a,button,input,textarea,select,[role='button'],[contenteditable='true']")
  )
    .slice(0, 20)
      .map((element) => ({
        tagName: (element.tagName ?? "div").toLowerCase(),
        text: extractElementText(element).slice(0, 120),
        ariaLabel: element.getAttribute?.("aria-label"),
      }));
}

function resolveElement(
  documentLike: DocumentLike,
  action: { refId?: unknown; selectors?: unknown; text?: unknown }
): DocumentLikeElement {
  if (typeof action.refId === "string" && action.refId.trim()) {
    const refSelector = `[data-turnkeyai-ref="${action.refId.trim()}"]`;
    const matchedByRef = documentLike.querySelectorAll?.(refSelector)?.[0];
    if (matchedByRef) {
      return matchedByRef;
    }
  }

  if (Array.isArray(action.selectors)) {
    for (const selector of action.selectors) {
      if (typeof selector !== "string" || !selector.trim()) {
        continue;
      }
      const matchedBySelector = documentLike.querySelectorAll?.(selector)?.[0];
      if (matchedBySelector) {
        return matchedBySelector;
      }
    }
  }

  if (typeof action.text === "string" && action.text.trim()) {
    const trimmed = action.text.trim();
    const candidates = toElementArray(
      documentLike.querySelectorAll?.("a,button,input,textarea,select,[role='button'],[contenteditable='true']")
    );
    const matchedByText = candidates.find((element) => extractElementText(element).includes(trimmed));
    if (matchedByText) {
      return matchedByText;
    }
  }

  throw new Error("content script could not resolve target element");
}

async function waitForElement(
  documentLike: DocumentLike,
  action: { refId?: unknown; selectors?: unknown; text?: unknown },
  timeoutMs: number
): Promise<DocumentLikeElement> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return resolveElement(documentLike, action);
    } catch (error) {
      lastError = error;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(100, remainingMs));
  } while (true);

  throw new Error(lastError instanceof Error ? lastError.message : "content script waitFor target timed out");
}

function extractElementText(element: DocumentLikeElement): string {
  return (element.innerText ?? element.textContent ?? element.getAttribute?.("aria-label") ?? "").trim().slice(0, 160);
}

function selectElementOption(
  element: DocumentLikeElement,
  action: { value?: unknown; label?: unknown; index?: unknown }
): { value: string | null; label: string | null; index: number | null } {
  if (!("value" in element) && !("selectedIndex" in element)) {
    throw new Error("content script select target must be a select-like element");
  }

  const options = toOptionArray(element.options);
  const matched =
    typeof action.value === "string"
      ? options.find((option) => option.value === action.value) ?? { value: action.value }
      : typeof action.label === "string"
        ? options.find((option) => optionLabel(option) === action.label)
        : typeof action.index === "number"
          ? options[action.index]
          : null;
  if (!matched) {
    throw new Error("content script could not resolve select option");
  }

  const selectedIndex = options.indexOf(matched);
  if (selectedIndex >= 0 && typeof element.selectedIndex === "number") {
    element.selectedIndex = selectedIndex;
    for (const option of options) {
      option.selected = option === matched;
    }
  }
  if (matched.value !== undefined) {
    element.value = matched.value;
  }

  return {
    value: element.value ?? matched.value ?? null,
    label: optionLabel(matched) || null,
    index: selectedIndex >= 0 ? selectedIndex : typeof element.selectedIndex === "number" ? element.selectedIndex : null,
  };
}

function optionLabel(option: DocumentLikeOption): string {
  return (option.label ?? option.text ?? option.textContent ?? option.value ?? "").trim();
}

function inferRoleFromTag(tagName: string): string {
  const normalized = tagName.toLowerCase();
  if (normalized === "a") {
    return "link";
  }
  if (normalized === "button") {
    return "button";
  }
  if (normalized === "input" || normalized === "textarea" || normalized === "select") {
    return "textbox";
  }
  return "generic";
}

function toElementArray(
  collection: DocumentLikeCollection | undefined
): DocumentLikeElement[] {
  return collection ? Array.from(collection) : [];
}

function toOptionArray(collection: DocumentLikeOptionCollection | undefined): DocumentLikeOption[] {
  return collection ? Array.from(collection) : [];
}

function createDomEvent(type: string): unknown {
  if (typeof Event === "function") {
    return new Event(type, { bubbles: true, cancelable: true });
  }
  return { type };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDefaultContentScriptEnvironment(): ChromeRelayContentScriptEnvironment {
  const runtimeGlobal = globalThis as Record<string, unknown>;
  return {
    document: runtimeGlobal.document as DocumentLike,
    window: runtimeGlobal.window as WindowLike,
  };
}
