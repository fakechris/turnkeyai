import type { BrowserActionTrace, BrowserPermissionName } from "@turnkeyai/core-types/team";
import {
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_DIALOG_TIMEOUT_MS,
  DEFAULT_BROWSER_POPUP_TIMEOUT_MS,
  DEFAULT_BROWSER_WAIT_FOR_TIMEOUT_MS,
  MAX_BROWSER_CDP_ACTION_EVENT_TIMEOUT_MS,
  MAX_BROWSER_CDP_ACTION_EVENTS,
  MAX_BROWSER_CDP_ACTION_TIMEOUT_MS,
  MAX_BROWSER_CDP_EVENT_PARAMS_BYTES,
  MAX_BROWSER_COOKIE_READ_ENTRIES,
  MAX_BROWSER_COOKIE_READ_VALUE_BYTES,
  MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  MAX_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_EVAL_TIMEOUT_MS,
  MAX_BROWSER_EVAL_RESULT_BYTES,
  MAX_BROWSER_EVAL_TIMEOUT_MS,
  DEFAULT_BROWSER_NETWORK_TIMEOUT_MS,
  MAX_BROWSER_NETWORK_BODY_BYTES,
  MAX_BROWSER_NETWORK_HEADER_ENTRIES,
  MAX_BROWSER_NETWORK_HEADER_VALUE_BYTES,
  MAX_BROWSER_NETWORK_TIMEOUT_MS,
  MAX_BROWSER_PERMISSION_ORIGIN_LENGTH,
  MAX_BROWSER_UPLOAD_FILE_NAME_LENGTH,
  isBlockedBrowserCdpMethod,
  normalizeBrowserCdpMethod,
} from "@turnkeyai/core-types/team";
import type {
  RelayActionRequest,
  RelayDownloadPayload,
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
type RelayDialogAction = Extract<RelayAction, { kind: "dialog" }>;
type RelayPopupAction = Extract<RelayAction, { kind: "popup" }>;
type RelayCookieAction = Extract<RelayAction, { kind: "cookie" }>;
type RelayEvalAction = Extract<RelayAction, { kind: "eval" }>;
type RelayNetworkAction = Extract<RelayAction, { kind: "network" }>;
type RelayDownloadAction = Extract<RelayAction, { kind: "download" }>;
type RelayPermissionAction = Extract<RelayAction, { kind: "permission" }>;
interface RelayCdpActionOutput {
  result: unknown;
  events: ChromeDebuggerEventLike[];
}
interface RelayCdpCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
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
      : request.targetBehavior === "new"
        ? null
      : await this.resolveActiveTab();

    if (request.targetBehavior === "new" && !this.hasOpenAction(request)) {
      throw new Error("relay new-target requests require an open action");
    }

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
    const downloadPayloads: RelayDownloadPayload[] = [];
    const pendingDialogHandlers: Promise<void>[] = [];
    const pendingNetworkHandlers: Promise<void>[] = [];
    const pendingDownloadHandlers: Promise<RelayDownloadPayload>[] = [];
    const contentScriptBatch: RelayActionRequest["actions"] = [];
    const contentScriptState: {
      latestResponse: RelayContentScriptExecuteResponse | null;
    } = {
      latestResponse: null,
    };
    let createTargetForNextOpen = request.targetBehavior === "new";
    let pendingPopupWatcher: { pending: Promise<ChromeTabLike>; traceEntry: BrowserActionTrace } | null = null;
    let needsFinalSnapshot = false;

    const consumePendingPopup = async (): Promise<void> => {
      if (!pendingPopupWatcher) {
        return;
      }
      activeTab = await pendingPopupWatcher.pending;
      pendingPopupWatcher = null;
      contentScriptState.latestResponse = null;
      needsFinalSnapshot = true;
    };

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
        if (pendingPopupWatcher) {
          const response = await flushContentScriptBatch();
          if (response && !response.ok) {
            return this.buildFailedContentScriptResult(activeTab, trace, screenshotPayloads, downloadPayloads, response);
          }
          await consumePendingPopup();
        }
        continue;
      }

      const contentScriptResponse = await flushContentScriptBatch();
      if (contentScriptResponse && !contentScriptResponse.ok) {
        return this.buildFailedContentScriptResult(
          activeTab,
          trace,
          screenshotPayloads,
          downloadPayloads,
          contentScriptResponse
        );
      }

      if (action.kind === "open") {
        const startedAt = Date.now();
        activeTab =
          activeTab?.id && !createTargetForNextOpen
            ? await this.platform.updateTab(activeTab.id, {
                url: action.url,
                active: true,
              })
            : await this.platform.createTab({
                url: action.url,
                active: true,
              });
        createTargetForNextOpen = false;
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

      if (action.kind === "popup") {
        if (pendingPopupWatcher) {
          throw new Error("relay popup action is already armed");
        }
        const startedAt = Date.now();
        const timeoutMs = action.timeoutMs ?? DEFAULT_BROWSER_POPUP_TIMEOUT_MS;
        const traceEntry: BrowserActionTrace = {
          stepId: `${request.taskId}:relay-popup:${index + 1}`,
          kind: "popup",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            timeoutMs: action.timeoutMs ?? null,
          },
          output: {
            timeoutMs,
            armed: true,
          },
        };
        trace.push(traceEntry);
        const pending = this.armPopupAction(action, traceEntry, timeoutMs);
        pending.catch(() => undefined);
        pendingPopupWatcher = { pending, traceEntry };
        continue;
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

      if (action.kind === "dialog") {
        const startedAt = Date.now();
        const timeoutMs = action.timeoutMs ?? DEFAULT_BROWSER_DIALOG_TIMEOUT_MS;
        const traceEntry: BrowserActionTrace = {
          stepId: `${request.taskId}:relay-dialog:${index + 1}`,
          kind: "dialog",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            action: action.action,
            promptTextLength: action.promptText?.length ?? null,
            timeoutMs: action.timeoutMs ?? null,
          },
          output: {
            action: action.action,
            timeoutMs,
            armed: true,
          },
        };
        trace.push(traceEntry);
        const armed = await this.armDialogAction(activeTab.id, action, debuggerTabsToDetach, traceEntry, timeoutMs);
        pendingDialogHandlers.push(armed.pending);
        continue;
      }

      if (action.kind === "network" && !isArmedNetworkAction(action)) {
        const startedAt = Date.now();
        const output = await this.executeNetworkControlAction(activeTab.id, action, debuggerTabsToDetach);
        trace.push({
          stepId: `${request.taskId}:relay-network:${index + 1}`,
          kind: "network",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input:
            action.action === "blockUrls"
              ? {
                  action: action.action,
                  urlPatterns: action.urlPatterns,
                }
              : action.action === "setExtraHeaders"
                ? {
                    action: action.action,
                    headerNames: Object.keys(action.headers),
                  }
                : { action: action.action },
          output,
        });
        continue;
      }

      if (action.kind === "network" && isArmedNetworkAction(action)) {
        const startedAt = Date.now();
        const timeoutMs = normalizeNetworkTimeoutMs(action.timeoutMs);
        const traceEntry: BrowserActionTrace = {
          stepId: `${request.taskId}:relay-network:${index + 1}`,
          kind: "network",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input:
            action.action === "mockResponse"
              ? {
                  action: action.action,
                  urlPattern: action.urlPattern,
                  method: action.method ?? null,
                  status: action.status ?? null,
                  timeoutMs: action.timeoutMs ?? null,
                  headerNames: Object.keys(action.headers ?? {}),
                  bodyBytes: getCdpMockResponseBodyBytes(action),
                }
              : {
                  action: action.action,
                  urlPattern: action.urlPattern ?? null,
                  method: action.method ?? null,
                  status: "status" in action ? action.status ?? null : null,
                  timeoutMs: action.timeoutMs ?? null,
                  includeHeaders: action.includeHeaders ?? false,
                  maxBodyBytes: action.maxBodyBytes ?? null,
                },
          output: {
            action: action.action,
            timeoutMs,
            armed: true,
          },
        };
        trace.push(traceEntry);
        const armed = await this.armNetworkAction(activeTab.id, action, debuggerTabsToDetach, traceEntry, timeoutMs);
        pendingNetworkHandlers.push(armed.pending);
        continue;
      }

      if (action.kind === "download") {
        const startedAt = Date.now();
        const timeoutMs = normalizeDownloadTimeoutMs(action.timeoutMs);
        const traceEntry: BrowserActionTrace = {
          stepId: `${request.taskId}:relay-download:${index + 1}`,
          kind: "download",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            urlPattern: action.urlPattern ?? null,
            timeoutMs: action.timeoutMs ?? null,
          },
          output: {
            timeoutMs,
            armed: true,
          },
        };
        trace.push(traceEntry);
        const armed = await this.armDownloadAction(activeTab.id, action, debuggerTabsToDetach, traceEntry, timeoutMs);
        pendingDownloadHandlers.push(armed.pending);
        continue;
      }

      if (action.kind === "permission") {
        const startedAt = Date.now();
        const currentUrl = contentScriptState.latestResponse?.page?.finalUrl ?? activeTab.url ?? "";
        const output = await this.executePermissionAction(activeTab.id, action, currentUrl, debuggerTabsToDetach);
        trace.push({
          stepId: `${request.taskId}:relay-permission:${index + 1}`,
          kind: "permission",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            action: action.action,
            permissions: "permissions" in action ? action.permissions : [],
            origin: "origin" in action ? action.origin ?? null : null,
          },
          output,
        });
        continue;
      }

      if (action.kind === "cookie") {
        const startedAt = Date.now();
        const currentUrl = contentScriptState.latestResponse?.page?.finalUrl ?? activeTab.url ?? "";
        const output = await this.executeCookieAction(activeTab.id, action, currentUrl, debuggerTabsToDetach);
        trace.push({
          stepId: `${request.taskId}:relay-cookie:${index + 1}`,
          kind: "cookie",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            action: action.action,
            name: "name" in action ? action.name : null,
            valueBytes: "value" in action ? byteLength(action.value) : null,
            url: "url" in action ? action.url ?? null : null,
            domain: "domain" in action ? action.domain ?? null : null,
            path: "path" in action ? action.path ?? null : null,
          },
          output,
        });
        continue;
      }

      if (action.kind === "eval") {
        const startedAt = Date.now();
        const output = await this.executeEvalAction(activeTab.id, action, debuggerTabsToDetach);
        trace.push({
          stepId: `${request.taskId}:relay-eval:${index + 1}`,
          kind: "eval",
          startedAt,
          completedAt: Date.now(),
          status: "ok",
          input: {
            expressionBytes: byteLength(action.expression),
            awaitPromise: action.awaitPromise ?? true,
            timeoutMs: action.timeoutMs ?? null,
          },
          output,
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
      return this.buildFailedContentScriptResult(
        activeTab,
        trace,
        screenshotPayloads,
        downloadPayloads,
        contentScriptResponse
      );
    }
    await consumePendingPopup();
    downloadPayloads.push(...(await Promise.all(pendingDownloadHandlers)));
    await Promise.all([...pendingDialogHandlers, ...pendingNetworkHandlers]);

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
        downloadPayloads,
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
      downloadPayloads,
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
      action.kind === "probe" ||
      action.kind === "wait" ||
      action.kind === "waitFor" ||
      action.kind === "storage" ||
      action.kind === "upload"
    );
  }

  private async executePermissionAction(
    tabId: number,
    action: RelayPermissionAction,
    currentUrl: string,
    debuggerTabsToDetach: Set<number>
  ): Promise<Record<string, unknown>> {
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay permission action requires chrome debugger support");
    }
    debuggerTabsToDetach.add(tabId);

    if (action.action === "reset") {
      await this.platform.sendDebuggerCommand(tabId, "Browser.resetPermissions", {});
      return {
        action: action.action,
        resetAll: true,
      };
    }

    const permissions = [...new Set(action.permissions)];
    const origin = resolvePermissionOrigin("origin" in action ? action.origin : undefined, currentUrl);
    const setting = action.action === "grant" ? "granted" : "denied";
    for (const permission of permissions) {
      await this.platform.sendDebuggerCommand(tabId, "Browser.setPermission", {
        permission: toCdpPermissionDescriptor(permission),
        setting,
        origin,
      });
    }

    return {
      action: action.action,
      permissions,
      origin,
      setting,
    };
  }

  private async executeCookieAction(
    tabId: number,
    action: RelayCookieAction,
    currentUrl: string,
    debuggerTabsToDetach: Set<number>
  ): Promise<Record<string, unknown>> {
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay cookie action requires chrome debugger support");
    }
    debuggerTabsToDetach.add(tabId);
    const actionUrl = "url" in action ? action.url : undefined;
    const resolvedUrl = resolveCookieUrl(actionUrl, currentUrl);
    await this.platform.sendDebuggerCommand(tabId, "Network.enable", {});

    if (action.action === "get") {
      const cookies = await readCdpCookiesFromDebugger(this.platform, tabId, resolvedUrl);
      const filteredCookies = action.name ? cookies.filter((cookie) => cookie.name === action.name) : cookies;
      return {
        action: action.action,
        name: action.name ?? null,
        url: resolvedUrl ?? null,
        ...summarizeCdpCookies(filteredCookies),
      };
    }

    if (action.action === "set") {
      if (!resolvedUrl && !action.domain) {
        throw new Error("relay cookie set requires an http(s) target URL or explicit domain");
      }
      const result = await this.platform.sendDebuggerCommand(tabId, "Network.setCookie", {
        name: action.name,
        value: action.value,
        ...(resolvedUrl ? { url: resolvedUrl } : {}),
        ...(action.domain ? { domain: action.domain } : {}),
        ...(action.path ? { path: action.path } : {}),
        ...(action.secure !== undefined ? { secure: action.secure } : {}),
        ...(action.httpOnly !== undefined ? { httpOnly: action.httpOnly } : {}),
        ...(action.sameSite ? { sameSite: action.sameSite } : {}),
        ...(action.expires !== undefined ? { expires: action.expires } : {}),
      });
      if (isCdpSetCookieFailure(result)) {
        throw new Error(`relay cookie set failed: ${action.name}`);
      }
      return {
        action: action.action,
        name: action.name,
        valueBytes: byteLength(action.value),
        url: resolvedUrl ?? null,
        domain: action.domain ?? null,
        path: action.path ?? null,
        set: true,
      };
    }

    if (action.action === "remove") {
      const params = buildCdpDeleteCookieParams(action.name, resolvedUrl, action.domain, action.path);
      await this.platform.sendDebuggerCommand(tabId, "Network.deleteCookies", params);
      return {
        action: action.action,
        name: action.name,
        url: resolvedUrl ?? null,
        domain: action.domain ?? null,
        path: action.path ?? null,
        removed: true,
      };
    }

    const cookies = filterCdpCookiesByScope(
      await readCdpCookiesFromDebugger(this.platform, tabId, resolvedUrl),
      action.domain,
      action.path
    );
    const boundedCookies = cookies.slice(0, MAX_BROWSER_COOKIE_READ_ENTRIES);
    for (const cookie of boundedCookies) {
      if (!cookie.name) {
        continue;
      }
      await this.platform.sendDebuggerCommand(
        tabId,
        "Network.deleteCookies",
        buildCdpDeleteCookieParams(cookie.name, resolvedUrl, cookie.domain, cookie.path)
      );
    }
    return {
      action: action.action,
      url: resolvedUrl ?? null,
      domain: action.domain ?? null,
      path: action.path ?? null,
      clearedCount: boundedCookies.length,
      cookieCount: cookies.length,
      cookiesTruncated: cookies.length > MAX_BROWSER_COOKIE_READ_ENTRIES,
    };
  }

  private async executeEvalAction(
    tabId: number,
    action: RelayEvalAction,
    debuggerTabsToDetach: Set<number>
  ): Promise<Record<string, unknown>> {
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay eval action requires chrome debugger support");
    }
    debuggerTabsToDetach.add(tabId);
    const timeoutMs = normalizeEvalTimeoutMs(action.timeoutMs);
    const response = await withTimeout(
      this.platform.sendDebuggerCommand(tabId, "Runtime.evaluate", {
        expression: action.expression,
        returnByValue: true,
        awaitPromise: action.awaitPromise ?? true,
      }),
      timeoutMs,
      `relay eval action timed out after ${timeoutMs}ms`
    );
    return summarizeEvalResponse(response, timeoutMs);
  }

  private async executeNetworkControlAction(
    tabId: number,
    action: Extract<
      RelayNetworkAction,
      { action: "blockUrls" | "clearBlockedUrls" | "setExtraHeaders" | "clearExtraHeaders" | "clearMockResponses" }
    >,
    debuggerTabsToDetach: Set<number>
  ): Promise<Record<string, unknown>> {
    if (!this.platform.sendDebuggerCommand) {
      throw new Error("relay network control action requires chrome debugger support");
    }
    debuggerTabsToDetach.add(tabId);
    if (action.action === "clearMockResponses") {
      await this.platform.sendDebuggerCommand(tabId, "Fetch.disable", {});
      return {
        action: action.action,
        cleared: true,
      };
    }
    await this.platform.sendDebuggerCommand(tabId, "Network.enable", {});
    if (action.action === "blockUrls" || action.action === "clearBlockedUrls") {
      const urls = action.action === "blockUrls" ? action.urlPatterns : [];
      await this.platform.sendDebuggerCommand(tabId, "Network.setBlockedURLs", { urls });
      return action.action === "blockUrls"
        ? {
            action: action.action,
            urlPatternCount: action.urlPatterns.length,
            blocked: true,
          }
        : {
            action: action.action,
            cleared: true,
          };
    }
    const headers = action.action === "setExtraHeaders" ? action.headers : {};
    await this.platform.sendDebuggerCommand(tabId, "Network.setExtraHTTPHeaders", { headers });
    return action.action === "setExtraHeaders"
      ? {
          action: action.action,
          headerCount: Object.keys(action.headers).length,
          set: true,
        }
      : {
          action: action.action,
          cleared: true,
        };
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

  private async armDialogAction(
    tabId: number,
    action: RelayDialogAction,
    debuggerTabsToDetach: Set<number>,
    traceEntry: BrowserActionTrace,
    timeoutMs: number
  ): Promise<{ pending: Promise<void> }> {
    const sendDebuggerCommand = this.platform.sendDebuggerCommand;
    const waitForDebuggerEvent = this.platform.waitForDebuggerEvent;
    if (!sendDebuggerCommand || !waitForDebuggerEvent) {
      throw new Error("relay dialog action requires chrome debugger event support");
    }
    debuggerTabsToDetach.add(tabId);
    await sendDebuggerCommand(tabId, "Page.enable", {});
    const pending = (async () => {
      try {
        const event = await waitForDebuggerEvent(tabId, "Page.javascriptDialogOpening", timeoutMs);
        await sendDebuggerCommand(tabId, "Page.handleJavaScriptDialog", {
          accept: action.action === "accept",
          ...(action.action === "accept" && action.promptText !== undefined ? { promptText: action.promptText } : {}),
        });
        traceEntry.completedAt = Date.now();
        traceEntry.output = {
          action: action.action,
          timeoutMs,
          type: typeof event.params?.type === "string" ? event.params.type : null,
          message: typeof event.params?.message === "string" ? event.params.message : null,
          ...(action.promptText !== undefined ? { promptTextLength: action.promptText.length } : {}),
        };
      } catch (error) {
        traceEntry.completedAt = Date.now();
        traceEntry.status = "failed";
        traceEntry.errorMessage = error instanceof Error ? error.message : "relay dialog action failed";
        throw error;
      }
    })();
    pending.catch(() => undefined);
    return { pending };
  }

  private async armNetworkAction(
    tabId: number,
    action: RelayNetworkAction,
    debuggerTabsToDetach: Set<number>,
    traceEntry: BrowserActionTrace,
    timeoutMs: number
  ): Promise<{ pending: Promise<void> }> {
    const sendDebuggerCommand = this.platform.sendDebuggerCommand;
    const waitForDebuggerEvent = this.platform.waitForDebuggerEvent;
    if (!sendDebuggerCommand || !waitForDebuggerEvent) {
      throw new Error("relay network action requires chrome debugger event support");
    }
    debuggerTabsToDetach.add(tabId);
    if (action.action === "mockResponse") {
      await sendDebuggerCommand(tabId, "Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      const pending = this.armNetworkMockResponse(tabId, action, traceEntry, timeoutMs, sendDebuggerCommand, waitForDebuggerEvent);
      pending.catch(() => undefined);
      return { pending };
    }
    await sendDebuggerCommand(tabId, "Network.enable", {});
    const requestMethods = new Map<string, string>();
    const pending = (async () => {
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() <= deadline) {
          const remainingMs = Math.max(1, deadline - Date.now());
          if (action.action === "waitForRequest") {
            const event = await waitForDebuggerEvent(tabId, "Network.requestWillBeSent", remainingMs);
            if (!matchesCdpNetworkRequest(event, action)) {
              continue;
            }
            traceEntry.completedAt = Date.now();
            traceEntry.output = summarizeCdpNetworkRequest(event, action, timeoutMs);
            return;
          }

          if (action.action !== "waitForResponse") {
            throw new Error(`relay network action cannot be armed: ${action.action}`);
          }
          const event = await waitForDebuggerEvent(tabId, "Network.responseReceived", remainingMs);
          const requestEvents =
            (await this.platform.drainDebuggerEvents?.(tabId, {
              include: ["Network.requestWillBeSent"],
              maxEvents: 100,
            })) ?? [];
          for (const requestEvent of requestEvents) {
            const requestId = getCdpRequestId(requestEvent.params);
            const method = getCdpRequestMethod(requestEvent.params);
            if (requestId && method) {
              requestMethods.set(requestId, method);
            }
          }
          const requestId = getCdpRequestId(event.params);
          const method = requestId ? requestMethods.get(requestId) : undefined;
          if (!matchesCdpNetworkResponse(event, action, method)) {
            continue;
          }
          const bodySummary = action.maxBodyBytes
            ? await readCdpResponseBodySummary(sendDebuggerCommand, tabId, requestId, action.maxBodyBytes)
            : {};
          traceEntry.completedAt = Date.now();
          traceEntry.output = {
            ...summarizeCdpNetworkResponse(event, action, method, timeoutMs),
            ...bodySummary,
          };
          return;
        }
        throw new Error(`relay network action timed out after ${timeoutMs}ms`);
      } catch (error) {
        traceEntry.completedAt = Date.now();
        traceEntry.status = "failed";
        traceEntry.errorMessage = error instanceof Error ? error.message : "relay network action failed";
        throw error;
      }
    })();
    pending.catch(() => undefined);
    return { pending };
  }

  private async armNetworkMockResponse(
    tabId: number,
    action: Extract<RelayNetworkAction, { action: "mockResponse" }>,
    traceEntry: BrowserActionTrace,
    timeoutMs: number,
    sendDebuggerCommand: NonNullable<ChromeExtensionPlatform["sendDebuggerCommand"]>,
    waitForDebuggerEvent: NonNullable<ChromeExtensionPlatform["waitForDebuggerEvent"]>
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() <= deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const event = await waitForDebuggerEvent(tabId, "Fetch.requestPaused", remainingMs);
        const requestId = getCdpFetchRequestId(event.params);
        if (!requestId) {
          continue;
        }
        if (!matchesCdpFetchMockRequest(event, action)) {
          await sendDebuggerCommand(tabId, "Fetch.continueRequest", { requestId });
          continue;
        }
        const status = action.status ?? 200;
        await sendDebuggerCommand(tabId, "Fetch.fulfillRequest", {
          requestId,
          responseCode: status,
          responseHeaders: toCdpResponseHeaders(action.headers ?? {}),
          body: resolveCdpMockResponseBodyBase64(action),
        });
        traceEntry.completedAt = Date.now();
        traceEntry.output = {
          action: action.action,
          matched: true,
          timeoutMs,
          requestId,
          url: getCdpFetchRequestUrl(event.params) ?? null,
          method: getCdpFetchRequestMethod(event.params) ?? null,
          status,
          headerCount: Object.keys(action.headers ?? {}).length,
          bodyBytes: getCdpMockResponseBodyBytes(action),
        };
        return;
      }
      throw new Error(`relay network mock timed out after ${timeoutMs}ms`);
    } catch (error) {
      traceEntry.completedAt = Date.now();
      traceEntry.status = "failed";
      traceEntry.errorMessage = error instanceof Error ? error.message : "relay network mock failed";
      throw error;
    } finally {
      await sendDebuggerCommand(tabId, "Fetch.disable", {}).catch(() => undefined);
    }
  }

  private async armDownloadAction(
    tabId: number,
    action: RelayDownloadAction,
    debuggerTabsToDetach: Set<number>,
    traceEntry: BrowserActionTrace,
    timeoutMs: number
  ): Promise<{ pending: Promise<RelayDownloadPayload> }> {
    const sendDebuggerCommand = this.platform.sendDebuggerCommand;
    const waitForDebuggerEvent = this.platform.waitForDebuggerEvent;
    const fetchDownload = this.platform.fetchDownload;
    if (!sendDebuggerCommand || !waitForDebuggerEvent || !fetchDownload) {
      throw new Error("relay download action requires chrome debugger event and download fetch support");
    }
    debuggerTabsToDetach.add(tabId);
    await sendDebuggerCommand(tabId, "Page.enable", {});
    const pending = (async () => {
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() <= deadline) {
          const remainingMs = Math.max(1, deadline - Date.now());
          const event = await waitForDebuggerEvent(tabId, "Page.downloadWillBegin", remainingMs);
          const url = getCdpDownloadUrl(event.params);
          if (!url || (action.urlPattern && !matchesUrlPattern(url, action.urlPattern))) {
            continue;
          }
          if (!isHttpUrl(url)) {
            throw new Error("relay download action can only proxy http(s) download URLs");
          }
          const guid = getCdpDownloadGuid(event.params);
          const fileName = sanitizeDownloadFileName(getCdpDownloadSuggestedFilename(event.params) ?? "download.bin");
          if (guid) {
            await waitForCdpDownloadCompletion(tabId, guid, deadline, waitForDebuggerEvent);
          }
          const fetched = await fetchDownload(url, {
            maxBytes: MAX_BROWSER_DOWNLOAD_FILE_BYTES,
          });
          const payload: RelayDownloadPayload = {
            url,
            fileName,
            ...(fetched.mimeType ? { mimeType: fetched.mimeType } : {}),
            dataBase64: fetched.dataBase64,
            sizeBytes: fetched.sizeBytes,
          };
          traceEntry.completedAt = Date.now();
          traceEntry.output = {
            timeoutMs,
            matched: true,
            url,
            fileName,
            sizeBytes: fetched.sizeBytes,
            ...(fetched.mimeType ? { mimeType: fetched.mimeType } : {}),
          };
          return payload;
        }
        throw new Error(`relay download action timed out after ${timeoutMs}ms`);
      } catch (error) {
        traceEntry.completedAt = Date.now();
        traceEntry.status = "failed";
        traceEntry.errorMessage = error instanceof Error ? error.message : "relay download action failed";
        throw error;
      }
    })();
    pending.catch(() => undefined);
    return { pending };
  }

  private async armPopupAction(
    _action: RelayPopupAction,
    traceEntry: BrowserActionTrace,
    timeoutMs: number
  ): Promise<ChromeTabLike> {
    const knownTabs = await this.platform.queryTabs({});
    const knownTabIds = new Set(knownTabs.map((tab) => tab.id).filter((tabId): tabId is number => typeof tabId === "number"));
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const candidates = (await this.platform.queryTabs({}))
        .filter((tab) => typeof tab.id === "number" && !knownTabIds.has(tab.id))
        .sort((left, right) => (right.id ?? 0) - (left.id ?? 0));
      const created = candidates[0];
      if (created && typeof created.id === "number") {
        traceEntry.completedAt = Date.now();
        traceEntry.output = {
          timeoutMs,
          relayTargetId: formatRelayTargetId(created.id),
          finalUrl: created.url ?? "about:blank",
          title: created.title ?? "",
        };
        return created;
      }
      await delay(50);
    }
    const error = new Error(`relay popup action timed out after ${timeoutMs}ms`);
    traceEntry.completedAt = Date.now();
    traceEntry.status = "failed";
    traceEntry.errorMessage = error.message;
    throw error;
  }

  private buildFailedContentScriptResult(
    activeTab: ChromeTabLike | null | undefined,
    trace: BrowserActionTrace[],
    screenshotPayloads: RelayScreenshotPayload[],
    downloadPayloads: RelayDownloadPayload[],
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
      downloadPayloads,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function summarizeEvalResponse(response: unknown, timeoutMs: number): Record<string, unknown> {
  const responseRecord = isRecord(response) ? response : {};
  if (isRecord(responseRecord.exceptionDetails)) {
    return {
      exception: true,
      timeoutMs,
      text: typeof responseRecord.exceptionDetails.text === "string" ? responseRecord.exceptionDetails.text : null,
    };
  }

  const result = isRecord(responseRecord.result) ? responseRecord.result : {};
  const value = "value" in result ? result.value : result.description ?? null;
  const json = safeStringify(value);
  const resultBytes = byteLength(json);
  return {
    exception: false,
    timeoutMs,
    resultType: typeof result.type === "string" ? result.type : null,
    resultBytes,
    ...(resultBytes <= MAX_BROWSER_EVAL_RESULT_BYTES
      ? { result: parseSafeJson(json) }
      : { resultTruncated: true }),
  };
}

function normalizeEvalTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_EVAL_TIMEOUT_MS)
    : DEFAULT_BROWSER_EVAL_TIMEOUT_MS;
}

function normalizeNetworkTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_NETWORK_TIMEOUT_MS)
    : DEFAULT_BROWSER_NETWORK_TIMEOUT_MS;
}

function normalizeDownloadTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_BROWSER_DOWNLOAD_TIMEOUT_MS)
    : DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS;
}

async function waitForCdpDownloadCompletion(
  tabId: number,
  guid: string,
  deadline: number,
  waitForDebuggerEvent: NonNullable<ChromeExtensionPlatform["waitForDebuggerEvent"]>
): Promise<void> {
  while (Date.now() <= deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const event = await waitForDebuggerEvent(tabId, "Page.downloadProgress", remainingMs);
    if (getCdpDownloadGuid(event.params) !== guid) {
      continue;
    }
    const state = getCdpDownloadState(event.params);
    if (state === "completed") {
      return;
    }
    if (state === "canceled") {
      throw new Error("relay download action observed a canceled download");
    }
  }
  throw new Error("relay download action timed out waiting for completion");
}

function isArmedNetworkAction(
  action: RelayNetworkAction
): action is Extract<RelayNetworkAction, { action: "waitForRequest" | "waitForResponse" | "mockResponse" }> {
  return action.action === "waitForRequest" || action.action === "waitForResponse" || action.action === "mockResponse";
}

function matchesCdpNetworkRequest(
  event: ChromeDebuggerEventLike,
  action: Extract<RelayNetworkAction, { action: "waitForRequest" }>
): boolean {
  const url = getCdpRequestUrl(event.params);
  const method = getCdpRequestMethod(event.params);
  if (action.urlPattern && (!url || !matchesUrlPattern(url, action.urlPattern))) {
    return false;
  }
  if (action.method && method !== action.method) {
    return false;
  }
  return true;
}

