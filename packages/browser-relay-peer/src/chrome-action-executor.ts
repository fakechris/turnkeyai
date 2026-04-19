import type { BrowserActionTrace } from "@turnkeyai/core-types/team";
import type { RelayActionRequest } from "@turnkeyai/browser-bridge/transport/relay-protocol";

import type { ChromeExtensionPlatform } from "./chrome-extension-types";
import type { RelayContentScriptExecuteResponse } from "./chrome-content-script-protocol";
import { ChromeRelayTabObserver, formatRelayTargetId } from "./chrome-tab-observer";

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

    const trace: BrowserActionTrace[] = [];
    const pendingActions = [];
    const screenshotPayloads = [];

    for (let index = 0; index < request.actions.length; index += 1) {
      const action = request.actions[index]!;
      if (action.kind !== "open") {
        pendingActions.push(action);
        continue;
      }
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
    }

    if (!activeTab?.id) {
      throw new Error("relay action executor could not resolve a target tab");
    }

    const pageActions = this.normalizePageActions(
      request,
      pendingActions.filter((action) => action.kind !== "screenshot")
    );
    const screenshotActions = pendingActions.filter((action) => action.kind === "screenshot");

    const contentScriptResponse = pageActions.length
      ? await this.sendContentScriptActions(activeTab.id, request.actionRequestId, pageActions)
      : null;

    if (contentScriptResponse && !contentScriptResponse.ok) {
      return {
        relayTargetId: formatRelayTargetId(activeTab.id),
        url: activeTab.url ?? "",
        ...(activeTab.title ? { title: activeTab.title } : {}),
        status: "failed" as const,
        trace: [...trace, ...contentScriptResponse.trace],
        screenshotPaths: [],
        screenshotPayloads: [],
        artifactIds: [],
        errorMessage: contentScriptResponse.errorMessage ?? "content script execution failed",
      };
    }

    for (let index = 0; index < screenshotActions.length; index += 1) {
      const action = screenshotActions[index]!;
      const startedAt = Date.now();
      const activeTabId: number | undefined = activeTab.id;
      if (typeof activeTabId !== "number") {
        throw new Error("relay screenshot capture requires a target tab id");
      }
      const captureTimeoutMs = this.resolveScreenshotCaptureTimeoutMs(request);
      activeTab = await withTimeout(
        this.platform.updateTab(activeTabId, { active: true }),
        captureTimeoutMs,
        `relay screenshot tab activation timed out after ${captureTimeoutMs}ms`
      );
      const dataUrl = await withTimeout(
        this.platform.captureVisibleTab(activeTab.windowId, { format: "png" }),
        captureTimeoutMs,
        `relay screenshot capture timed out after ${captureTimeoutMs}ms`
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

    const finalTabId = activeTab.id;
    if (typeof finalTabId !== "number") {
      throw new Error("relay action executor lost the target tab id");
    }
    const finalSnapshotResponse =
      contentScriptResponse?.page
        ? contentScriptResponse
        : await this.sendContentScriptActions(finalTabId, request.actionRequestId, [{ kind: "snapshot", note: "final-relay-state" }]);

    return {
      relayTargetId: formatRelayTargetId(finalTabId),
      url: finalSnapshotResponse?.page?.finalUrl ?? activeTab.url ?? "",
      ...(finalSnapshotResponse?.page?.title || activeTab.title
        ? { title: finalSnapshotResponse?.page?.title ?? activeTab.title }
        : {}),
      status: "completed" as const,
      ...(finalSnapshotResponse?.page ? { page: finalSnapshotResponse.page } : {}),
      trace: [...trace, ...(finalSnapshotResponse?.trace ?? [])],
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

  private resolveScreenshotCaptureTimeoutMs(request: RelayActionRequest): number {
    const remainingRequestBudgetMs = request.expiresAt - Date.now() - this.requestCompletionBufferMs;
    if (Number.isFinite(remainingRequestBudgetMs) && remainingRequestBudgetMs > 0) {
      return Math.max(1, Math.min(this.maxScreenshotCaptureMs, Math.trunc(remainingRequestBudgetMs)));
    }
    return this.maxScreenshotCaptureMs;
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
      if (action.kind !== "wait") {
        return action;
      }
      const timeoutMs =
        typeof action.timeoutMs === "number" && Number.isFinite(action.timeoutMs) && action.timeoutMs >= 0
          ? Math.trunc(action.timeoutMs)
          : 0;
      if (timeoutMs > this.maxWaitActionMs) {
        throw new Error(
          `relay wait action exceeds maximum supported duration: ${timeoutMs}ms > ${this.maxWaitActionMs}ms`
        );
      }
      if (timeoutMs > remainingWaitBudgetMs) {
        throw new Error(
          `relay wait action exceeds remaining request budget: ${timeoutMs}ms > ${Math.max(
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
      }
    );
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

async function retryAsync<T>(
  task: () => Promise<T>,
  input: {
    attempts: number;
    delayMs: number;
    shouldRetry(error: unknown): boolean;
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
