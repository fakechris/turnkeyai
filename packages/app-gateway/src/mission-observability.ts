import type { ActivityEvent, Mission } from "@turnkeyai/core-types/mission";
import type { RuntimeProgressEvent } from "@turnkeyai/core-types/team";

export interface MissionObservabilitySnapshot {
  missionId: string;
  status: Mission["status"];
  generatedAtMs: number;
  wallClockMs: number;
  timelineEventCount: number;
  tool: {
    requested: number;
    results: number;
    executed: number;
    skipped: number;
    failed: number;
    cancelled: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
  };
  browser: {
    profileFallbacks: number;
    latestProfileFallback?: {
      sessionId?: string;
      fallbackDir?: string;
    };
    failureBuckets: Array<{
      bucket: string;
      count: number;
      latestAtMs: number;
    }>;
  };
  approvals: {
    requested: number;
    applied: number;
    decided: number;
  };
  recovery: {
    events: number;
  };
  liveness: {
    active: number;
    waiting: number;
    stale: number;
    lastProgressAtMs?: number;
    staleSubjects: Array<{
      subjectKind: RuntimeProgressEvent["subjectKind"];
      subjectId: string;
      summary: string;
      overdueMs: number;
    }>;
  };
  qualityGate: {
    status: "running" | "passed" | "needs_attention" | "blocked";
    finalAnswerEventId?: string;
    evidenceEvents: number;
    checks: Array<{
      name: string;
      status: "pass" | "warn" | "fail" | "pending";
      detail: string;
    }>;
  };
}

export function buildMissionObservabilitySnapshot(input: {
  mission: Mission;
  events: ActivityEvent[];
  progressEvents?: RuntimeProgressEvent[];
  nowMs: number;
}): MissionObservabilitySnapshot {
  const events = [...input.events].sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id));
  const firstMs = events[0]?.tMs ?? input.mission.createdAtMs;
  const terminal = input.mission.status === "done" || input.mission.status === "blocked";
  const lastMs = terminal ? (events.at(-1)?.tMs ?? input.nowMs) : input.nowMs;
  const toolCalls = events.filter((event) => event.kind === "tool" && event.runtime?.toolPhase === "call");
  const toolResults = events.filter((event) => event.kind === "tool" && event.runtime?.toolPhase === "result");
  const toolFailures = toolResults.filter((event) => event.emph === "danger" && event.runtime?.admission !== "skipped");
  const outcomeEvents = events.filter(
    (event) => event.kind === "recovery" || (event.kind === "tool" && event.runtime?.toolPhase === "result")
  );
  const cancelled = outcomeEvents.filter((event) => /\bcancel(?:led|ed)?\b/i.test(eventTextBlob(event)));
  const timeouts = outcomeEvents.filter((event) => /\btime(?:d)?\s*out|timeout\b/i.test(eventTextBlob(event)));
  const sessionSpawnCalls = distinctRuntimeValues(
    toolCalls.filter((event) => event.runtime?.toolName === "sessions_spawn"),
    "toolCallId"
  );
  const sessionSendCalls = distinctRuntimeValues(
    toolCalls.filter((event) => event.runtime?.toolName === "sessions_send"),
    "toolCallId"
  );
  const approvalEvents = events.filter((event) => event.kind === "approval");
  const finalAnswer = latestFinalAnswer(input.mission, events);
  const evidenceEvents = countEvidenceEvents(events);
  const sourceLabels = collectEvidenceSourceLabels(events);
  const browserProfileFallbacks = collectBrowserProfileFallbacks(events);
  const browserFailureBuckets = collectBrowserFailureBuckets(events);
  const recoveryEvents = events.filter((event) => event.kind === "recovery");
  const liveness = summarizeRuntimeLiveness(input.progressEvents ?? [], input.nowMs, {
    ...(terminal && finalAnswer ? { terminalLivenessCutoffMs: finalAnswer.tMs + 1_000 } : {}),
  });
  const checks = buildQualityChecks({
    mission: input.mission,
    finalAnswer,
    toolRequests: toolCalls.length,
    evidenceEvents,
    sourceLabels,
    browserProfileFallbacks,
    browserFailureBuckets,
    failureEvents: recoveryEvents.length + toolFailures.length,
    staleRuntimeSubjects: liveness.stale,
  });

  return {
    missionId: input.mission.id,
    status: input.mission.status,
    generatedAtMs: input.nowMs,
    wallClockMs: Math.max(0, Math.round(lastMs - firstMs)),
    timelineEventCount: events.length,
    tool: {
      requested: toolCalls.length,
      results: toolResults.length,
      executed: toolResults.filter((event) => event.runtime?.admission !== "skipped").length,
      skipped: toolResults.filter((event) => event.runtime?.admission === "skipped").length,
      failed: toolFailures.length,
      cancelled: cancelled.length,
      timeouts: timeouts.length,
    },
    sessions: {
      spawned: sessionSpawnCalls.size,
      continued: sessionSendCalls.size,
    },
    browser: {
      profileFallbacks: browserProfileFallbacks.length,
      failureBuckets: browserFailureBuckets,
      ...(browserProfileFallbacks[0]
        ? {
            latestProfileFallback: {
              ...(browserProfileFallbacks[0].sessionId ? { sessionId: browserProfileFallbacks[0].sessionId } : {}),
              ...(browserProfileFallbacks[0].fallbackDir ? { fallbackDir: browserProfileFallbacks[0].fallbackDir } : {}),
            },
          }
        : {}),
    },
    approvals: {
      requested: approvalEvents.filter((event) => /requested approval|permission\.query/i.test(eventTextBlob(event))).length,
      applied: approvalEvents.filter((event) => /applied approval|permission\.applied/i.test(eventTextBlob(event))).length,
      decided: approvalEvents.filter(isApprovalDecisionEvent).length,
    },
    recovery: {
      events: recoveryEvents.length,
    },
    liveness,
    qualityGate: {
      status: deriveQualityStatus(input.mission, checks),
      ...(finalAnswer ? { finalAnswerEventId: finalAnswer.id } : {}),
      evidenceEvents,
      checks,
    },
  };
}

