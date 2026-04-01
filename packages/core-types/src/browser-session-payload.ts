import type { BrowserResumeMode } from "./team";

export interface DecodedBrowserSessionPayload {
  sessionId: string;
  targetId?: string;
  resumeMode?: BrowserResumeMode;
}

export function decodeBrowserSessionPayload(payload: unknown): DecodedBrowserSessionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    return null;
  }

  return {
    sessionId: record.sessionId,
    ...(typeof record.targetId === "string" && record.targetId.length > 0
      ? { targetId: record.targetId }
      : {}),
    ...(record.resumeMode === "hot" || record.resumeMode === "warm" || record.resumeMode === "cold"
      ? { resumeMode: record.resumeMode }
      : {}),
  };
}
