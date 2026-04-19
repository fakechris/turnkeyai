import type { BrowserActionTrace } from "@turnkeyai/core-types/team";
import {
  DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS,
  MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS,
  MAX_BROWSER_CDP_ACTION_EVENTS,
  MAX_BROWSER_CDP_ACTION_TIMEOUT_MS,
  MAX_BROWSER_CDP_EVENT_PARAMS_BYTES,
  isBlockedBrowserCdpMethod,
  normalizeBrowserCdpMethod,
} from "@turnkeyai/core-types/team";
import type {
  RelayActionRequest,
  RelayScreenshotPayload,
} from "@turnkeyai/browser-bridge/transport/relay-protocol";

import type { ChromeDebuggerEventLike, ChromeExtensionPlatform, ChromeTabLike } from "./chrome-extension-types";
import type { RelayContentScriptExecuteResponse } from "./chrome-content-script-protocol";
import { ChromeRelayTabObserver, formatRelayTargetId } from "./chrome-tab-observer";

type RelayAction = RelayActionRequest["actions"][number];
type RelayCdpAction = Extract<RelayAction, { kind: "cdp" }>;
type RelayHoverAction = Extract<RelayAction, { kind: "hover" }>;
type RelayKeyAction = Extract<RelayAction, { kind: "key" }>;
type RelayDragAction = Extract<RelayAction, { kind: "drag" }>;
interface RelayCdpActionOutput {
  result: unknown;
  events: ChromeDebuggerEventLike[];
}
interface RelayHoverPoint {
  x: number;
  y: number;
  label?: string;
  tagName?: string;
}
interface RelayDragPoints {
  source: RelayHoverPoint;
  target: RelayHoverPoint;
}
interface CdpKeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
}

const MAX_CDP_TRACE_RESULT_BYTES = 4_096;
const BROWSER_KEY_MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};
const BROWSER_MODIFIER_KEY_DESCRIPTORS: Record<string, CdpKeyDescriptor> = {
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
};
const BROWSER_SPECIAL_KEY_DESCRIPTORS: Record<string, CdpKeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

export class ChromeRelayActionExecutor {
  private readonly contentScriptRetryAttempts = 20;
  private readonly contentScriptRetryDelayMs = 150;
  private readonly tabObserver: ChromeRelayTabObserver;
  private readonly maxWaitActionMs = 60_000;
  private readonly requestCompletionBufferMs = 500;
  private readonly maxScreenshotCaptureMs = 5_000;

  constructor(private readonly platform: ChromeExtensionPlatform) {
    this.tabObserver = new ChromeRelayTabObserver(platform);
  }

  async execute(request: RelayActionRequest) {
    let activeTab = request.relayTargetId
      ? await this.tabObserver.resolveObservedTarget(request.relayTargetId)
      : await this.resolveActiveTab();

    if (!activeTab?.id && !this.hasOpenAction(request)) {
      throw new Error("relay action executor requires an existing tab or an open action");
    }

    const debuggerTabsToDetach = new Set<number>();
    try {
      return await this.executeResolvedRequest(request, activeTab, debuggerTabsToDetach);
    } finally {
      await detachDebuggerTabs(this.platform, debuggerTabsToDetach);
    }
  }

