import type { BrowserResumeMode } from "./team";

export interface DecodedBrowserSessionPayload {
  sessionId: string;
  targetId?: string;
  resumeMode?: BrowserResumeMode;
  source: "direct" | "browserRecovery";
}

export function decodeBrowserSessionPayload(payload: unknown): DecodedBrowserSessionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const browserRecovery = isRecord(record.browserRecovery) ? record.browserRecovery : null;
  const recoverySessionId = readString(browserRecovery?.sessionId);
  const directSessionId = readString(record.sessionId);
  const sessionId = recoverySessionId ?? directSessionId;
  if (!sessionId) {
    return null;
  }
  const targetId = readString(browserRecovery?.targetId) ?? readString(record.targetId);
  const resumeMode = readResumeMode(browserRecovery?.resumeMode) ?? readResumeMode(record.resumeMode);

  return {
    sessionId,
    ...(targetId ? { targetId } : {}),
    ...(resumeMode ? { resumeMode } : {}),
    source: recoverySessionId ? "browserRecovery" : "direct",
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readResumeMode(value: unknown): BrowserResumeMode | null {
  return value === "hot" || value === "warm" || value === "cold" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