function buildQualityChecks(input: {
  mission: Mission;
  finalAnswer: ActivityEvent | null;
  toolRequests: number;
  evidenceEvents: number;
  sourceLabels: string[];
  browserProfileFallbacks: BrowserProfileFallbackObservation[];
  browserFailureBuckets: BrowserFailureBucketObservation[];
  failureEvents: number;
  staleRuntimeSubjects: number;
}): MissionObservabilitySnapshot["qualityGate"]["checks"] {
  const terminal = input.mission.status === "done" || input.mission.status === "blocked";
  const finalText = input.finalAnswer?.text ?? "";
  return [
    {
      name: "final_answer",
      status: input.finalAnswer ? "pass" : terminal ? "fail" : "pending",
      detail: input.finalAnswer ? "Lead final answer is present." : "No lead final answer has been mirrored yet.",
    },
    {
      name: "evidence_backed",
      status: input.evidenceEvents > 0 ? "pass" : terminal ? "fail" : "pending",
      detail:
        input.evidenceEvents > 0
          ? `${input.evidenceEvents} evidence-bearing event(s) are attached to the mission.`
          : "No tool/browser/doc/artifact evidence event is visible yet.",
    },
    {
      name: "source_coverage",
      status: !input.finalAnswer
        ? "pending"
        : input.sourceLabels.length < 2
          ? "pass"
          : finalAnswerCoversSources(finalText, input.sourceLabels)
            ? "pass"
            : "warn",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : input.sourceLabels.length < 2
          ? "No multi-source coverage requirement was visible in mission evidence."
          : finalAnswerCoversSources(finalText, input.sourceLabels)
            ? `Final answer covers ${input.sourceLabels.length}/${input.sourceLabels.length} visible source label(s).`
            : `Final answer does not cover every visible source label: ${missingCoveredSources(finalText, input.sourceLabels).join(", ")}.`,
    },
    {
      name: "residual_risk",
      status: !input.finalAnswer ? "pending" : mentionsResidualRisk(finalText) ? "pass" : "warn",
      detail: input.finalAnswer
        ? mentionsResidualRisk(finalText)
          ? "Final answer names residual risk or unverified scope."
          : "Final answer does not explicitly name residual risk."
        : "Waiting for the final answer.",
    },
    {
      name: "answer_substance",
      status: !input.finalAnswer
        ? "pending"
        : input.toolRequests > 0 && substantiveLength(finalText) < 220
          ? "warn"
          : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : input.toolRequests > 0 && substantiveLength(finalText) < 220
          ? "Final answer is too brief for tool-backed work."
          : "Final answer has enough substance for the observed work.",
    },
    {
      name: "evidence_usage",
      status: !input.finalAnswer
        ? "pending"
        : input.toolRequests > 0 && input.evidenceEvents > 0 && !mentionsEvidenceUse(finalText)
          ? "warn"
          : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : input.toolRequests > 0 && input.evidenceEvents > 0 && !mentionsEvidenceUse(finalText)
          ? "Final answer does not explicitly connect its claims to gathered evidence."
          : "Final answer connects claims to available evidence or did not require tool evidence.",
    },
    {
      name: "unsupported_uncertainty",
      status: !input.finalAnswer ? "pending" : mentionsUnsupportedUncertainty(finalText) ? "warn" : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : mentionsUnsupportedUncertainty(finalText)
          ? "Final answer contains unresolved placeholder or unsupported uncertainty language."
          : "Final answer does not contain unresolved placeholder language.",
    },
    {
      name: "tool_fallback_answer",
      status: !input.finalAnswer ? "pending" : mentionsToolFallbackAnswer(finalText) ? "warn" : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : mentionsToolFallbackAnswer(finalText)
          ? "Final answer says a required tool or search path was unavailable and falls back to model knowledge."
          : "Final answer does not claim a tool/search fallback.",
    },
    toolLoopCloseoutCheck(input.finalAnswer),
    {
      name: "browser_profile_fallback",
      status: input.browserProfileFallbacks.length > 0 ? "warn" : "pass",
      detail:
        input.browserProfileFallbacks.length > 0
          ? browserProfileFallbackDetail(input.browserProfileFallbacks)
          : "Browser work did not report a persistent-profile fallback.",
    },
    {
      name: "browser_failure_bucket",
      status: input.browserFailureBuckets.length > 0 ? "warn" : "pass",
      detail:
        input.browserFailureBuckets.length > 0
          ? browserFailureBucketDetail(input.browserFailureBuckets)
          : "Browser work did not report CDP, target, attach, detach, or transport failure buckets.",
    },
    {
      name: "runtime_liveness",
      status: input.staleRuntimeSubjects === 0 ? "pass" : "fail",
      detail:
        input.staleRuntimeSubjects === 0
          ? "No active role or worker span has exceeded its response timeout."
          : `${input.staleRuntimeSubjects} active role/worker span(s) exceeded their response timeout.`,
    },
    {
      name: "failure_free",
      status: input.failureEvents === 0 ? "pass" : "fail",
      detail:
        input.failureEvents === 0
          ? "No recovery or failed tool-result event is present."
          : `${input.failureEvents} recovery/failed tool event(s) require attention.`,
    },
  ];
}

