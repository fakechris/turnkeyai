import type {
  RelayActionRequest,
  RelayPeerRegistration,
  RelayTargetReport,
} from "@turnkeyai/browser-bridge/transport/relay-protocol";

import { ChromeRelayActionExecutor } from "./chrome-action-executor";
import { getChromeExtensionPlatform, type ChromeExtensionPlatform } from "./chrome-extension-types";
import { ChromeRelayTabObserver } from "./chrome-tab-observer";
import { DaemonRelayClient, type DaemonRelayClientOptions } from "./daemon-relay-client";
import {
  BrowserRelayPeerRuntime,
  type RelayPeerActionExecutor,
  type RelayPeerExecutionResult,
} from "./peer-runtime";
import { RelayPeerLoop, type RelayPeerLoopOptions } from "./peer-loop";

const RELAY_POLL_ALARM = "turnkeyai.relay.poll";
const RELAY_POLL_PERIOD_MINUTES = 1;
const CONTENT_SCRIPT_READY_MESSAGE = "turnkeyai.relay.content-script-ready";

export interface ChromeExtensionServiceWorkerHooks {
  listObservedTargets(): Promise<RelayTargetReport[]>;
  executeAction(request: RelayActionRequest): Promise<RelayPeerExecutionResult>;
}

export interface ChromeExtensionServiceWorkerOptions {
  client: DaemonRelayClientOptions;
  peer: RelayPeerRegistration;
  hooks: ChromeExtensionServiceWorkerHooks;
  pullWaitMs?: number;
}

export interface ChromeExtensionServiceWorkerLifecycleController {
  loop: RelayPeerLoop;
  wake(reason?: string): void;
}

export function createChromeExtensionServiceWorkerRuntime(
  options: ChromeExtensionServiceWorkerOptions
): BrowserRelayPeerRuntime {
  const client = new DaemonRelayClient(options.client);
  const actionExecutor: RelayPeerActionExecutor = {
    execute: (request) => options.hooks.executeAction(request),
  };
  return new BrowserRelayPeerRuntime({
    peer: options.peer,
    client,
    targetObserver: {
      listTargets: () => options.hooks.listObservedTargets(),
    },
    actionExecutor,
    ...(options.pullWaitMs !== undefined ? { pullWaitMs: options.pullWaitMs } : {}),
  });
}

export function createChromeExtensionServiceWorkerLoop(
  options: ChromeExtensionServiceWorkerOptions & {
    loop?: Omit<RelayPeerLoopOptions, "runtime">;
  }
): RelayPeerLoop {
  const runtime = createChromeExtensionServiceWorkerRuntime(options);
  return new RelayPeerLoop({
    runtime,
    ...(options.loop ?? {}),
  });
}

export function createChromeExtensionPlatformHooks(
  platform: ChromeExtensionPlatform = getChromeExtensionPlatform()
): ChromeExtensionServiceWorkerHooks {
  const tabObserver = new ChromeRelayTabObserver(platform);
  const actionExecutor = new ChromeRelayActionExecutor(platform);
  return {
    listObservedTargets: () => tabObserver.listObservedTargets(),
    executeAction: (request) => actionExecutor.execute(request),
  };
}

export function createChromeExtensionPlatformRuntime(
  options: Omit<ChromeExtensionServiceWorkerOptions, "hooks"> & {
    platform?: ChromeExtensionPlatform;
  }
): BrowserRelayPeerRuntime {
  return createChromeExtensionServiceWorkerRuntime({
    ...options,
    hooks: createChromeExtensionPlatformHooks(options.platform),
  });
}

export function createChromeExtensionPlatformLoop(
  options: Omit<ChromeExtensionServiceWorkerOptions, "hooks"> & {
    platform?: ChromeExtensionPlatform;
    loop?: Omit<RelayPeerLoopOptions, "runtime">;
  }
): RelayPeerLoop {
  return createChromeExtensionServiceWorkerLoop({
    ...options,
    hooks: createChromeExtensionPlatformHooks(options.platform),
  });
}

export function installChromeExtensionPlatformLifecycle(
  options: Omit<ChromeExtensionServiceWorkerOptions, "hooks"> & {
    platform?: ChromeExtensionPlatform;
    loop?: Omit<RelayPeerLoopOptions, "runtime">;
  }
): ChromeExtensionServiceWorkerLifecycleController {
  const platform = options.platform ?? getChromeExtensionPlatform();
  const loop = createChromeExtensionServiceWorkerLoop({
    client: options.client,
    peer: options.peer,
    ...(options.pullWaitMs !== undefined ? { pullWaitMs: options.pullWaitMs } : {}),
    ...(options.loop ? { loop: options.loop } : {}),
    hooks: createChromeExtensionPlatformHooks(platform),
  });

  const wake = (_reason?: string) => {
    loop.start();
    void loop.runOnce();
  };

  platform.runtime.onMessage.addListener((message) => {
    if (!isContentScriptReadyMessage(message)) {
      return undefined;
    }
    wake("content-script-ready");
    return undefined;
  });
  platform.runtime.onStartup?.addListener(() => wake("runtime-startup"));
  platform.runtime.onInstalled?.addListener(() => wake("runtime-installed"));
  platform.tabs.onCreated?.addListener(() => wake("tab-created"));
  platform.tabs.onUpdated?.addListener(() => wake("tab-updated"));
  platform.tabs.onRemoved?.addListener(() => wake("tab-removed"));
  platform.tabs.onActivated?.addListener(() => wake("tab-activated"));
  platform.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === RELAY_POLL_ALARM) {
      wake("relay-alarm");
    }
  });
  platform.alarms?.create(RELAY_POLL_ALARM, {
    periodInMinutes: RELAY_POLL_PERIOD_MINUTES,
  });

  return {
    loop,
    wake,
  };
}

function isContentScriptReadyMessage(message: unknown): boolean {
  return Boolean(
    message &&
      typeof message === "object" &&
      "type" in message &&
      (message as { type?: unknown }).type === CONTENT_SCRIPT_READY_MESSAGE
  );
}
