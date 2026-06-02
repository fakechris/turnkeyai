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
  const directSessionId = readString(record.sessionId);
  const recoverySessionId = readString(browserRecovery?.sessionId);
  const sessionId = directSessionId ?? recoverySessionId;
  if (!sessionId) {
    return null;
  }
  const targetId = readString(record.targetId) ?? readString(browserRecovery?.targetId);
  const resumeMode = readResumeMode(record.resumeMode) ?? readResumeMode(browserRecovery?.resumeMode);

  return {
    sessionId,
    ...(targetId ? { targetId } : {}),
    ...(resumeMode ? { resumeMode } : {}),
    source: directSessionId ? "direct" : "browserRecovery",
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