function toolLoopCloseoutCheck(
  finalAnswer: ActivityEvent | null
): MissionObservabilitySnapshot["qualityGate"]["checks"][number] {
  if (!finalAnswer) {
    return {
      name: "tool_loop_closeout",
      status: "pending",
      detail: "Waiting for the final answer.",
    };
  }
  const reason = finalAnswer.runtime?.toolLoopCloseoutReason;
  if (!reason) {
    return {
      name: "tool_loop_closeout",
      status: "pass",
      detail: "Final answer did not require a forced tool-loop closeout.",
    };
  }
  if (reason === "completed_sub_agent_final") {
    return {
      name: "tool_loop_closeout",
      status: "pass",
      detail: toolLoopCloseoutDetail(finalAnswer, "Final answer synthesized from completed sub-agent final content."),
    };
  }
  return {
    name: "tool_loop_closeout",
    status: "warn",
    detail: toolLoopCloseoutDetail(finalAnswer, toolLoopCloseoutReasonLabel(reason)),
  };
}

function toolLoopCloseoutDetail(finalAnswer: ActivityEvent, label: string): string {
  const rounds = finalAnswer.runtime?.["toolLoopCloseout.roundCount"];
  const calls = finalAnswer.runtime?.["toolLoopCloseout.toolCallCount"];
  const pending = finalAnswer.runtime?.["toolLoopCloseout.pendingToolCallCount"];
  const toolName = finalAnswer.runtime?.["toolLoopCloseout.toolName"];
  const evidence = finalAnswer.runtime?.["toolLoopCloseout.evidenceAvailable"];
  const details = [
    rounds ? `${rounds} completed round(s)` : null,
    calls ? `${calls} executed tool call(s)` : null,
    pending ? `${pending} pending tool call(s)` : null,
    toolName ? `tool ${toolName}` : null,
    evidence ? `evidence available: ${evidence}` : null,
  ].filter(Boolean);
  return details.length > 0 ? `${label} ${details.join("; ")}.` : label;
}