  private async executeResolvedRequest(
    request: RelayActionRequest,
    activeTab: ChromeTabLike | null,
    debuggerTabsToDetach: Set<number>
  ) {
    const trace: BrowserActionTrace[] = [];
    const screenshotPayloads: RelayScreenshotPayload[] = [];
    const contentScriptBatch: RelayActionRequest["actions"] = [];
    const contentScriptState: {
      latestResponse: RelayContentScriptExecuteResponse | null;
    } = {
      latestResponse: null,
    };
    let needsFinalSnapshot = false;

    const flushContentScriptBatch = async (): Promise<RelayContentScriptExecuteResponse | null> => {
      if (!contentScriptBatch.length) {
        return null;
      }
      if (!activeTab?.id) {
        throw new Error("relay action executor could not resolve a target tab");
      }
      const normalizedBatch = this.normalizePageActions(request, contentScriptBatch.splice(0));
      const response = await this.sendContentScriptActions(activeTab.id, request.actionRequestId, normalizedBatch);
      trace.push(...response.trace);
      contentScriptState.latestResponse = response;
      needsFinalSnapshot = !response.page;
      return response;
    };

    for (let index = 0; index < request.actions.length; index += 1) {
      const action = request.actions[index]!;
      if (this.isContentScriptAction(action)) {
        contentScriptBatch.push(action);
        continue;
      }

      const contentScriptResponse = await flushContentScriptBatch();
      if (contentScriptResponse && !contentScriptResponse.ok) {
        return this.buildFailedContentScriptResult(activeTab, trace, screenshotPayloads, contentScriptResponse);
      }

      if (action.kind === "open") {
        const startedAt = Date.now();
        activeTab = activeTab?.id
          ? await this.platform.updateTab(activeTab.id, {
              url: action.url,
              active: true,
            })
          : await this.platform.createTab({
              url: action.url,
              active: true,
            });
        needsFinalSnapshot = true;
        trace.push({
          stepId: `${request.taskId}:relay-open:${index + 1}`,
          kind: "open",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: { url: action.url },
          output: {
            finalUrl: activeTab.url ?? action.url,
          },
        });
        continue;
      }

      if (!activeTab?.id) {
        throw new Error("relay action executor could not resolve a target tab");
      }

      if (action.kind === "hover") {
        const startedAt = Date.now();
        const point = await this.executeHoverAction(activeTab.id, action, debuggerTabsToDetach);
        needsFinalSnapshot = true;
        trace.push({
          stepId: `${request.taskId}:relay-hover:${index + 1}`,
          kind: "hover",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            selectors: action.selectors ?? [],
            refId: action.refId ?? null,
            text: action.text ?? null,
          },
          output: {
            x: point.x,
            y: point.y,
            label: point.label ?? null,
            tagName: point.tagName ?? null,
          },
        });
        continue;
      }

      if (action.kind === "key") {
        const startedAt = Date.now();
        const output = await this.executeKeyAction(activeTab.id, action, debuggerTabsToDetach);
        needsFinalSnapshot = true;
        trace.push({
          stepId: `${request.taskId}:relay-key:${index + 1}`,
          kind: "key",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            key: action.key,
            modifiers: action.modifiers ?? [],
          },
          output,
        });
        continue;
      }