function matchesCdpNetworkResponse(
  event: ChromeDebuggerEventLike,
  action: Extract<RelayNetworkAction, { action: "waitForResponse" }>,
  method: string | undefined
): boolean {
  const url = getCdpResponseUrl(event.params);
  const status = getCdpResponseStatus(event.params);
  if (action.urlPattern && (!url || !matchesUrlPattern(url, action.urlPattern))) {
    return false;
  }
  if (action.status !== undefined && status !== action.status) {
    return false;
  }
  if (action.method && method !== action.method) {
    return false;
  }
  return true;
}

function matchesCdpFetchMockRequest(
  event: ChromeDebuggerEventLike,
  action: Extract<RelayNetworkAction, { action: "mockResponse" }>
): boolean {
  const url = getCdpFetchRequestUrl(event.params);
  const method = getCdpFetchRequestMethod(event.params);
  if (!url || !matchesUrlPattern(url, action.urlPattern)) {
    return false;
  }
  if (action.method && method !== action.method) {
    return false;
  }
  return true;
}

function summarizeCdpNetworkRequest(
  event: ChromeDebuggerEventLike,
  action: Extract<RelayNetworkAction, { action: "waitForRequest" }>,
  timeoutMs: number
): Record<string, unknown> {
  const postData = action.maxBodyBytes ? getCdpRequestPostData(event.params) : null;
  const hasPostData = getCdpRequestHasPostData(event.params);
  return {
    action: action.action,
    matched: true,
    timeoutMs,
    requestId: getCdpRequestId(event.params) ?? null,
    url: getCdpRequestUrl(event.params) ?? null,
    method: getCdpRequestMethod(event.params) ?? null,
    resourceType: typeof event.params?.type === "string" ? event.params.type : null,
    ...(action.includeHeaders ? summarizeCdpNetworkHeaders(getCdpRequestHeaders(event.params)) : {}),
    ...(postData !== null
      ? summarizeTextNetworkBody(postData, action.maxBodyBytes ?? MAX_BROWSER_NETWORK_BODY_BYTES)
      : action.maxBodyBytes && hasPostData
        ? { bodyUnavailable: true }
        : {}),
  };
}