function toolLoopCloseoutReasonLabel(reason: string): string {
  switch (reason) {
    case "round_limit":
      return "Final answer was forced after the tool-round limit.";
    case "wall_clock_budget":
      return "Final answer was forced after the tool wall-clock budget.";
    case "sub_agent_timeout":
      return "Final answer was forced after a sub-agent timeout.";
    case "pseudo_tool_call":
      return "Final answer was forced after the model emitted non-native tool-call markup.";
    case "repeated_tool_failure":
      return "Final answer was forced after repeated failed attempts with the same tool arguments.";
    default:
      return `Final answer was forced by tool-loop closeout '${reason}'.`;
  }
}

function summarizeRuntimeLiveness(
  progressEvents: RuntimeProgressEvent[],
  nowMs: number,
  options: { terminalLivenessCutoffMs?: number } = {}
): MissionObservabilitySnapshot["liveness"] {
  const bySubjectTask = new Map<string, RuntimeProgressEvent[]>();
  for (const event of progressEvents) {
    const taskKey = event.taskId ? `task:${event.taskId}` : `progress:${event.progressId}`;
    const key = `${event.subjectKind}:${event.subjectId}:${taskKey}`;
    const eventsForTask = bySubjectTask.get(key);
    if (eventsForTask) {
      eventsForTask.push(event);
    } else {
      bySubjectTask.set(key, [event]);
    }
  }

  const latestBySubject = new Map<string, RuntimeProgressEvent>();
  for (const eventsForTask of bySubjectTask.values()) {
    const candidate = summarizeTaskProgress(eventsForTask);
    const subjectKey = `${candidate.subjectKind}:${candidate.subjectId}`;
    const current = latestBySubject.get(subjectKey);
    if (!current || compareProgress(candidate, current) > 0) {
      latestBySubject.set(subjectKey, candidate);
    }
  }

  let active = 0;
  let waiting = 0;
  let lastProgressAtMs: number | undefined;
  const staleSubjects: MissionObservabilitySnapshot["liveness"]["staleSubjects"] = [];
  for (const event of latestBySubject.values()) {
    if (
      options.terminalLivenessCutoffMs !== undefined &&
      !isTerminalProgress(event) &&
      event.recordedAt <= options.terminalLivenessCutoffMs
    ) {
      continue;
    }
    lastProgressAtMs = Math.max(lastProgressAtMs ?? event.recordedAt, event.recordedAt);
    if (isTerminalProgress(event)) {
      continue;
    }
    if (event.continuityState === "waiting" || event.phase === "waiting") {
      waiting += 1;
    } else {
      active += 1;
    }
    if (event.responseTimeoutAt && nowMs > event.responseTimeoutAt) {
      staleSubjects.push({
        subjectKind: event.subjectKind,
        subjectId: event.subjectId,
        summary: event.summary,
        overdueMs: Math.max(0, nowMs - event.responseTimeoutAt),
      });
    }
  }

  return {
    active,
    waiting,
    stale: staleSubjects.length,
    ...(lastProgressAtMs !== undefined ? { lastProgressAtMs } : {}),
    staleSubjects,
  };
}

function summarizeTaskProgress(events: RuntimeProgressEvent[]): RuntimeProgressEvent {
  const terminalEvents = events.filter(isTerminalProgress);
  const candidates = terminalEvents.length > 0 ? terminalEvents : events;
  return candidates.reduce((latest, event) => (compareProgress(event, latest) > 0 ? event : latest));
}

