import type {
  BrowserBridge,
  BrowserTransportMode,
} from "@turnkeyai/core-types/team";
import type {
  RelayActionRequest,
  RelayActionResult,
  RelayPeerRecord,
  RelayPeerRegistration,
  RelayTargetRecord,
  RelayTargetReport,
} from "./relay-protocol";

export interface BrowserTransportAdapter extends BrowserBridge {
  readonly transportMode: BrowserTransportMode;
  readonly transportLabel: string;
}

export interface RelayControlPlane {
  registerPeer(input: RelayPeerRegistration): RelayPeerRecord;
  heartbeatPeer(peerId: string): RelayPeerRecord;
  reportTargets(peerId: string, targets: RelayTargetReport[]): RelayTargetRecord[];
  listPeers(): RelayPeerRecord[];
  listTargets(input?: { peerId?: string }): RelayTargetRecord[];
  pullNextActionRequest(peerId: string): RelayActionRequest | null;
  submitActionResult(input: RelayActionResult): RelayActionResult;
}

export interface RelayControlPlaneCapable {
  getRelayControlPlane(): RelayControlPlane;
}

export function maybeGetRelayControlPlane(adapter: BrowserTransportAdapter): RelayControlPlane | null {
  if (
    typeof adapter === "object" &&
    adapter !== null &&
    "getRelayControlPlane" in adapter &&
    typeof (adapter as RelayControlPlaneCapable).getRelayControlPlane === "function"
  ) {
    return (adapter as RelayControlPlaneCapable).getRelayControlPlane();
  }
  return null;
}

export interface BrowserTransportFactoryOptions {
  artifactRootDir: string;
  stateRootDir?: string;
  executablePath?: string;
  headless?: boolean;
}

export interface RelayTransportOptions {
  endpoint?: string;
  relayPeerId?: string;
}

export interface DirectCdpTransportOptions {
  endpoint?: string;
}

export interface BrowserBridgeFactoryOptions extends BrowserTransportFactoryOptions {
  transportMode?: BrowserTransportMode;
  relay?: RelayTransportOptions;
  directCdp?: DirectCdpTransportOptions;
}
