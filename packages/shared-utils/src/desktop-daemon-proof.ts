import { createHmac, timingSafeEqual } from "node:crypto";

const DESKTOP_DAEMON_PROOF_CONTEXT = "turnkeyai-desktop-daemon-v1";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type DesktopDaemonProofScope = "read" | "operator" | "admin" | "unknown";

export function isDesktopDaemonChallenge(challenge: string): boolean {
  return SHA256_HEX_PATTERN.test(challenge);
}

export function isDesktopDaemonProofScope(scope: string): scope is DesktopDaemonProofScope {
  return scope === "read" || scope === "operator" || scope === "admin" || scope === "unknown";
}

export function createDesktopDaemonProof(
  token: string,
  challenge: string,
  scope: DesktopDaemonProofScope,
  port: number
): string {
  if (
    !token ||
    !isDesktopDaemonChallenge(challenge) ||
    !isDesktopDaemonProofScope(scope) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Desktop daemon proof requires a token, challenge, scope, and valid port");
  }
  return createHmac("sha256", token)
    .update(`${DESKTOP_DAEMON_PROOF_CONTEXT}:${challenge}:${scope}:${port}`, "utf8")
    .digest("hex");
}

export function verifyDesktopDaemonProof(
  token: string,
  challenge: string,
  scope: DesktopDaemonProofScope,
  port: number,
  proof: unknown
): boolean {
  if (typeof proof !== "string" || !SHA256_HEX_PATTERN.test(proof)) return false;
  try {
    const expected = Buffer.from(
      createDesktopDaemonProof(token, challenge, scope, port),
      "hex"
    );
    return timingSafeEqual(expected, Buffer.from(proof, "hex"));
  } catch {
    return false;
  }
}