function compareProgress(left: RuntimeProgressEvent, right: RuntimeProgressEvent): number {
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt - right.recordedAt;
  }
  return left.progressId.localeCompare(right.progressId);
}

function isTerminalProgress(event: RuntimeProgressEvent): boolean {
  if (event.closeKind) {
    return true;
  }
  if (event.continuityState === "terminal" || event.continuityState === "resolved") {
    return true;
  }
  return event.phase === "completed" || event.phase === "failed" || event.phase === "cancelled";
}

function deriveQualityStatus(
  mission: Mission,
  checks: MissionObservabilitySnapshot["qualityGate"]["checks"]
): MissionObservabilitySnapshot["qualityGate"]["status"] {
  if (mission.status === "blocked" || checks.some((check) => check.status === "fail")) {
    return "blocked";
  }
  if (mission.status !== "done") {
    return "running";
  }
  if (checks.some((check) => check.status === "warn" || check.status === "pending")) {
    return "needs_attention";
  }
  return "passed";
}

function latestFinalAnswer(mission: Mission, events: ActivityEvent[]): ActivityEvent | null {
  const staleBeforeIndex = Math.max(
    latestUserPlanIndex(events),
    latestToolActivityIndex(events)
  );
  let latest: ActivityEvent | null = null;
  for (const [index, event] of events.entries()) {
    if (event.kind !== "thought" || event.text.trim().length === 0) continue;
    if (index <= staleBeforeIndex) continue;
    if (
      event.runtime?.route === "lead-role" ||
      event.actor === "role-lead" ||
      mission.agents[0] === event.actor
    ) {
      latest = event;
    }
  }
  return latest;
}

function latestUserPlanIndex(events: ActivityEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.kind === "plan" &&
      (event.actor === "user" || event.runtime?.teamRole === "user")
    ) {
      return index;
    }
  }
  return -1;
}

function latestToolActivityIndex(events: ActivityEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === "tool") {
      return index;
    }
  }
  return -1;
}

function countEvidenceEvents(events: ActivityEvent[]): number {
  return events.filter((event) => {
    if (event.evidence?.length) return true;
    if (event.kind === "browser" || event.kind === "doc" || event.kind === "artifact") return true;
    if (event.kind !== "tool") return false;
    if (event.runtime?.toolPhase !== "result") return false;
    return event.runtime.admission !== "skipped";
  }).length;
}

function collectEvidenceSourceLabels(events: ActivityEvent[]): string[] {
  const labels = new Map<string, string>();
  for (const event of events) {
    for (const evidence of event.evidence ?? []) {
      addSourceLabel(labels, evidence.label);
    }
    addSourceLabel(labels, event.runtime?.sourceLabel);
    addSourceLabel(labels, event.runtime?.sourceName);
    addSourceLabel(labels, event.runtime?.sourceTitle);
  }
  return [...labels.values()];
}

function addSourceLabel(labels: Map<string, string>, value: string | undefined): void {
  const normalized = normalizeSourceLabel(value);
  if (!normalized) return;
  labels.set(normalized, value!.trim());
}

function finalAnswerCoversSources(text: string, sourceLabels: string[]): boolean {
  return missingCoveredSources(text, sourceLabels).length === 0;
}

function missingCoveredSources(text: string, sourceLabels: string[]): string[] {
  const normalizedText = normalizeSourceLabel(text);
  const textTokens = new Set(tokenizeSourceLabel(text));
  return sourceLabels.filter((label) => !sourceLabelCovered(normalizedText, textTokens, label));
}

function sourceLabelCovered(normalizedText: string, textTokens: Set<string>, label: string): boolean {
  const normalizedLabel = normalizeSourceLabel(label);
  if (!normalizedLabel) return true;
  if (normalizedText.includes(normalizedLabel)) return true;
  const sourceTokens = distinctiveSourceLabelTokens(label);
  if (sourceTokens.length === 0) return true;
  return sourceTokens.every((token) => textTokens.has(token));
}

