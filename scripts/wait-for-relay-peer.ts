const args = process.argv.slice(2);
let daemonUrl = process.env.TURNKEYAI_DAEMON_URL ?? "http://127.0.0.1:4100";
let peerId: string | null = null;
let timeoutMs = 15_000;
let requireTarget = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--daemon-url") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --daemon-url");
    }
    daemonUrl = value;
    index += 1;
    continue;
  }
  if (arg === "--peer-id") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --peer-id");
    }
    peerId = value.trim();
    index += 1;
    continue;
  }
  if (arg === "--timeout-ms") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --timeout-ms");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("--timeout-ms must be a positive number");
    }
    timeoutMs = Math.trunc(parsed);
    index += 1;
    continue;
  }
  if (arg === "--require-target") {
    requireTarget = true;
  }
}

const deadline = Date.now() + timeoutMs;
let lastError: string | null = null;
while (Date.now() < deadline) {
  try {
    const peers = (await getJson(`${daemonUrl}/relay/peers`)) as Array<{
      peerId: string;
      status: "online" | "stale";
    }>;
    const matchedPeer = peerId ? peers.find((item) => item.peerId === peerId) : peers.find((item) => item.status === "online");

    if (matchedPeer) {
      if (!requireTarget) {
        console.log(`relay peer ready: ${matchedPeer.peerId}`);
        process.exit(0);
      }
      const targets = (await getJson(`${daemonUrl}/relay/targets?peerId=${encodeURIComponent(matchedPeer.peerId)}`)) as Array<{
        relayTargetId: string;
      }>;
      if (targets.length > 0) {
        console.log(`relay peer ready: ${matchedPeer.peerId}  targets=${targets.length}`);
        process.exit(0);
      }
    }
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error(
  [
    peerId
      ? `timed out waiting for relay peer: ${peerId}`
      : "timed out waiting for any online relay peer",
    lastError ? `last error: ${lastError}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" | ")
);

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error((json as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return json;
}