function summarizeCdpNetworkResponse(
  event: ChromeDebuggerEventLike,
  action: Extract<RelayNetworkAction, { action: "waitForResponse" }>,
  method: string | undefined,
  timeoutMs: number
): Record<string, unknown> {
  return {
    action: action.action,
    matched: true,
    timeoutMs,
    requestId: getCdpRequestId(event.params) ?? null,
    url: getCdpResponseUrl(event.params) ?? null,
    status: getCdpResponseStatus(event.params) ?? null,
    method: method ?? null,
    resourceType: typeof event.params?.type === "string" ? event.params.type : null,
    mimeType: getCdpResponseMimeType(event.params) ?? null,
    ...(action.includeHeaders ? summarizeCdpNetworkHeaders(getCdpResponseHeaders(event.params)) : {}),
  };
}

async function readCdpResponseBodySummary(
  sendDebuggerCommand: NonNullable<ChromeExtensionPlatform["sendDebuggerCommand"]>,
  tabId: number,
  requestId: string | null,
  maxBodyBytes: number
): Promise<Record<string, unknown>> {
  if (!requestId) {
    return { bodyUnavailable: true, bodyError: "missing requestId" };
  }
  try {
    const response = await sendDebuggerCommand(tabId, "Network.getResponseBody", { requestId });
    if (!isRecord(response) || typeof response.body !== "string") {
      return { bodyUnavailable: true, bodyError: "Network.getResponseBody returned no body" };
    }
    const base64Encoded = response.base64Encoded === true;
    return base64Encoded
      ? summarizeBase64NetworkBody(response.body, maxBodyBytes)
      : summarizeTextNetworkBody(response.body, maxBodyBytes);
  } catch (error) {
    return {
      bodyUnavailable: true,
      bodyError: error instanceof Error ? error.message : "response body unavailable",
    };
  }
}

function summarizeCdpNetworkHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(headers);
  const boundedEntries = entries.slice(0, MAX_BROWSER_NETWORK_HEADER_ENTRIES);
  return {
    headers: boundedEntries.map(([name, rawValue]) => ({
      name,
      ...summarizeNetworkHeaderValue(String(rawValue)),
    })),
    headerCount: entries.length,
    headersTruncated: entries.length > MAX_BROWSER_NETWORK_HEADER_ENTRIES,
  };
}

function summarizeNetworkHeaderValue(value: string): Record<string, unknown> {
  const valueBytes = byteLength(value);
  return {
    value: valueBytes <= MAX_BROWSER_NETWORK_HEADER_VALUE_BYTES ? value : truncateUtf8(value, MAX_BROWSER_NETWORK_HEADER_VALUE_BYTES),
    valueBytes,
    valueTruncated: valueBytes > MAX_BROWSER_NETWORK_HEADER_VALUE_BYTES,
  };
}

function summarizeTextNetworkBody(value: string, maxBodyBytes: number): Record<string, unknown> {
  const boundedBytes = Math.min(maxBodyBytes, MAX_BROWSER_NETWORK_BODY_BYTES);
  const bodyBytes = byteLength(value);
  return {
    bodyBytes,
    bodyPreview: bodyBytes <= boundedBytes ? value : truncateUtf8(value, boundedBytes),
    bodyTruncated: bodyBytes > boundedBytes,
  };
}

