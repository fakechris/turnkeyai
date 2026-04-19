import { loadChromeRelayExtensionRuntimeConfig } from "./chrome-extension-config";
import { installChromeExtensionPlatformLifecycle } from "./chrome-extension-service-worker";

void bootstrapChromeRelayExtensionServiceWorker();

async function bootstrapChromeRelayExtensionServiceWorker(): Promise<void> {
  const config = await loadChromeRelayExtensionRuntimeConfig();
  const controller = installChromeExtensionPlatformLifecycle({
    client: {
      baseUrl: config.daemonBaseUrl,
      ...(config.daemonToken ? { token: config.daemonToken } : {}),
    },
    peer: {
      peerId: config.peerId,
      label: config.peerLabel,
      capabilities: config.capabilities,
      transportLabel: config.transportLabel,
    },
    pullWaitMs: config.pullWaitMs,
    loop: {
      activeDelayMs: config.activeDelayMs,
      idleDelayMs: config.idleDelayMs,
      errorDelayMs: config.errorDelayMs,
      onError: (error) => {
        console.error("[turnkeyai:relay-extension] peer loop error", error);
      },
    },
  });

  controller.wake("bootstrap");
}
