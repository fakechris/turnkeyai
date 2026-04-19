export interface ChromeRuntimeMessageSenderLike {
  tab?: {
    id?: number;
    url?: string;
    title?: string;
  };
  frameId?: number;
}

export interface ChromeMessageEventLike {
  addListener(
    listener: (
      message: unknown,
      sender: ChromeRuntimeMessageSenderLike,
      sendResponse: (response: unknown) => void
    ) => boolean | void
  ): void;
}

export interface ChromeVoidEventLike {
  addListener(listener: () => void): void;
}

export interface ChromeInstalledEventLike {
  addListener(listener: (details?: unknown) => void): void;
}

export interface ChromeTabLike {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
  status?: "complete" | "loading";
  active?: boolean;
  discarded?: boolean;
}

export interface ChromeTabCreatedEventLike {
  addListener(listener: (tab: ChromeTabLike) => void): void;
}

export interface ChromeTabUpdatedEventLike {
  addListener(listener: (tabId: number, changeInfo: Record<string, unknown>, tab: ChromeTabLike) => void): void;
}

export interface ChromeTabRemovedEventLike {
  addListener(listener: (tabId: number, removeInfo: Record<string, unknown>) => void): void;
}

export interface ChromeTabActivatedEventLike {
  addListener(listener: (activeInfo: { tabId: number; windowId: number }) => void): void;
}

export interface ChromeAlarmLike {
  name: string;
}

export interface ChromeAlarmEventLike {
  addListener(listener: (alarm: ChromeAlarmLike) => void): void;
}

export interface ChromeRuntimeLike {
  id?: string;
  onMessage: ChromeMessageEventLike;
  sendMessage?(message: unknown): Promise<unknown>;
  onStartup?: ChromeVoidEventLike;
  onInstalled?: ChromeInstalledEventLike;
  lastError?: { message?: string };
}

export interface ChromeTabsLike {
  onCreated?: ChromeTabCreatedEventLike;
  onUpdated?: ChromeTabUpdatedEventLike;
  onRemoved?: ChromeTabRemovedEventLike;
  onActivated?: ChromeTabActivatedEventLike;
}

export interface ChromeAlarmsLike {
  create(name: string, alarmInfo?: { delayInMinutes?: number; periodInMinutes?: number }): void;
  onAlarm: ChromeAlarmEventLike;
}

export interface ChromeScriptingLike {
  executeScript(
    injection: {
      target: {
        tabId: number;
        allFrames?: boolean;
      };
      files: string[];
    },
    callback: (results?: unknown[]) => void
  ): void;
}

export interface ChromeDebuggerTargetLike {
  tabId: number;
}

export interface ChromeDebuggerEventLike {
  method: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

export interface ChromeDebuggerEventSourceLike {
  tabId?: number;
}

export interface ChromeDebuggerEventListenerLike {
  addListener(
    listener: (
      source: ChromeDebuggerEventSourceLike,
      method: string,
      params?: Record<string, unknown>
    ) => void
  ): void;
  removeListener?(
    listener: (
      source: ChromeDebuggerEventSourceLike,
      method: string,
      params?: Record<string, unknown>
    ) => void
  ): void;
}

export interface ChromeDebuggerLike {
  attach(target: ChromeDebuggerTargetLike, requiredVersion: string, callback: () => void): void;
  sendCommand(
    target: ChromeDebuggerTargetLike,
    method: string,
    commandParams: Record<string, unknown>,
    callback: (result?: unknown) => void
  ): void;
  detach(target: ChromeDebuggerTargetLike, callback: () => void): void;
  onEvent?: ChromeDebuggerEventListenerLike;
}

export interface ChromeExtensionPlatform {
  runtime: ChromeRuntimeLike;
  tabs: ChromeTabsLike;
  alarms?: ChromeAlarmsLike;
  queryTabs(query: {
    active?: boolean;
    currentWindow?: boolean;
  }): Promise<ChromeTabLike[]>;
  getTab(tabId: number): Promise<ChromeTabLike | null>;
  updateTab(tabId: number, updateProperties: {
    url?: string;
    active?: boolean;
  }): Promise<ChromeTabLike>;
  createTab(createProperties: {
    url: string;
    active?: boolean;
  }): Promise<ChromeTabLike>;
  sendTabMessage<T>(tabId: number, message: unknown): Promise<T>;
  injectContentScript?(tabId: number): Promise<void>;
  sendDebuggerCommand?(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
  waitForDebuggerEvent?(tabId: number, method: string, timeoutMs: number): Promise<ChromeDebuggerEventLike>;
  drainDebuggerEvents?(tabId: number, input?: { include?: string[]; maxEvents?: number }): Promise<ChromeDebuggerEventLike[]>;
  detachDebugger?(tabId: number): Promise<void>;
  captureVisibleTab(windowId?: number, options?: { format?: "png" | "jpeg" }): Promise<string>;
}

export function getChromeRuntime(): ChromeRuntimeLike {
  const chromeLike = (globalThis as Record<string, unknown>).chrome as {
    runtime?: {
      id?: string;
      onMessage?: ChromeMessageEventLike;
      sendMessage?(message: unknown, callback: (response: unknown) => void): void;
      onStartup?: ChromeVoidEventLike;
      onInstalled?: ChromeInstalledEventLike;
      lastError?: { message?: string };
    };
  } | undefined;

  if (!chromeLike?.runtime?.onMessage) {
    throw new Error("chrome runtime APIs are not available in this runtime");
  }

  const withRuntimeCallback = <T>(work: (callback: (value: T) => void) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      work((value) => {
        const runtimeError = chromeLike.runtime?.lastError;
        if (runtimeError?.message) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(value);
      });
    });