function summarizeBase64NetworkBody(value: string, maxBodyBytes: number): Record<string, unknown> {
  const boundedBytes = Math.min(maxBodyBytes, MAX_BROWSER_NETWORK_BODY_BYTES);
  const sanitized = value.replace(/\s+/g, "");
  const bodyBytes = estimateBase64DecodedBytes(sanitized);
  return {
    bodyBytes,
    bodyPreviewBase64: sanitized.slice(0, Math.ceil(boundedBytes / 3) * 4),
    bodyTruncated: bodyBytes > boundedBytes,
  };
}

function estimateBase64DecodedBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function resolveCdpMockResponseBodyBase64(action: Extract<RelayNetworkAction, { action: "mockResponse" }>): string {
  if (action.bodyBase64 !== undefined) {
    return action.bodyBase64;
  }
  return stringToBase64(action.body ?? "");
}

function getCdpMockResponseBodyBytes(action: Extract<RelayNetworkAction, { action: "mockResponse" }>): number {
  if (action.bodyBase64 !== undefined) {
    return estimateBase64DecodedBytes(action.bodyBase64);
  }
  return byteLength(action.body ?? "");
}

function stringToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function toCdpResponseHeaders(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function getCdpFetchRequestId(params: Record<string, unknown> | undefined): string | null {
  return typeof params?.requestId === "string" ? params.requestId : null;
}

function getCdpFetchRequestUrl(params: Record<string, unknown> | undefined): string | null {
  const request = isRecord(params?.request) ? params.request : null;
  return typeof request?.url === "string" ? request.url : null;
}

function getCdpFetchRequestMethod(params: Record<string, unknown> | undefined): string | null {
  const request = isRecord(params?.request) ? params.request : null;
  return typeof request?.method === "string" ? request.method : null;
}

function getCdpRequestId(params: Record<string, unknown> | undefined): string | null {
  return typeof params?.requestId === "string" ? params.requestId : null;
}

function getCdpRequestUrl(params: Record<string, unknown> | undefined): string | null {
  const request = isRecord(params?.request) ? params.request : null;
  return typeof request?.url === "string" ? request.url : null;
}

function getCdpRequestMethod(params: Record<string, unknown> | undefined): string | null {
  const request = isRecord(params?.request) ? params.request : null;
  return typeof request?.method === "string" ? request.method : null;
}

function getCdpRequestHeaders(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const request = isRecord(params?.request) ? params.request : null;
  return isRecord(request?.headers) ? request.headers : {};
}

function getCdpRequestPostData(params: Record<string, unknown> | undefined): string | null {
  const request = isRecord(params?.request) ? params.request : null;
  return typeof request?.postData === "string" ? request.postData : null;
}

function getCdpRequestHasPostData(params: Record<string, unknown> | undefined): boolean {
  const request = isRecord(params?.request) ? params.request : null;
  return request?.hasPostData === true;
}

function getCdpResponseUrl(params: Record<string, unknown> | undefined): string | null {
  const response = isRecord(params?.response) ? params.response : null;
  return typeof response?.url === "string" ? response.url : null;
}

function getCdpResponseHeaders(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const response = isRecord(params?.response) ? params.response : null;
  return isRecord(response?.headers) ? response.headers : {};
}

function getCdpResponseStatus(params: Record<string, unknown> | undefined): number | null {
  const response = isRecord(params?.response) ? params.response : null;
  return typeof response?.status === "number" ? response.status : null;
}

function getCdpResponseMimeType(params: Record<string, unknown> | undefined): string | null {
  const response = isRecord(params?.response) ? params.response : null;
  return typeof response?.mimeType === "string" ? response.mimeType : null;
}

function getCdpDownloadGuid(params: Record<string, unknown> | undefined): string | null {
  return typeof params?.guid === "string" ? params.guid : null;
}

function getCdpDownloadUrl(params: Record<string, unknown> | undefined): string | null {
  return typeof params?.url === "string" ? params.url : null;
}

function getCdpDownloadSuggestedFilename(params: Record<string, unknown> | undefined): string | null {
  return typeof params?.suggestedFilename === "string" ? params.suggestedFilename : null;
}

function getCdpDownloadState(params: Record<string, unknown> | undefined): string | null {
  return typeof params?.state === "string" ? params.state : null;
}

async function readCdpCookiesFromDebugger(
  platform: ChromeExtensionPlatform,
  tabId: number,
  url: string | undefined
): Promise<RelayCdpCookie[]> {
  const response = await platform.sendDebuggerCommand?.(tabId, "Network.getCookies", url ? { urls: [url] } : {});
  if (!isRecord(response) || !Array.isArray(response.cookies)) {
    return [];
  }
  return response.cookies.filter(isRecord).map((cookie) => cookie as RelayCdpCookie);
}

function summarizeCdpCookies(cookies: RelayCdpCookie[]): Record<string, unknown> {
  const boundedCookies = cookies.slice(0, MAX_BROWSER_COOKIE_READ_ENTRIES);
  return {
    cookies: boundedCookies.map((cookie) => ({
      name: cookie.name ?? "",
      domain: cookie.domain ?? "",
      path: cookie.path ?? "",
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      session: cookie.session ?? false,
      sameSite: cookie.sameSite ?? null,
      expires: typeof cookie.expires === "number" ? cookie.expires : null,
      ...summarizeCookieValue(cookie.value ?? ""),
    })),
    cookieCount: cookies.length,
    cookiesTruncated: cookies.length > MAX_BROWSER_COOKIE_READ_ENTRIES,
  };
}

function summarizeCookieValue(value: string): Record<string, unknown> {
  const valueBytes = byteLength(value);
  return {
    value: valueBytes <= MAX_BROWSER_COOKIE_READ_VALUE_BYTES ? value : value.slice(0, MAX_BROWSER_COOKIE_READ_VALUE_BYTES),
    valueBytes,
    valueTruncated: valueBytes > MAX_BROWSER_COOKIE_READ_VALUE_BYTES,
  };
}

function filterCdpCookiesByScope(
  cookies: RelayCdpCookie[],
  domain: string | undefined,
  path: string | undefined
): RelayCdpCookie[] {
  return cookies.filter((cookie) => {
    if (domain && cookie.domain !== domain) {
      return false;
    }
    if (path && cookie.path !== path) {
      return false;
    }
    return true;
  });
}

function buildCdpDeleteCookieParams(
  name: string,
  url: string | undefined,
  domain: string | undefined,
  path: string | undefined
): Record<string, unknown> {
  if (!url && !domain) {
    throw new Error("relay cookie remove requires an http(s) target URL or explicit domain");
  }
  return {
    name,
    ...(url ? { url } : {}),
    ...(domain ? { domain } : {}),
    ...(path ? { path } : {}),
  };
}

function resolveCookieUrl(actionUrl: string | undefined, currentUrl: string): string | undefined {
  const candidate = actionUrl ?? currentUrl;
  return isHttpUrl(candidate) ? candidate : undefined;
}

function resolvePermissionOrigin(actionOrigin: string | undefined, currentUrl: string): string {
  const candidate = actionOrigin ?? currentUrl;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http");
    }
    const origin = parsed.origin;
    if (origin.length > MAX_BROWSER_PERMISSION_ORIGIN_LENGTH) {
      throw new Error("too long");
    }
    return origin;
  } catch {
    throw new Error("relay permission action requires an explicit http(s) origin or current tab URL");
  }
}

function toCdpPermissionDescriptor(permission: BrowserPermissionName): Record<string, unknown> {
  if (permission === "clipboard-read") {
    return { name: "clipboardReadWrite", allowWithoutSanitization: true };
  }
  if (permission === "clipboard-write") {
    return { name: "clipboardSanitizedWrite" };
  }
  return { name: permission };
}

function isCdpSetCookieFailure(value: unknown): boolean {
  return isRecord(value) && value.success === false;
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

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  let output = "";
  let outputBytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (outputBytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    outputBytes += characterBytes;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function matchesUrlPattern(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return url.includes(pattern);
  }
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(url);
}

function sanitizeDownloadFileName(value: string): string {
  const fileName = value.trim().split(/[\\/]+/).pop()?.replace(/[^\w .-]+/g, "-") ?? "";
  return (fileName || "download.bin").slice(0, MAX_BROWSER_UPLOAD_FILE_NAME_LENGTH);
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