const GENERIC_SOURCE_LABEL_TOKENS = new Set([
  "analysis",
  "brief",
  "browser",
  "capability",
  "check",
  "compare",
  "comparison",
  "dashboard",
  "decision",
  "evidence",
  "evaluate",
  "evaluation",
  "extract",
  "extraction",
  "fetch",
  "live",
  "local",
  "note",
  "research",
  "report",
  "review",
  "scan",
  "session",
  "source",
  "summary",
  "synthesize",
  "synthesis",
  "tool",
  "verification",
  "verify",
  "worker",
  "after",
  "before",
  "continue",
  "continuation",
  "follow",
  "followup",
  "post",
  "pre",
  "resume",
  "retry",
  "revisit",
]);

function distinctiveSourceLabelTokens(label: string): string[] {
  const tokens = tokenizeSourceLabel(label);
  return tokens.filter((token) => !GENERIC_SOURCE_LABEL_TOKENS.has(token));
}

function tokenizeSourceLabel(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

interface BrowserProfileFallbackObservation {
  sessionId?: string;
  fallbackDir?: string;
}

function collectBrowserProfileFallbacks(events: ActivityEvent[]): BrowserProfileFallbackObservation[] {
  const observations: BrowserProfileFallbackObservation[] = [];
  for (const event of events) {
    if (!/\bProfile fallback:\s*profile_locked\b/i.test(eventTextBlob(event))) {
      continue;
    }
    observations.push(parseBrowserProfileFallback(event));
  }
  return observations;
}

function parseBrowserProfileFallback(event: ActivityEvent): BrowserProfileFallbackObservation {
  const text = String(event.runtime?.resultContent ?? event.text ?? "");
  const sessionId = text.match(/\bcompleted session\s+([^\s.]+)/i)?.[1] ?? text.match(/\bsession\s+([^\s.]+)/i)?.[1];
  const fallbackLine = text
    .split(/\r?\n/)
    .find((line) => /\bProfile fallback:\s*profile_locked\b/i.test(line))
    ?.trim();
  const fallbackDir =
    fallbackLine?.match(/\bused\s+(.+?)\.?$/i)?.[1]?.trim().replace(/\.$/, "") ??
    fallbackLine?.match(/\bprofile_locked\s*\((.+?)\)\.?$/i)?.[1]?.trim();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(fallbackDir ? { fallbackDir } : {}),
  };
}

function browserProfileFallbackDetail(observations: BrowserProfileFallbackObservation[]): string {
  const latest = observations[0];
  const count = observations.length;
  const countText = `Browser used an isolated runtime profile ${count} time(s) because the persistent profile was locked.`;
  if (latest?.sessionId && latest.fallbackDir) {
    return `${countText} Latest session ${latest.sessionId}; fallback dir: ${latest.fallbackDir}.`;
  }
  if (latest?.sessionId) {
    return `${countText} Latest session ${latest.sessionId}.`;
  }
  if (latest?.fallbackDir) {
    return `${countText} Latest fallback dir: ${latest.fallbackDir}.`;
  }
  return countText;
}

interface BrowserFailureBucketObservation {
  bucket: string;
  count: number;
  latestAtMs: number;
}

const BROWSER_FAILURE_BUCKETS = new Set([
  "target_not_found",
  "attach_failed",
  "expert_session_detached",
  "cdp_command_timeout",
  "browser_cdp_unavailable",
  "detached_target",
  "session_not_found",
  "transport_failure",
  "owner_mismatch",
  "lease_conflict",
]);

function collectBrowserFailureBuckets(events: ActivityEvent[]): BrowserFailureBucketObservation[] {
  const byBucket = new Map<string, BrowserFailureBucketObservation>();
  for (const event of events) {
    const bucket = extractBrowserFailureBucket(event);
    if (!bucket) continue;
    const existing = byBucket.get(bucket);
    if (existing) {
      byBucket.set(bucket, {
        bucket,
        count: existing.count + 1,
        latestAtMs: Math.max(existing.latestAtMs, event.tMs),
      });
    } else {
      byBucket.set(bucket, { bucket, count: 1, latestAtMs: event.tMs });
    }
  }
  return [...byBucket.values()].sort((left, right) => right.latestAtMs - left.latestAtMs || left.bucket.localeCompare(right.bucket));
}

