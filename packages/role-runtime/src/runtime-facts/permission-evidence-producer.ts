import type { NativeToolRoundTrace } from "../native-tool-messages";
import type {
  EvidenceEnvelope,
  EvidenceProvenance,
  PermissionEvidenceFacts,
  PermissionStatus,
  RuntimeFactInput,
} from "./types";

export function producePermissionEvidenceEnvelope(
  input: Pick<RuntimeFactInput, "toolTrace">,
): EvidenceEnvelope<"permission_evidence", PermissionEvidenceFacts> {
  const latestToolName = readLegacyLatestPermissionToolName(input.toolTrace);
  const latestResultStatus = readLegacyLatestPermissionResultStatus(input.toolTrace);
  const appliedProgress = hasPermissionAppliedProgress(input.toolTrace);
  const waitTimeout =
    latestResultStatus === "approval_wait_timeout" ||
    latestResultStatus === "wait_timeout" ||
    latestResultStatus === "pending";
  const deniedApproval = latestResultStatus === "denied";
  const appliedApproval =
    latestResultStatus === "applied" ||
    latestToolName === "permission_applied" ||
    appliedProgress;
  const pendingApproval =
    waitTimeout ||
    latestToolName === "permission_query" ||
    latestPermissionQueryStatus(input.toolTrace) === "pending";
  const latestStatus: PermissionStatus =
    latestResultStatus === "approval_wait_timeout" ||
    latestResultStatus === "wait_timeout"
      ? "wait_timeout"
      : deniedApproval
        ? "denied"
        : appliedApproval
          ? "applied"
          : pendingApproval
            ? "pending"
            : "none";

  return {
    kind: "permission_evidence",
    schemaVersion: 1,
    facts: {
      latestStatus,
      latestToolName,
      latestResultStatus,
      pendingApproval,
      appliedApproval,
      deniedApproval,
      waitTimeout,
    },
    provenance: buildPermissionProvenance(input.toolTrace),
  };
}

function readLegacyLatestPermissionToolName(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let callIndex = round.calls.length - 1;
      callIndex >= 0;
      callIndex -= 1
    ) {
      const name = round.calls[callIndex]!.name;
      if (name.startsWith("permission_")) {
        return name;
      }
    }
    for (
      let progressIndex = (round.progress?.length ?? 0) - 1;
      progressIndex >= 0;
      progressIndex -= 1
    ) {
      const progress = round.progress![progressIndex]!;
      if (progress.toolName.startsWith("permission_")) {
        return progress.toolName;
      }
    }
    for (
      let resultIndex = round.results.length - 1;
      resultIndex >= 0;
      resultIndex -= 1
    ) {
      const name = round.results[resultIndex]!.toolName;
      if (name.startsWith("permission_")) {
        return name;
      }
    }
  }
  return null;
}

function readLegacyLatestPermissionResultStatus(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let progressIndex = (round.progress?.length ?? 0) - 1;
      progressIndex >= 0;
      progressIndex -= 1
    ) {
      const progress = round.progress![progressIndex]!;
      if (
        progress.toolName === "permission_result" &&
        progress.detail?.["eventType"] === "permission.result"
      ) {
        const status = progress.detail["status"];
        if (typeof status === "string") return normalizePermissionStatus(status);
      }
    }
    for (
      let resultIndex = round.results.length - 1;
      resultIndex >= 0;
      resultIndex -= 1
    ) {
      const result = round.results[resultIndex]!;
      if (result.toolName !== "permission_result") continue;
      const status = readPermissionStatus(result.content ?? "");
      if (status) return status;
    }
  }
  return null;
}

function latestPermissionQueryStatus(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let progressIndex = (round.progress?.length ?? 0) - 1;
      progressIndex >= 0;
      progressIndex -= 1
    ) {
      const progress = round.progress![progressIndex]!;
      if (
        progress.toolName === "permission_query" &&
        progress.detail?.["eventType"] === "permission.query"
      ) {
        const status = progress.detail["status"];
        if (typeof status === "string") return normalizePermissionStatus(status);
      }
    }
  }
  return null;
}

function hasPermissionAppliedProgress(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  return toolTrace.some((round) =>
    (round.progress ?? []).some(
      (progress) => progress.detail?.["eventType"] === "permission.applied",
    ),
  );
}

function readPermissionStatus(content: string): string | null {
  const parsed = parseJsonObject(content);
  const status = parsed?.["status"];
  if (typeof status === "string") {
    return normalizePermissionStatus(status);
  }
  const normalized = content.toLowerCase();
  if (/\bapproval_wait_timeout\b/.test(normalized)) {
    return "approval_wait_timeout";
  }
  if (/\bwait[-_ ]timeout\b/.test(normalized)) {
    return "wait_timeout";
  }
  if (/\bdenied\b/.test(normalized)) {
    return "denied";
  }
  if (/\bapplied\b/.test(normalized)) {
    return "applied";
  }
  if (/\bpending\b/.test(normalized)) {
    return "pending";
  }
  return null;
}

function normalizePermissionStatus(status: string): string {
  return status.trim().toLowerCase();
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildPermissionProvenance(
  toolTrace: NativeToolRoundTrace[],
): EvidenceProvenance[] {
  return toolTrace.flatMap((round, traceIndex) => [
    ...round.calls
      .filter((call) => call.name.startsWith("permission_"))
      .map((call) => ({
        source: "native_tool_trace" as const,
        toolName: call.name,
        toolCallId: call.id,
        roundIndex: round.round,
        traceIndex,
        messageIndex: null,
      })),
    ...(round.progress ?? [])
      .filter((progress) => progress.toolName.startsWith("permission_"))
      .map((progress) => ({
        source: "tool_progress" as const,
        toolName: progress.toolName,
        toolCallId: progress.toolCallId,
        roundIndex: round.round,
        traceIndex,
        messageIndex: null,
      })),
    ...round.results
      .filter((result) => result.toolName.startsWith("permission_"))
      .map((result) => ({
        source: "native_tool_trace" as const,
        toolName: result.toolName,
        toolCallId: result.toolCallId,
        roundIndex: round.round,
        traceIndex,
        messageIndex: null,
      })),
  ]);
}