      if (action.kind === "drag") {
        const startedAt = Date.now();
        const points = await this.executeDragAction(activeTab.id, action, debuggerTabsToDetach);
        needsFinalSnapshot = true;
        trace.push({
          stepId: `${request.taskId}:relay-drag:${index + 1}`,
          kind: "drag",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            source: summarizeRelayActionTarget(action.source),
            target: summarizeRelayActionTarget(action.target),
          },
          output: {
            source: points.source,
            target: points.target,
          },
        });
        continue;
      }

      if (action.kind === "cdp") {
        const startedAt = Date.now();
        const cdpResult = await this.executeCdpAction(activeTab.id, action, debuggerTabsToDetach);
        needsFinalSnapshot = true;
        trace.push({
          stepId: `${request.taskId}:relay-cdp:${index + 1}`,
          kind: "cdp",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            method: action.method,
            paramsBytes: jsonByteLength(action.params),
          },
          output: {
            method: action.method,
            ...summarizeCdpActionOutput(cdpResult),
          },
        });
        continue;
      }

      if (action.kind === "screenshot") {
        const startedAt = Date.now();
        const activeTabId: number | undefined = activeTab.id;
        if (typeof activeTabId !== "number") {
          throw new Error("relay screenshot capture requires a target tab id");
        }
        const stepTimeoutMs = this.resolveScreenshotCaptureTimeoutMs(request);
        const activationStartedAt = Date.now();
        activeTab = await withTimeout(
          this.platform.updateTab(activeTabId, { active: true }),
          stepTimeoutMs,
          `relay screenshot tab activation timed out after ${stepTimeoutMs}ms`
        );
        const remainingCaptureMs = stepTimeoutMs - (Date.now() - activationStartedAt);
        if (remainingCaptureMs <= 0) {
          throw new Error(`relay screenshot capture timed out after ${stepTimeoutMs}ms`);
        }
        const dataUrl = await withTimeout(
          this.platform.captureVisibleTab(activeTab.windowId, { format: "png" }),
          remainingCaptureMs,
          `relay screenshot capture timed out after ${remainingCaptureMs}ms`
        );
        const [, dataBase64 = ""] = /^data:image\/png;base64,(.+)$/.exec(dataUrl) ?? [];
        if (!dataBase64) {
          throw new Error("relay screenshot capture returned an empty payload");
        }
        screenshotPayloads.push({
          ...(action.label ? { label: action.label } : {}),
          mimeType: "image/png",
          dataBase64,
        });
        trace.push({
          stepId: `${request.taskId}:relay-screenshot:${index + 1}`,
          kind: "screenshot",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            label: action.label ?? null,
          },
          output: {
            mimeType: "image/png",
            dataBase64Length: dataBase64.length,
          },
        });
      }
    }

    const contentScriptResponse = await flushContentScriptBatch();
    if (contentScriptResponse && !contentScriptResponse.ok) {
      return this.buildFailedContentScriptResult(activeTab, trace, screenshotPayloads, contentScriptResponse);
    }

    const finalTab = activeTab;
    if (!finalTab || typeof finalTab.id !== "number") {
      throw new Error("relay action executor lost the target tab id");
    }
    const finalTabId = finalTab.id;
    const latestContentScriptResponse = contentScriptState.latestResponse;
    const finalSnapshotResponse =
      latestContentScriptResponse?.page && !needsFinalSnapshot
        ? latestContentScriptResponse
        : await this.sendContentScriptActions(finalTabId, request.actionRequestId, [{ kind: "snapshot", note: "final-relay-state" }]);
    if (!finalSnapshotResponse.ok) {
      return this.buildFailedContentScriptResult(
        activeTab,
        [...trace, ...finalSnapshotResponse.trace],
        screenshotPayloads,
        finalSnapshotResponse
      );
    }
    const finalTrace = finalSnapshotResponse === latestContentScriptResponse ? trace : [...trace, ...finalSnapshotResponse.trace];

    return {
      relayTargetId: formatRelayTargetId(finalTabId),
      url: finalSnapshotResponse?.page?.finalUrl ?? finalTab.url ?? "",
      ...(finalSnapshotResponse?.page?.title || finalTab.title
        ? { title: finalSnapshotResponse?.page?.title ?? finalTab.title }
        : {}),
      status: "completed" as const,
      ...(finalSnapshotResponse?.page ? { page: finalSnapshotResponse.page } : {}),
      trace: finalTrace,
      screenshotPaths: [],
      screenshotPayloads,
      artifactIds: [],
    };
  }

  private async resolveActiveTab() {
    const tabs = await this.platform.queryTabs({
      active: true,
      currentWindow: true,
    });
    return tabs.find((tab) => typeof tab.id === "number") ?? null;
  }

  private hasOpenAction(request: RelayActionRequest): boolean {
    return request.actions.some((action) => action.kind === "open");
  }

  private isContentScriptAction(action: RelayAction): boolean {
    return (
      action.kind === "snapshot" ||
      action.kind === "click" ||
      action.kind === "type" ||
      action.kind === "select" ||
      action.kind === "scroll" ||
      action.kind === "console" ||
      action.kind === "wait" ||
      action.kind === "waitFor"
    );
  }

  private async executeCdpAction(
    tabId: number,
    action: RelayCdpAction,
    debuggerTabsToDetach: Set<number>
  ): Promise<RelayCdpActionOutput> {
    const method = normalizeBrowserCdpMethod(action.method);
    if (!method || isBlockedBrowserCdpMethod(method)) {
      throw new Error(`relay cdp action method is not allowed: ${action.method}`);
    }
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay cdp action requires chrome debugger support");
    }
    const timeoutMs = normalizeCdpTimeoutMs(action.timeoutMs);
    debuggerTabsToDetach.add(tabId);
    const events = normalizeCdpEventOptions(action.events);
    if (events.waitFor && !this.platform.waitForDebuggerEvent) {
      throw new Error("relay cdp events require chrome debugger event support");
    }
    const waitForEvent =
      events.waitFor && this.platform.waitForDebuggerEvent
        ? this.platform.waitForDebuggerEvent(tabId, events.waitFor, events.timeoutMs)
        : null;
    const result = await withTimeout(
      this.platform.sendDebuggerCommand(tabId, method, action.params ?? {}),
      timeoutMs,
      `relay cdp action timed out after ${timeoutMs}ms: ${method}`
    );
    const waitedEvent = waitForEvent ? await waitForEvent : null;
    const drainInput = {
      ...(events.include ? { include: events.include } : {}),
      maxEvents: events.maxEvents,
    };
    const drainedEvents =
      (await this.platform.drainDebuggerEvents?.(tabId, drainInput)) ?? [];
    return {
      result,
      events: dedupeCdpEvents([...(waitedEvent ? [waitedEvent] : []), ...drainedEvents], events.maxEvents),
    };
  }

  private async executeDragAction(
    tabId: number,
    action: RelayDragAction,
    debuggerTabsToDetach: Set<number>
  ): Promise<RelayDragPoints> {
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay drag action requires chrome debugger support");
    }
    debuggerTabsToDetach.add(tabId);
    const evaluated = await this.platform.sendDebuggerCommand(tabId, "Runtime.evaluate", {
      expression: buildDragTargetExpression(action),
      returnByValue: true,
      awaitPromise: true,
    });
    const points = extractDragPoints(evaluated);
    await this.platform.sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: points.source.x,
      y: points.source.y,
      button: "none",
    });
    await this.platform.sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: points.source.x,
      y: points.source.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (const point of interpolateDragPoints(points.source, points.target, 6).slice(1)) {
      await this.platform.sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
      });
    }
    await this.platform.sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: points.target.x,
      y: points.target.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return points;
  }

  private async executeHoverAction(
    tabId: number,
    action: RelayHoverAction,
    debuggerTabsToDetach: Set<number>
  ): Promise<RelayHoverPoint> {
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay hover action requires chrome debugger support");
    }
    debuggerTabsToDetach.add(tabId);
    const evaluated = await this.platform.sendDebuggerCommand(tabId, "Runtime.evaluate", {
      expression: buildHoverTargetExpression(action),
      returnByValue: true,
      awaitPromise: true,
    });
    const point = extractHoverPoint(evaluated);
    await this.platform.sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
    });
    return point;
  }

  private async executeKeyAction(
    tabId: number,
    action: RelayKeyAction,
    debuggerTabsToDetach: Set<number>
  ): Promise<Record<string, unknown>> {
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay key action requires chrome debugger support");
    }
    debuggerTabsToDetach.add(tabId);
    const modifiers = [...new Set(action.modifiers ?? [])];
    const modifierMask = modifiers.reduce((mask, modifier) => mask | (BROWSER_KEY_MODIFIER_BITS[modifier] ?? 0), 0);
    let activeModifierMask = 0;
    let commandCount = 0;

    for (const modifier of modifiers) {
      activeModifierMask |= BROWSER_KEY_MODIFIER_BITS[modifier] ?? 0;
      await this.platform.sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        ...buildCdpKeyEventParams(
          BROWSER_MODIFIER_KEY_DESCRIPTORS[modifier] ?? toCdpKeyDescriptor(modifier),
          activeModifierMask
        ),
        modifiers: activeModifierMask,
      });
      commandCount += 1;
    }

    const keyDescriptor = toCdpKeyDescriptor(action.key);
    await this.platform.sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...buildCdpKeyEventParams(keyDescriptor, modifierMask),
      modifiers: modifierMask,
    });
    await this.platform.sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...buildCdpKeyEventParams(keyDescriptor, modifierMask),
      modifiers: modifierMask,
    });
    commandCount += 2;

    for (const modifier of [...modifiers].reverse()) {
      activeModifierMask &= ~(BROWSER_KEY_MODIFIER_BITS[modifier] ?? 0);
      await this.platform.sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        ...buildCdpKeyEventParams(
          BROWSER_MODIFIER_KEY_DESCRIPTORS[modifier] ?? toCdpKeyDescriptor(modifier),
          activeModifierMask
        ),
        modifiers: activeModifierMask,
      });
      commandCount += 1;
    }

    return {
      key: action.key,
      modifiers,
      modifierMask,
      commandCount,
    };
  }

  private buildFailedContentScriptResult(
    activeTab: ChromeTabLike | null | undefined,
    trace: BrowserActionTrace[],
    screenshotPayloads: RelayScreenshotPayload[],
    response: RelayContentScriptExecuteResponse
  ) {
    if (typeof activeTab?.id !== "number") {
      throw new Error("relay content script failure lost the target tab id");
    }
    return {
      relayTargetId: formatRelayTargetId(activeTab.id),
      url: activeTab.url ?? "about:blank",
      ...(activeTab.title ? { title: activeTab.title } : {}),
      status: "failed" as const,
      trace,
      screenshotPaths: [],
      screenshotPayloads,
      artifactIds: [],
      errorMessage: response.errorMessage ?? "content script execution failed",
    };
  }

  private resolveScreenshotCaptureTimeoutMs(request: RelayActionRequest): number {
    const remainingRequestBudgetMs = request.expiresAt - Date.now() - this.requestCompletionBufferMs;
    const budgetMs =
      Number.isFinite(remainingRequestBudgetMs) && remainingRequestBudgetMs > 0
        ? Math.trunc(remainingRequestBudgetMs)
        : 0;
    return Math.max(1, Math.min(this.maxScreenshotCaptureMs, budgetMs));
  }

  private normalizePageActions(
    request: RelayActionRequest,
    actions: RelayActionRequest["actions"]
  ): RelayActionRequest["actions"] {
    let remainingWaitBudgetMs = this.maxWaitActionMs;
    const remainingRequestBudgetMs = request.expiresAt - Date.now() - this.requestCompletionBufferMs;
    if (Number.isFinite(remainingRequestBudgetMs) && remainingRequestBudgetMs > 0) {
      remainingWaitBudgetMs = Math.min(remainingWaitBudgetMs, remainingRequestBudgetMs);
    }

    return actions.map((action) => {
      if (action.kind !== "wait" && action.kind !== "waitFor") {
        return action;
      }
      const timeoutMs =
        typeof action.timeoutMs === "number" && Number.isFinite(action.timeoutMs) && action.timeoutMs >= 0
          ? Math.trunc(action.timeoutMs)
          : action.kind === "waitFor"
            ? DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS
            : 0;
      if (timeoutMs > this.maxWaitActionMs) {
        throw new Error(
          `relay ${action.kind} action exceeds maximum supported duration: ${timeoutMs}ms > ${this.maxWaitActionMs}ms`
        );
      }
      if (timeoutMs > remainingWaitBudgetMs) {
        throw new Error(
          `relay ${action.kind} action exceeds remaining request budget: ${timeoutMs}ms > ${Math.max(
            0,
            Math.trunc(remainingWaitBudgetMs)
          )}ms`
        );
      }
      remainingWaitBudgetMs -= timeoutMs;
      return {
        ...action,
        timeoutMs,
      };
    });
  }

  private sendContentScriptActions(
    tabId: number,
    actionRequestId: string,
    actions: RelayActionRequest["actions"]
  ): Promise<RelayContentScriptExecuteResponse> {
    return retryAsync(
      () =>
        this.platform.sendTabMessage<RelayContentScriptExecuteResponse>(tabId, {
          type: "turnkeyai.relay.execute",
          actionRequestId,
          actions,
        }),
      {
        attempts: this.contentScriptRetryAttempts,
        delayMs: this.contentScriptRetryDelayMs,
        shouldRetry: (error) => isRetryableRelayContentScriptError(error),
        beforeRetry: async () => {
          await this.platform.injectContentScript?.(tabId).catch(() => undefined);
        },
      }
    );
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function buildHoverTargetExpression(action: RelayHoverAction): string {
  const target = summarizeRelayActionTarget(action);
  return `(() => {
    const target = ${JSON.stringify(target)};
    const textOf = (element) => [
      element.innerText,
      element.textContent,
      element.getAttribute && element.getAttribute("aria-label"),
      "value" in element ? element.value : ""
    ].filter(Boolean).join(" ").trim();
    const bySelectors = () => {
      for (const selector of target.selectors) {
        try {
          const found = document.querySelector(selector);
          if (found) return found;
        } catch {}
      }
      return null;
    };
    const byRef = () => {
      if (!target.refId) return null;
      return Array.from(document.querySelectorAll("[data-turnkeyai-ref]"))
        .find((element) => element.getAttribute("data-turnkeyai-ref") === target.refId) || null;
    };
    const byText = () => {
      if (!target.text) return null;
      const needle = target.text.trim().toLowerCase();
      const preferred = "button,a,input,textarea,select,label,[role],[data-turnkeyai-ref]";
      const candidates = [
        ...Array.from(document.querySelectorAll(preferred)),
        ...Array.from(document.querySelectorAll("body *")),
      ];
      return candidates.find((element) => textOf(element).toLowerCase().includes(needle)) || null;
    };
    const element = byRef() || bySelectors() || byText();
    if (!element) {
      return { ok: false, error: "hover target not found" };
    }
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { ok: false, error: "hover target has empty bounds" };
    }
    return {
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      tagName: element.tagName || null,
      label: textOf(element).slice(0, 120) || null
    };
  })()`;
}

function buildDragTargetExpression(action: RelayDragAction): string {
  const source = summarizeRelayActionTarget(action.source);
  const target = summarizeRelayActionTarget(action.target);
  return `(() => {
    const source = ${JSON.stringify(source)};
    const target = ${JSON.stringify(target)};
    const textOf = (element) => [
      element.innerText,
      element.textContent,
      element.getAttribute && element.getAttribute("aria-label"),
      "value" in element ? element.value : ""
    ].filter(Boolean).join(" ").trim();
    const resolve = (input, label) => {
      const bySelectors = () => {
        for (const selector of input.selectors) {
          try {
            const found = document.querySelector(selector);
            if (found) return found;
          } catch {}
        }
        return null;
      };
      const byRef = () => {
        if (!input.refId) return null;
        return Array.from(document.querySelectorAll("[data-turnkeyai-ref]"))
          .find((element) => element.getAttribute("data-turnkeyai-ref") === input.refId) || null;
      };
      const byText = () => {
        if (!input.text) return null;
        const needle = input.text.trim().toLowerCase();
        const preferred = "button,a,input,textarea,select,label,[role],[data-turnkeyai-ref]";
        const candidates = [
          ...Array.from(document.querySelectorAll(preferred)),
          ...Array.from(document.querySelectorAll("body *")),
        ];
        return candidates.find((element) => textOf(element).toLowerCase().includes(needle)) || null;
      };
      const element = byRef() || bySelectors() || byText();
      if (!element) {
        return { ok: false, error: "drag " + label + " target not found" };
      }
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return { ok: false, error: "drag " + label + " target has empty bounds" };
      }
      return {
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        tagName: element.tagName || null,
        label: textOf(element).slice(0, 120) || null
      };
    };
    const sourcePoint = resolve(source, "source");
    if (!sourcePoint.ok) return sourcePoint;
    const targetPoint = resolve(target, "target");
    if (!targetPoint.ok) return targetPoint;
    return { ok: true, source: sourcePoint, target: targetPoint };
  })()`;
}

function summarizeRelayActionTarget(target: { selectors?: string[]; refId?: string; text?: string }): Record<string, unknown> {
  return {
    selectors: target.selectors ?? [],
    refId: target.refId ?? null,
    text: target.text ?? null,
  };
}

function extractHoverPoint(value: unknown): RelayHoverPoint {
  const result = extractRuntimeResultValue(value);
  if (!result || typeof result !== "object") {
    throw new Error("relay hover target evaluation returned no value");
  }
  const record = result as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error(typeof record.error === "string" ? record.error : "relay hover target could not be resolved");
  }
  return extractRelayPoint(record, "relay hover target");
}

