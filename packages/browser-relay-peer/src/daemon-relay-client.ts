import type {
  RelayActionRequest,
  RelayActionRequestRecord,
  RelayActionResult,
  RelayPeerRecord,
  RelayPeerRegistration,
  RelayTargetRecord,
  RelayTargetReport,
} from "@turnkeyai/browser-bridge/transport/relay-protocol";

export interface DaemonRelayClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class DaemonRelayClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DaemonRelayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token?.trim() || null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async registerPeer(input: RelayPeerRegistration): Promise<RelayPeerRecord> {
    return this.postJson("/relay/peers/register", input);
  }

  async heartbeatPeer(peerId: string): Promise<RelayPeerRecord> {
    return this.postJson(`/relay/peers/${encodeURIComponent(peerId)}/heartbeat`, {});
  }

  async reportTargets(peerId: string, targets: RelayTargetReport[]): Promise<RelayTargetRecord[]> {
    return this.postJson(`/relay/peers/${encodeURIComponent(peerId)}/targets/report`, { targets });
  }

  async pullNextAction(peerId: string, options: { waitMs?: number } = {}): Promise<RelayActionRequest | null> {
    return this.postJson(`/relay/peers/${encodeURIComponent(peerId)}/pull-actions`, {
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    });
  }

  async submitActionResult(peerId: string, result: Omit<RelayActionResult, "peerId">): Promise<RelayActionResult> {
    return this.postJson(`/relay/peers/${encodeURIComponent(peerId)}/action-results`, result);
  }

  async listActionRequests(): Promise<RelayActionRequestRecord[]> {
    return this.getJson("/relay/actions");
  }

  async listPeers(): Promise<RelayPeerRecord[]> {
    return this.getJson("/relay/peers");
  }

  async listTargets(peerId?: string): Promise<RelayTargetRecord[]> {
    const suffix = peerId?.trim() ? `?peerId=${encodeURIComponent(peerId.trim())}` : "";
    return this.getJson(`/relay/targets${suffix}`);
  }

  private async getJson<T>(pathname: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: "GET",
      headers: this.buildHeaders(),
    });
    return this.readJsonResponse<T>(response);
  }

  private async postJson<T>(pathname: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    return this.readJsonResponse<T>(response);
  }

  private buildHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.token ? { "x-turnkeyai-token": this.token } : {}),
    };
  }

  private async readJsonResponse<T>(response: Response): Promise<T> {
    const raw = await response.text();
    const payload = raw.trim().length ? (JSON.parse(raw) as unknown) : null;
    if (!response.ok) {
      const errorMessage =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `${response.status} ${response.statusText}`;
      throw new Error(`daemon relay request failed: ${errorMessage}`);
    }
    return payload as T;
  }
}