  return {
    ...(chromeLike.runtime.id ? { id: chromeLike.runtime.id } : {}),
    onMessage: chromeLike.runtime.onMessage,
    ...(typeof chromeLike.runtime.sendMessage === "function"
      ? {
          sendMessage: (message: unknown) =>
            withRuntimeCallback((callback) => chromeLike.runtime!.sendMessage!(message, callback)),
        }
      : {}),
    ...(chromeLike.runtime.onStartup ? { onStartup: chromeLike.runtime.onStartup } : {}),
    ...(chromeLike.runtime.onInstalled ? { onInstalled: chromeLike.runtime.onInstalled } : {}),
    ...(chromeLike.runtime.lastError ? { lastError: chromeLike.runtime.lastError } : {}),
  };
}

export function getChromeExtensionPlatform(): ChromeExtensionPlatform {
  const chromeLike = (globalThis as Record<string, unknown>).chrome as {
    runtime?: {
      id?: string;
      onMessage?: ChromeMessageEventLike;
      sendMessage?(message: unknown, callback: (response: unknown) => void): void;
      onStartup?: ChromeVoidEventLike;
      onInstalled?: ChromeInstalledEventLike;
      lastError?: { message?: string };
    };
    tabs?: {
      query(query: { active?: boolean; currentWindow?: boolean }, callback: (tabs: ChromeTabLike[]) => void): void;
      get(tabId: number, callback: (tab?: ChromeTabLike) => void): void;
      update(
        tabId: number,
        updateProperties: { url?: string; active?: boolean },
        callback: (tab?: ChromeTabLike) => void
      ): void;
      create(createProperties: { url: string; active?: boolean }, callback: (tab?: ChromeTabLike) => void): void;
      sendMessage(tabId: number, message: unknown, callback: (response: unknown) => void): void;
      captureVisibleTab(
        windowId: number | undefined,
        options: { format?: "png" | "jpeg" } | undefined,
        callback: (dataUrl?: string) => void
      ): void;
      onCreated?: ChromeTabCreatedEventLike;
      onUpdated?: ChromeTabUpdatedEventLike;
      onRemoved?: ChromeTabRemovedEventLike;
      onActivated?: ChromeTabActivatedEventLike;
    };
    alarms?: {
      create(name: string, alarmInfo?: { delayInMinutes?: number; periodInMinutes?: number }): void;
      onAlarm?: ChromeAlarmEventLike;
    };
    scripting?: ChromeScriptingLike;
    debugger?: ChromeDebuggerLike;
  } | undefined;

  if (!chromeLike?.tabs) {
    throw new Error("chrome extension APIs are not available in this runtime");
  }

  const debuggerAttachedTabs = new Set<number>();
  const debuggerAttachPromises = new Map<number, Promise<void>>();
  const debuggerEventBuffers = new Map<number, ChromeDebuggerEventLike[]>();
  const debuggerEventWaiters = new Map<
    number,
    Set<{
      method: string;
      resolve(event: ChromeDebuggerEventLike): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }>
  >();
  const maxBufferedDebuggerEventsPerTab = 100;

  const ensureDebuggerAttached = async (tabId: number): Promise<void> => {
    if (!chromeLike.debugger || debuggerAttachedTabs.has(tabId)) {
      return;
    }
    const existingAttach = debuggerAttachPromises.get(tabId);
    if (existingAttach) {
      await existingAttach;
      return;
    }
    const attach = withChromeRuntimeCallback<void>((callback) =>
      chromeLike.debugger!.attach({ tabId }, "1.3", callback)
    )
      .then(() => {
        debuggerAttachedTabs.add(tabId);
      })
      .finally(() => {
        debuggerAttachPromises.delete(tabId);
      });
    debuggerAttachPromises.set(tabId, attach);
    await attach;
  };

  const detachDebugger = async (tabId: number): Promise<void> => {
    if (!chromeLike.debugger || !debuggerAttachedTabs.has(tabId)) {
      return;
    }
    await withChromeRuntimeCallback<void>((callback) =>
      chromeLike.debugger!.detach({ tabId }, callback)
    ).catch(() => undefined);
    debuggerAttachedTabs.delete(tabId);
    const waiters = debuggerEventWaiters.get(tabId);
    if (!waiters) {
      return;
    }
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`chrome debugger detached before event arrived: ${waiter.method}`));
    }
    debuggerEventWaiters.delete(tabId);
  };

  chromeLike.debugger?.onEvent?.addListener((source, method, params) => {
    if (typeof source.tabId !== "number") {
      return;
    }
    const event: ChromeDebuggerEventLike = {
      method,
      ...(params ? { params } : {}),
      timestamp: Date.now(),
    };
    const buffer = debuggerEventBuffers.get(source.tabId) ?? [];
    buffer.push(event);
    if (buffer.length > maxBufferedDebuggerEventsPerTab) {
      buffer.splice(0, buffer.length - maxBufferedDebuggerEventsPerTab);
    }
    debuggerEventBuffers.set(source.tabId, buffer);

    const waiters = debuggerEventWaiters.get(source.tabId);
    if (!waiters) {
      return;
    }
    for (const waiter of [...waiters]) {
      if (waiter.method !== method) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve(event);
    }
    if (!waiters.size) {
      debuggerEventWaiters.delete(source.tabId);
    }
  });

  const platform: ChromeExtensionPlatform = {
    runtime: getChromeRuntime(),
    tabs: {
      ...(chromeLike.tabs.onCreated ? { onCreated: chromeLike.tabs.onCreated } : {}),
      ...(chromeLike.tabs.onUpdated ? { onUpdated: chromeLike.tabs.onUpdated } : {}),
      ...(chromeLike.tabs.onRemoved ? { onRemoved: chromeLike.tabs.onRemoved } : {}),
      ...(chromeLike.tabs.onActivated ? { onActivated: chromeLike.tabs.onActivated } : {}),
    },
    ...(chromeLike.alarms?.onAlarm
      ? {
          alarms: {
            create: chromeLike.alarms.create.bind(chromeLike.alarms),
            onAlarm: chromeLike.alarms.onAlarm,
          },
        }
      : {}),
    queryTabs(query) {
      return new Promise<ChromeTabLike[]>((resolve, reject) => {
        chromeLike.tabs!.query(query, (tabs) => {
          const runtimeError = chromeLike.runtime?.lastError;
          if (runtimeError?.message) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(tabs);
        });
      });
    },
    async getTab(tabId) {
      return new Promise<ChromeTabLike | null>((resolve, reject) => {
        chromeLike.tabs!.get(tabId, (tab) => {
          const runtimeError = chromeLike.runtime?.lastError;
          if (runtimeError?.message) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(tab ?? null);
        });
      });
    },
    updateTab(tabId, updateProperties) {
      return new Promise<ChromeTabLike>((resolve, reject) => {
        chromeLike.tabs!.update(tabId, updateProperties, (tab) => {
          const runtimeError = chromeLike.runtime?.lastError;
          if (runtimeError?.message) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(tab ?? { id: tabId });
        });
      });
    },
    createTab(createProperties) {
      return new Promise<ChromeTabLike>((resolve, reject) => {
        chromeLike.tabs!.create(createProperties, (tab) => {
          const runtimeError = chromeLike.runtime?.lastError;
          if (runtimeError?.message) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(tab ?? { url: createProperties.url });
        });
      });
    },
    sendTabMessage<T>(tabId: number, message: unknown): Promise<T> {
      return new Promise<unknown>((resolve, reject) => {
        chromeLike.tabs!.sendMessage(tabId, message, (response) => {
          const runtimeError = chromeLike.runtime?.lastError;
          if (runtimeError?.message) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response);
        });
      }).then((response) => response as T);
    },
    ...(chromeLike.scripting
      ? {
          injectContentScript(tabId: number): Promise<void> {
            return new Promise<void>((resolve, reject) => {
              chromeLike.scripting!.executeScript(
                {
                  target: {
                    tabId,
                    allFrames: true,
                  },
                  files: ["content-script.js"],
                },
                () => {
                  const runtimeError = chromeLike.runtime?.lastError;
                  if (runtimeError?.message) {
                    reject(new Error(runtimeError.message));
                    return;
                  }
                  resolve();
                }
              );
            });
          },
        }
      : {}),
    ...(chromeLike.debugger
      ? {
          async sendDebuggerCommand(
            tabId: number,
            method: string,
            params: Record<string, unknown> = {}
          ): Promise<unknown> {
            await ensureDebuggerAttached(tabId);
            return await withChromeRuntimeCallback<unknown>((callback) =>
              chromeLike.debugger!.sendCommand({ tabId }, method, params, callback)
            );
          },
          async waitForDebuggerEvent(tabId: number, method: string, timeoutMs: number): Promise<ChromeDebuggerEventLike> {
            if (!chromeLike.debugger!.onEvent) {
              throw new Error("chrome debugger event stream is not available");
            }
            await ensureDebuggerAttached(tabId);
            return await new Promise<ChromeDebuggerEventLike>((resolve, reject) => {
              const timeout = setTimeout(() => {
                const waiters = debuggerEventWaiters.get(tabId);
                if (waiters) {
                  for (const waiter of [...waiters]) {
                    if (waiter.method === method && waiter.reject === reject) {
                      waiters.delete(waiter);
                    }
                  }
                  if (!waiters.size) {
                    debuggerEventWaiters.delete(tabId);
                  }
                }
                reject(new Error(`chrome debugger event timed out after ${timeoutMs}ms: ${method}`));
              }, timeoutMs);
              const waiter = { method, resolve, reject, timeout };
              const waiters = debuggerEventWaiters.get(tabId) ?? new Set<typeof waiter>();
              waiters.add(waiter);
              debuggerEventWaiters.set(tabId, waiters);
            });
          },
          async drainDebuggerEvents(tabId: number, input: { include?: string[]; maxEvents?: number } = {}) {
            const events = debuggerEventBuffers.get(tabId) ?? [];
            debuggerEventBuffers.set(tabId, []);
            const include = input.include?.length ? new Set(input.include) : null;
            const filtered = include ? events.filter((event) => include.has(event.method)) : events;
            return filtered.slice(-(input.maxEvents ?? filtered.length));
          },
          detachDebugger,
        }
      : {}),
    captureVisibleTab(windowId, options) {
      return new Promise<string>((resolve, reject) => {
        chromeLike.tabs!.captureVisibleTab(windowId, options, (dataUrl) => {
          const runtimeError = chromeLike.runtime?.lastError;
          if (runtimeError?.message) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(dataUrl ?? "");
        });
      });
    },
  };

  return platform;
}

function withChromeRuntimeCallback<T>(
  work: (callback: (value: T) => void) => void
): Promise<T> {
  const chromeLike = (globalThis as Record<string, unknown>).chrome as {
    runtime?: {
      lastError?: { message?: string };
    };
  } | undefined;

  return new Promise<T>((resolve, reject) => {
    work((value) => {
      const runtimeError = chromeLike?.runtime?.lastError;
      if (runtimeError?.message) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(value);
    });
  });
}