function extractDragPoints(value: unknown): RelayDragPoints {
  const result = extractRuntimeResultValue(value);
  if (!result || typeof result !== "object") {
    throw new Error("relay drag target evaluation returned no value");
  }
  const record = result as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error(typeof record.error === "string" ? record.error : "relay drag target could not be resolved");
  }
  return {
    source: extractRelayPoint(record.source, "relay drag source target"),
    target: extractRelayPoint(record.target, "relay drag destination target"),
  };
}

function extractRelayPoint(value: unknown, label: string): RelayHoverPoint {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} evaluation returned no value`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.y !== "number") {
    throw new Error(`${label} evaluation returned invalid coordinates`);
  }
  return {
    x: record.x,
    y: record.y,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(typeof record.tagName === "string" ? { tagName: record.tagName } : {}),
  };
}

function interpolateDragPoints(source: RelayHoverPoint, target: RelayHoverPoint, steps: number): Array<{ x: number; y: number }> {
  return Array.from({ length: steps }, (_, index) => {
    const ratio = steps <= 1 ? 1 : index / (steps - 1);
    return {
      x: source.x + (target.x - source.x) * ratio,
      y: source.y + (target.y - source.y) * ratio,
    };
  });
}

function extractRuntimeResultValue(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }
  const result = (value as { result?: unknown }).result;
  if (result && typeof result === "object" && "value" in result) {
    return (result as { value?: unknown }).value;
  }
  return null;
}

function toCdpKeyDescriptor(key: string): CdpKeyDescriptor {
  const special = BROWSER_SPECIAL_KEY_DESCRIPTORS[key];
  if (special) {
    return special;
  }
  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  if (/^[0-9]$/.test(key)) {
    return {
      key,
      code: `Digit${key}`,
      keyCode: key.charCodeAt(0),
      text: key,
    };
  }
  return {
    key,
    code: key,
    keyCode: 0,
  };
}

function buildCdpKeyEventParams(descriptor: CdpKeyDescriptor, modifiers: number): Record<string, unknown> {
  return {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
    ...(descriptor.location !== undefined ? { location: descriptor.location } : {}),
    ...(descriptor.text && modifiers === 0 ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}),
  };
}

function normalizeCdpTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_CDP_ACTION_TIMEOUT_MS)
    : MAX_BROWSER_CDP_ACTION_TIMEOUT_MS;
}

function normalizeCdpEventOptions(events: RelayCdpAction["events"]): {
  waitFor?: string;
  include?: string[];
  timeoutMs: number;
  maxEvents: number;
} {
  const waitFor = normalizeBrowserCdpMethod(events?.waitFor);
  const include = [...new Set([...(events?.include ?? []), ...(waitFor ? [waitFor] : [])])]
    .map((eventName) => normalizeBrowserCdpMethod(eventName))
    .filter((eventName): eventName is string => Boolean(eventName && !isBlockedBrowserCdpMethod(eventName)));
  const timeoutMs =
    typeof events?.timeoutMs === "number" && Number.isInteger(events.timeoutMs) && events.timeoutMs > 0
      ? Math.min(events.timeoutMs, MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS)
      : MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS;
  const maxEvents =
    typeof events?.maxEvents === "number" && Number.isInteger(events.maxEvents) && events.maxEvents > 0
      ? Math.min(events.maxEvents, MAX_BROWSER_CDP_ACTION_EVENTS)
      : MAX_BROWSER_CDP_ACTION_EVENTS;
  return {
    ...(waitFor && !isBlockedBrowserCdpMethod(waitFor) ? { waitFor } : {}),
    ...(include.length ? { include } : {}),
    timeoutMs,
    maxEvents,
  };
}

function summarizeCdpActionOutput(output: RelayCdpActionOutput): Record<string, unknown> {
  return {
    ...summarizeCdpResult(output.result),
    ...(output.events.length ? { events: summarizeCdpEvents(output.events) } : {}),
  };
}

function summarizeCdpResult(result: unknown): Record<string, unknown> {
  const json = safeStringify(result);
  const resultJsonBytes = byteLength(json);
  if (resultJsonBytes <= MAX_CDP_TRACE_RESULT_BYTES) {
    return { result: parseSafeJson(json) };
  }
  return {
    resultTruncated: true,
    resultJsonBytes,
  };
}

function summarizeCdpEvents(events: ChromeDebuggerEventLike[]): Array<Record<string, unknown>> {
  return events.map((event) => {
    const paramsJson = safeStringify(event.params ?? null);
    const paramsBytes = byteLength(paramsJson);
    return {
      method: event.method,
      timestamp: event.timestamp,
      paramsBytes,
      ...(paramsBytes <= MAX_BROWSER_CDP_EVENT_PARAMS_BYTES
        ? { params: parseSafeJson(paramsJson) }
        : { paramsTruncated: true }),
    };
  });
}

function dedupeCdpEvents(events: ChromeDebuggerEventLike[], maxEvents: number): ChromeDebuggerEventLike[] {
  const seen = new Set<string>();
  const deduped: ChromeDebuggerEventLike[] = [];
  for (const event of events) {
    const key = `${event.timestamp}:${event.method}:${safeStringify(event.params ?? null)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped.slice(-maxEvents);
}

async function detachDebuggerTabs(platform: ChromeExtensionPlatform, tabIds: ReadonlySet<number>): Promise<void> {
  await Promise.all([...tabIds].map((tabId) => platform.detachDebugger?.(tabId).catch(() => undefined)));
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null);
    return typeof json === "string" ? json : "null";
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseSafeJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function jsonByteLength(value: unknown): number {
  return value === undefined ? 0 : byteLength(safeStringify(value));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

async function retryAsync<T>(
  task: () => Promise<T>,
  input: {
    attempts: number;
    delayMs: number;
    shouldRetry(error: unknown): boolean;
    beforeRetry?(error: unknown): Promise<void>;
  }
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < input.attempts; index += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (index === input.attempts - 1 || !input.shouldRetry(error)) {
        throw error;
      }
      await input.beforeRetry?.(error);
      await sleep(input.delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("relay content script retry exhausted");
}

function isRetryableRelayContentScriptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /receiving end does not exist/i.test(message) ||
    /message port closed/i.test(message) ||
    /frame with id .* was removed/i.test(message) ||
    /cannot access contents of url/i.test(message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
