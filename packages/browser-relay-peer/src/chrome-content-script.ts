import type { BrowserActionTrace, BrowserSnapshotResult } from "@turnkeyai/core-types/team";
import {
  DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS,
  MAX_BROWSER_PROBE_ITEMS,
  MAX_BROWSER_STORAGE_READ_ENTRIES,
  MAX_BROWSER_STORAGE_READ_VALUE_BYTES,
} from "@turnkeyai/core-types/team";
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
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  target?: string;
  download?: string;
  innerText?: string;
  textContent?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  files?: unknown;
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
  readyState?: string;
  visibilityState?: string;
  activeElement?: DocumentLikeElement | null;
  body?: {
    innerText?: string;
    textContent?: string;
  };
  hasFocus?(): boolean;
  querySelectorAll?(selector: string): DocumentLikeCollection;
}

interface WindowLike {
  location?: {
    href?: string;
  };
  localStorage?: StorageLike;
  sessionStorage?: StorageLike;
  scrollY?: number;
  pageYOffset?: number;
  File?: new (parts: unknown[], name: string, options?: { type?: string }) => unknown;
  DataTransfer?: new () => {
    items: {
      add(file: unknown): void;
    };
    files: unknown;
  };
  atob?(data: string): string;
  scrollBy?(options: { top: number; behavior: "instant" | "smooth" }): void;
}

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
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

      if (action.kind === "probe") {
        const result = executeProbeAction(environment, action);
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "probe",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            probe: action.probe,
            maxItems: action.maxItems ?? null,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            result,
          },
        });
        continue;
      }

      if (action.kind === "storage") {
        const result = executeStorageAction(environment, action);
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "storage",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            area: action.area,
            action: action.action,
            key: "key" in action ? action.key : null,
            valueBytes: "value" in action ? byteLength(action.value) : null,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            ...result,
          },
        });
        continue;
      }

      if (action.kind === "upload") {
        const result = executeUploadAction(environment, action);
        latestSnapshot = captureSnapshot(environment);
        trace.push({
          stepId,
          kind: "upload",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            refId: typeof action.refId === "string" ? action.refId : null,
            selectors: Array.isArray(action.selectors) ? action.selectors : [],
            text: typeof action.text === "string" ? action.text : null,
            artifactId: action.artifactId,
            fileName: action.file?.name ?? null,
          },
          output: {
            finalUrl: latestSnapshot.finalUrl,
            ...result,
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

function executeProbeAction(
  environment: ChromeRelayContentScriptEnvironment,
  action: Extract<RelayExecutableBrowserAction, { kind: "probe" }>
): unknown {
  const limit = normalizeProbeMaxItems(action.maxItems);
  const href = environment.window.location?.href ?? "";

  if (action.probe === "page-state") {
    const activeElement = environment.document.activeElement ?? null;
    return {
      href,
      title: environment.document.title ?? "",
      readyState: environment.document.readyState ?? null,
      visibilityState: environment.document.visibilityState ?? null,
      focused: environment.document.hasFocus?.() ?? null,
      activeElement: activeElement
        ? {
            tagName: (activeElement.tagName ?? "div").toLowerCase(),
            role: activeElement.getAttribute?.("role") ?? null,
            text: extractElementText(activeElement),
            selector: selectorForElement(activeElement),
          }
        : null,
      interactiveCount: toElementArray(
        environment.document.querySelectorAll?.(
          "a,button,input,textarea,select,[role='button'],[contenteditable='true']"
        )
      ).length,
      formControlCount: toElementArray(environment.document.querySelectorAll?.("input,textarea,select,button")).length,
      downloadLinkCount: toElementArray(environment.document.querySelectorAll?.("a[download]")).length,
    };
  }

  if (action.probe === "forms") {
    return toElementArray(environment.document.querySelectorAll?.("input,textarea,select,button"))
      .slice(0, limit)
      .map((element) => ({
        tagName: (element.tagName ?? "div").toLowerCase(),
        type: element.type ?? element.getAttribute?.("type") ?? null,
        name: element.name ?? element.getAttribute?.("name") ?? null,
        id: element.id ?? null,
        placeholder: element.placeholder ?? element.getAttribute?.("placeholder") ?? null,
        label: extractElementText(element),
        valueLength: typeof element.value === "string" ? element.value.length : null,
        checked: typeof element.checked === "boolean" ? element.checked : null,
        disabled: Boolean(element.disabled),
        required: Boolean(element.required),
        selector: selectorForElement(element),
      }));
  }

  if (action.probe === "links") {
    return toElementArray(environment.document.querySelectorAll?.("a,button,[role='button']"))
      .slice(0, limit)
      .map((element) => ({
        tagName: (element.tagName ?? "div").toLowerCase(),
        text: extractElementText(element),
        href: element.href ?? element.getAttribute?.("href") ?? null,
        target: element.target ?? element.getAttribute?.("target") ?? null,
        role: element.getAttribute?.("role") ?? null,
        disabled: Boolean(element.disabled),
        selector: selectorForElement(element),
      }));
  }

  return toElementArray(
    environment.document.querySelectorAll?.(
      "a[download],a[href$='.csv'],a[href$='.pdf'],a[href$='.zip'],a[href$='.xlsx'],a[href$='.json']"
    )
  )
    .slice(0, limit)
    .map((element) => ({
      text: extractElementText(element),
      href: element.href ?? element.getAttribute?.("href") ?? null,
      download: element.download ?? element.getAttribute?.("download") ?? null,
      selector: selectorForElement(element),
    }));
}

function executeStorageAction(
  environment: ChromeRelayContentScriptEnvironment,
  action: Extract<RelayExecutableBrowserAction, { kind: "storage" }>
): Record<string, unknown> {
  const storage = action.area === "localStorage" ? environment.window.localStorage : environment.window.sessionStorage;
  if (!storage) {
    throw new Error(`content script storage area is unavailable: ${action.area}`);
  }
  if (action.action === "set") {
    storage.setItem(action.key, action.value);
    return {
      area: action.area,
      action: action.action,
      key: action.key,
      valueBytes: byteLength(action.value),
      entryCount: storage.length,
    };
  }
  if (action.action === "remove") {
    const removed = storage.getItem(action.key) !== null;
    storage.removeItem(action.key);
    return {
      area: action.area,
      action: action.action,
      key: action.key,
      removed,
      entryCount: storage.length,
    };
  }
  if (action.action === "clear") {
    const clearedCount = storage.length;
    storage.clear();
    return {
      area: action.area,
      action: action.action,
      clearedCount,
      entryCount: storage.length,
    };
  }
  if (action.key) {
    return {
      area: action.area,
      action: action.action,
      key: action.key,
      ...summarizeStorageValue(storage.getItem(action.key)),
      entryCount: storage.length,
    };
  }

  const entries = Array.from({ length: Math.min(storage.length, MAX_BROWSER_STORAGE_READ_ENTRIES) }, (_, index) => {
    const key = storage.key(index) ?? "";
    return {
      key,
      ...summarizeStorageValue(storage.getItem(key)),
    };
  });
  return {
    area: action.area,
    action: action.action,
    entries,
    entryCount: storage.length,
    entriesTruncated: storage.length > MAX_BROWSER_STORAGE_READ_ENTRIES,
  };
}

function executeUploadAction(
  environment: ChromeRelayContentScriptEnvironment,
  action: Extract<RelayExecutableBrowserAction, { kind: "upload" }>
): Record<string, unknown> {
  if (!action.file) {
    throw new Error("content script upload action is missing injected file payload");
  }
  const element = resolveElement(environment.document, action as {
    refId?: unknown;
    selectors?: unknown;
    text?: unknown;
  });
  const FileCtor = environment.window.File ?? (globalThis as { File?: WindowLike["File"] }).File;
  const DataTransferCtor =
    environment.window.DataTransfer ?? (globalThis as { DataTransfer?: WindowLike["DataTransfer"] }).DataTransfer;
  if (!FileCtor || !DataTransferCtor) {
    throw new Error("content script upload requires File and DataTransfer support");
  }
  const bytes = decodeBase64(action.file.dataBase64, environment);
  const file = new FileCtor([bytes], action.file.name, {
    type: action.file.mimeType ?? "application/octet-stream",
  });
  const dataTransfer = new DataTransferCtor();
  dataTransfer.items.add(file);
  try {
    element.files = dataTransfer.files;
  } catch {
    Object.defineProperty(element, "files", {
      configurable: true,
      value: dataTransfer.files,
    });
  }
  element.dispatchEvent?.(createDomEvent("input"));
  element.dispatchEvent?.(createDomEvent("change"));
  return {
    artifactId: action.artifactId,
    fileName: action.file.name,
    sizeBytes: action.file.sizeBytes,
    mimeType: action.file.mimeType ?? null,
  };
}

function decodeBase64(value: string, environment: ChromeRelayContentScriptEnvironment): Uint8Array {
  const decode = environment.window.atob ?? (globalThis as { atob?: (data: string) => string }).atob;
  if (!decode) {
    throw new Error("content script upload requires base64 decoder support");
  }
  const binary = decode(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function summarizeStorageValue(value: string | null): Record<string, unknown> {
  if (value === null) {
    return {
      found: false,
      value: null,
      valueBytes: 0,
      valueTruncated: false,
    };
  }
  const valueBytes = byteLength(value);
  return {
    found: true,
    value: valueBytes <= MAX_BROWSER_STORAGE_READ_VALUE_BYTES ? value : value.slice(0, MAX_BROWSER_STORAGE_READ_VALUE_BYTES),
    valueBytes,
    valueTruncated: valueBytes > MAX_BROWSER_STORAGE_READ_VALUE_BYTES,
  };
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

function selectorForElement(element: DocumentLikeElement): string | null {
  const id = element.id ?? element.getAttribute?.("id");
  if (id) {
    return `#${id}`;
  }
  const name = element.name ?? element.getAttribute?.("name");
  if (name) {
    return `${(element.tagName ?? "div").toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
  }
  const refId = element.dataset?.turnkeyaiRef ?? element.getAttribute?.("data-turnkeyai-ref");
  return refId ? `[data-turnkeyai-ref="${refId}"]` : null;
}

function normalizeProbeMaxItems(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_PROBE_ITEMS)
    : MAX_BROWSER_PROBE_ITEMS;
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function getDefaultContentScriptEnvironment(): ChromeRelayContentScriptEnvironment {
  const runtimeGlobal = globalThis as Record<string, unknown>;
  return {
    document: runtimeGlobal.document as DocumentLike,
    window: runtimeGlobal.window as WindowLike,
  };
}