function extractBrowserFailureBucket(event: ActivityEvent): string | null {
  const candidates = [
    event.runtime?.bucket,
    event.runtime?.browserDiagnosticBucket,
    event.runtime?.closeKind,
    event.runtime?.failureBucket,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBrowserFailureBucket(typeof candidate === "string" ? candidate : "");
    if (normalized) return normalized;
  }

  const text = eventTextBlob(event);
  const directBucket = text.match(
    /\b(target_not_found|attach_failed|expert_session_detached|cdp_command_timeout|browser_cdp_unavailable|detached_target|session_not_found|transport_failure|owner_mismatch|lease_conflict)\b/i
  )?.[1];
  const normalizedDirect = normalizeBrowserFailureBucket(directBucket ?? "");
  if (normalizedDirect) return normalizedDirect;
  if (/\b(?:target detached|detached target|browser session detached)\b/i.test(text)) return "detached_target";
  if (/\b(?:session not found|browser session not found)\b/i.test(text)) return "session_not_found";
  if (/\b(?:cdp|transport|websocket|connection refused|ECONNREFUSED|fetch failed)\b/i.test(text)) return "transport_failure";
  return null;
}

function normalizeBrowserFailureBucket(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[.\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "browser_session_detached" || normalized === "browser_session_detached_target") return "detached_target";
  if (normalized === "browser_session_not_found") return "session_not_found";
  if (normalized === "transport_failed" || normalized === "browser_transport_failure") return "transport_failure";
  return BROWSER_FAILURE_BUCKETS.has(normalized) ? normalized : null;
}

function browserFailureBucketDetail(observations: BrowserFailureBucketObservation[]): string {
  const summary = observations.map((item) => `${item.bucket}=${item.count}`).join(", ");
  return `Browser failure bucket(s): ${summary}. Use the trace and recovery events to decide whether to retry, reattach, or continue with bounded evidence.`;
}

function normalizeSourceLabel(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function distinctRuntimeValues(events: ActivityEvent[], key: string): Set<string> {
  const values = new Set<string>();
  for (const event of events) {
    const value = event.runtime?.[key];
    if (typeof value === "string" && value.trim()) {
      values.add(value);
    }
  }
  return values;
}

function eventTextBlob(event: ActivityEvent): string {
  return [event.text, event.tags?.join(" ") ?? "", event.runtime ? Object.values(event.runtime).join(" ") : ""].join(" ");
}

function isApprovalDecisionEvent(event: ActivityEvent): boolean {
  const runtimeEventType = event.runtime?.eventType;
  if (runtimeEventType === "permission.result") {
    return true;
  }
  return /^(approved|denied)\b/i.test(event.text.trim());
}

function mentionsResidualRisk(text: string): boolean {
  return /\b(residual risk|risk|not verified|unverified|limitation|unknown)\b|风险|未验证|待确认/i.test(text);
}

function mentionsEvidenceUse(text: string): boolean {
  return /\b(source|evidence|verified|observed|browser|tool result|local fixture|fixture|citation|proof|confirmed|based on|according to)\b|来源|证据|已验证|观察|基于|根据/i.test(
    text
  );
}

function mentionsUnsupportedUncertainty(text: string): boolean {
  return (
    /\b(tbd|to be confirmed|needs confirmation|pending confirmation|placeholder|estimate only|rough estimate|temporarily unable|unable to confirm)\b/i.test(
      text
    ) || /(待确认|估算|占位|暂无法确认|暂时无法|无法确认|需要后续验证)/i.test(text)
  );
}

function mentionsToolFallbackAnswer(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const toolUnavailable =
    /\b(?:search|browser|tool|retrieval|web)(?: (?:tool|path|access|result|results))?(?: (?:is|was|are|were))? (?:unavailable|not available|failed|not working|unable)\b/.test(
      normalized
    );
  if (toolUnavailable) return true;
  if (/\b(?:based on|using) (?:my )?(?:knowledge|training data)\b/.test(normalized)) return true;
  if (/\bwithout (?:live|current|fresh) (?:search|browser|web|tool)\b/.test(normalized)) return true;
  return /搜索工具.{0,12}(?:无法|不可用|没有返回)|(?:基于|根据)我的(?:知识库|知识|训练数据)|工具.{0,12}(?:不可用|无法返回|没有返回)/i.test(
    text
  );
}

function substantiveLength(text: string): number {
  return text.replace(/\s+/g, " ").trim().length;
}
