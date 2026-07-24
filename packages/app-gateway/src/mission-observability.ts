import type { ActivityEvent, Mission } from "@turnkeyai/core-types/mission";
import type { RuntimeProgressEvent } from "@turnkeyai/core-types/team";
import {
  evaluateMissionGoalSlotCoverage,
  missionGoalSlotIssueDetail,
} from "./mission-goal-slot-coverage";
import { isLifecycleStatusText } from "./mission-final-answer-guard";

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
  const sessionSpawnCalls = distinctRuntimeValues(
    toolCalls.filter((event) => event.runtime?.toolName === "sessions_spawn"),
    "toolCallId"
  );
  const completedSessionResultCount = countCompletedSessionResultEvents(toolResults);
  const sessionSendCalls = distinctRuntimeValues(
    toolCalls.filter((event) => event.runtime?.toolName === "sessions_send"),
    "toolCallId"
  );
  const approvalEvents = events.filter((event) => event.kind === "approval");
  const finalAnswer = latestFinalAnswer(input.mission, events);
  const evidenceEvents = countEvidenceEvents(events);
  const evidenceText = collectEvidenceText(events);
  const sourceLabels = collectEvidenceSourceLabels(events);
  const browserProfileFallbacks = collectBrowserProfileFallbacks(events);
  const browserFailureBuckets = collectBrowserFailureBuckets(events);
  const recoveryEvents = events
    .filter((event) => event.kind === "recovery")
    .filter((event) => !isStaleIncompleteFinalRecovery(input.mission, event, finalAnswer));
  const outcomeEvents = [
    ...toolResults,
    ...recoveryEvents,
  ];
  const cancelled = outcomeEvents.filter((event) => /\bcancel(?:led|ed)?\b/i.test(eventTextBlob(event)));
  const timeouts = outcomeEvents.filter(isTimeoutOutcomeEvent);
  const terminalCutoffAnchorMs = finalAnswer?.tMs ?? (terminal ? (events.at(-1)?.tMs ?? input.nowMs) : undefined);
  const liveness = summarizeRuntimeLiveness(input.progressEvents ?? [], input.nowMs, {
    ...(terminalCutoffAnchorMs !== undefined ? { terminalLivenessCutoffMs: terminalCutoffAnchorMs + 1_000 } : {}),
  });
  const failureSummary = summarizeFailureAttention({
    failureEvents: recoveryEvents.length + toolFailures.length,
    finalAnswer,
    staleRuntimeSubjects: liveness.stale,
  });
  const checks = buildQualityChecks({
    mission: input.mission,
    events,
    finalAnswer,
    toolRequests: toolCalls.length,
    completedSessionResultCount,
    evidenceEvents,
    evidenceText,
    sourceLabels,
    browserProfileFallbacks,
    browserFailureBuckets,
    failureSummary,
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
  events: ActivityEvent[];
  finalAnswer: ActivityEvent | null;
  toolRequests: number;
  completedSessionResultCount: number;
  evidenceEvents: number;
  evidenceText: string;
  sourceLabels: string[];
  browserProfileFallbacks: BrowserProfileFallbackObservation[];
  browserFailureBuckets: BrowserFailureBucketObservation[];
  failureSummary: FailureAttentionSummary;
  staleRuntimeSubjects: number;
}): MissionObservabilitySnapshot["qualityGate"]["checks"] {
  const terminal = input.mission.status === "done" || input.mission.status === "blocked";
  const finalText = input.finalAnswer?.text ?? "";
  const goalText = missionGoalText(input.mission, input.events, input.finalAnswer);
  const conciseAnswerRequested = missionRequestsConciseAnswer(goalText);
  const residualRiskRequired =
    missionRequestsResidualRisk(goalText) ||
    input.failureSummary.total > 0 ||
    input.browserFailureBuckets.length > 0;
  const runtimeCoverageVerified = Boolean(
    input.finalAnswer?.runtime?.missionReportStatus === "completed" &&
      input.finalAnswer.runtime.missionReportSource === "runtime_derived" &&
      input.finalAnswer.runtime.missionReportReason === "completed_sub_agent_final" &&
      input.finalAnswer.runtime.missionReportCoverageVerified === "true"
  );
  const goalSlotCoverage = input.finalAnswer && !runtimeCoverageVerified
    ? evaluateMissionGoalSlotCoverage({
        goalText,
        finalText,
        evidence: {
          completedSessionResultCount: input.completedSessionResultCount,
        },
      })
    : null;
  const goalSlotCoverageIssues =
    runtimeCoverageVerified
      ? []
      : input.finalAnswer &&
          goalSlotCoverage &&
          (input.mission.closeout === "bounded_failure" ||
            missionAllowsBrowserBoundedFailureCloseout(goalText)) &&
          isAuthorizedBoundedBrowserFailureCloseout(goalSlotCoverage.issues, finalText)
        ? []
        : goalSlotCoverage?.issues ?? [];
  const valueConsistency = input.finalAnswer
    ? finalAnswerValueConsistency(finalText, input.evidenceText)
    : { mismatches: [] as EvidenceValueMismatch[] };
  return [
    {
      name: "final_answer",
      status: input.finalAnswer ? "pass" : terminal ? "fail" : "pending",
      detail: input.finalAnswer ? "Lead final answer is present." : "No lead final answer has been mirrored yet.",
    },
    {
      name: "mission_closeout",
      status: input.mission.closeout ? "warn" : "pass",
      detail: input.mission.closeout
        ? `Mission ended with non-success closeout '${input.mission.closeout}', so this is not a clean task-completed outcome.`
        : "Mission has no non-success closeout tag.",
    },
    {
      name: "goal_slot_coverage",
      status: !input.finalAnswer
        ? "pending"
        : goalSlotCoverageIssues.length > 0
          ? "fail"
          : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : runtimeCoverageVerified
          ? "Goal coverage was runtime-verified by the engine completion pipeline."
        : goalSlotCoverage && goalSlotCoverage.required.length === 0
          ? "No goal-critical research slots were inferred from the user request."
          : goalSlotCoverageIssues.length === 0 && (goalSlotCoverage?.issues.length ?? 0) > 0
            ? "Rendered browser evidence was intentionally closed out as a mission-authorized bounded browser failure with verified failure evidence, unverified scope, and next action."
            : missionGoalSlotIssueDetail(goalSlotCoverageIssues),
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
      name: "evidence_value_consistency",
      status: !input.finalAnswer ? "pending" : valueConsistency.mismatches.length > 0 ? "fail" : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : valueConsistency.mismatches.length > 0
          ? `Final answer contradicts source-backed numeric evidence: ${valueConsistency.mismatches
              .map(
                (mismatch) =>
                  `${mismatch.label} final=${mismatch.finalValues.join("/")}, evidence=${mismatch.evidenceValues.join("/")}`
              )
              .join("; ")}.`
          : "Final answer numeric values match source-backed evidence for tracked labels.",
    },
    {
      name: "residual_risk",
      status: !input.finalAnswer
        ? "pending"
        : mentionsResidualRisk(finalText) ||
            !residualRiskRequired ||
            (conciseAnswerRequested &&
              input.failureSummary.total === 0 &&
              input.browserFailureBuckets.length === 0)
          ? "pass"
          : "warn",
      detail: input.finalAnswer
        ? mentionsResidualRisk(finalText)
          ? "Final answer names residual risk or unverified scope."
          : !residualRiskRequired
            ? "No residual-risk closeout was required for this clean run."
          : conciseAnswerRequested && input.failureSummary.total === 0 && input.browserFailureBuckets.length === 0
            ? "Concise answer was requested and no residual failure scope was observed."
          : "Final answer does not explicitly name residual risk."
        : "Waiting for the final answer.",
    },
    {
      name: "answer_substance",
      status: !input.finalAnswer
        ? "pending"
        : input.toolRequests > 0 && substantiveLength(finalText) < 220 && !conciseAnswerRequested
          ? "warn"
          : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : input.toolRequests > 0 && substantiveLength(finalText) < 220 && !conciseAnswerRequested
          ? "Final answer is too brief for tool-backed work."
          : input.toolRequests > 0 && conciseAnswerRequested
            ? "Final answer is concise because the mission requested a short, fixed-shape answer."
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
      status: !input.finalAnswer ? "pending" : mentionsUnsupportedUncertainty(finalText, input.evidenceText) ? "warn" : "pass",
      detail: !input.finalAnswer
        ? "Waiting for the final answer."
        : mentionsUnsupportedUncertainty(finalText, input.evidenceText)
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
      status:
        input.failureSummary.total === 0
          ? "pass"
          : input.failureSummary.recovered
            ? "warn"
            : "fail",
      detail: failureAttentionDetail(input.failureSummary),
    },
  ];
}

interface FailureAttentionSummary {
  total: number;
  recovered: boolean;
  reason?: "timeout_closeout";
}

interface EvidenceValueMismatch {
  label: string;
  evidenceValues: string[];
  finalValues: string[];
}

function finalAnswerValueConsistency(finalText: string, evidenceText: string): { mismatches: EvidenceValueMismatch[] } {
  const mismatches: EvidenceValueMismatch[] = [];
  const evidenceMetrics = extractMetricNumericValues(evidenceText);
  const finalMetrics = extractMetricNumericValues(finalText);
  for (const [label, evidenceValues] of evidenceMetrics) {
    const finalValues = finalMetrics.get(label);
    if (!finalValues || finalValues.length === 0) continue;
    if (evidenceValues.length === 0) continue;
    if (finalValues.length === 0) continue;
    const evidenceSet = new Set(evidenceValues);
    const contradictedFinalValues = finalValues.filter((value) => !evidenceSet.has(value));
    if (contradictedFinalValues.length === 0) continue;
    mismatches.push({
      label: formatMetricLabel(label),
      evidenceValues,
      finalValues: [...new Set(contradictedFinalValues)],
    });
  }
  return { mismatches };
}

const METRIC_VALUE_RE = /\$?\d+(?:\.\d+)?\s*%?/gu;
const METRIC_LABEL_BEFORE_VALUE_RE = /([A-Za-z][A-Za-z0-9 /_:-]{1,90}?)(?:\s*(?::|=|-|is|are))?\s*$/u;

function extractMetricNumericValues(text: string): Map<string, string[]> {
  const metrics = new Map<string, Set<string>>();
  for (const fragment of text.split(/[,;\n.]+/u)) {
    if (!/\d/u.test(fragment)) continue;
    for (const match of fragment.matchAll(METRIC_VALUE_RE)) {
      if (match.index == null) continue;
      const labelWindow = fragment.slice(Math.max(0, match.index - 120), match.index);
      const labelMatch = labelWindow.match(METRIC_LABEL_BEFORE_VALUE_RE);
      const label = normalizeMetricLabel(labelMatch?.[1] ?? "");
      const value = normalizeTrackedNumericValue(match[0] ?? "");
      if (!label || !value) continue;
      const values = metrics.get(label) ?? new Set<string>();
      values.add(value);
      metrics.set(label, values);
    }
  }
  return new Map([...metrics.entries()].map(([label, values]) => [label, [...values]]));
}

function normalizeMetricLabel(label: string): string {
  const afterPrefix = label.includes(":") ? label.slice(label.lastIndexOf(":") + 1) : label;
  return afterPrefix
    .replace(/[-_/]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function formatMetricLabel(label: string): string {
  return label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : label;
}

function normalizeTrackedNumericValue(value: string): string {
  const normalized = value.replace(/\s+/g, "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.endsWith("%")) {
    return `${Number.parseFloat(normalized.slice(0, -1))}%`;
  }
  const currencyPrefix = normalized.startsWith("$") ? "$" : "";
  const numericText = currencyPrefix ? normalized.slice(1) : normalized;
  const numeric = Number.parseFloat(numericText);
  return Number.isFinite(numeric) ? `${currencyPrefix}${numeric}` : "";
}

function summarizeFailureAttention(input: {
  failureEvents: number;
  finalAnswer: ActivityEvent | null;
  staleRuntimeSubjects: number;
}): FailureAttentionSummary {
  if (input.failureEvents === 0) {
    return { total: 0, recovered: false };
  }
  if (
    input.staleRuntimeSubjects === 0 &&
    ((input.finalAnswer?.runtime?.toolLoopCloseoutReason === "sub_agent_timeout" &&
      input.finalAnswer.runtime?.["toolLoopCloseout.evidenceAvailable"] === "true") ||
      mentionsBoundedTimeoutCloseout(input.finalAnswer?.text ?? "")) &&
    mentionsResidualRisk(input.finalAnswer?.text ?? "")
  ) {
    return { total: input.failureEvents, recovered: true, reason: "timeout_closeout" };
  }
  return { total: input.failureEvents, recovered: false };
}

function mentionsBoundedTimeoutCloseout(text: string): boolean {
  return (
    /\b(?:timeout|timed out|transport failure|navigation failure|DOMContentLoaded never fired)\b/i.test(text) &&
    /\bverified\b/i.test(text) &&
    /\bunverified\b/i.test(text)
  );
}

function failureAttentionDetail(summary: FailureAttentionSummary): string {
  if (summary.total === 0) {
    return "No recovery or failed tool-result event is present.";
  }
  if (summary.recovered && summary.reason === "timeout_closeout") {
    return `${summary.total} recovery/failed tool event(s) were closed out by a bounded timeout recovery final answer; keep the replay visible for follow-up.`;
  }
  return `${summary.total} recovery/failed tool event(s) require attention.`;
}

function isAuthorizedBoundedBrowserFailureCloseout(
  issues: Array<{ slot: string; reason: string }>,
  finalText: string
): boolean {
  if (issues.length === 0) return false;
  if (!issues.every((issue) => issue.slot === "rendered_browser")) return false;
  return (
    /\b(?:browser|target|tab|page|CDP|Chrome DevTools|automation)\b[\s\S]{0,160}\b(?:detached_target|detached|browser_cdp_unavailable|cdp_command_timeout|attach_failed|unavailable|timed out|timeout|failed to attach)\b|\b(?:detached_target|detached|browser_cdp_unavailable|cdp_command_timeout|attach_failed|unavailable|timed out|timeout|failed to attach)\b[\s\S]{0,160}\b(?:browser|target|tab|page|CDP|Chrome DevTools|automation)\b/i.test(
      finalText
    ) &&
    /\bwhat was verified\b|\bverified\b[\s\S]{0,120}\b(?:URL|target|failure|bucket|attempt|browser|CDP|connection)\b/i.test(
      finalText
    ) &&
    /\bwhat remains unverified\b|\b(?:remains? )?unverified\b|\bnot verified\b/i.test(finalText) &&
    /\bnext action\b|\boperator\b[\s\S]{0,120}\b(?:should|can|must|next)\b|\b(?:restart|repair|re[- ]?run|retry|diagnose)\b/i.test(
      finalText
    )
  );
}

function missionAllowsBrowserBoundedFailureCloseout(goalText: string): boolean {
  return /\bif\b[\s\S]{0,120}\b(?:browser|CDP|automation|target)\b[\s\S]{0,120}\b(?:cannot|can't|unavailable|unreachable|refused|cannot be reached|could not be reached|times? out|timed out|timeout|detaches?|detached|detached_target|attach(?:es|ed|ing)?|attach_failed|failed to attach)\b[\s\S]{0,160}\b(?:close out|closeout|what was verified|remains? unverified|next action)\b/i.test(
    goalText
  );
}

function isStaleIncompleteFinalRecovery(
  mission: Mission,
  event: ActivityEvent,
  finalAnswer: ActivityEvent | null
): boolean {
  if (mission.status !== "done") return false;
  if (!finalAnswer) return false;
  if (event.runtime?.eventType !== "mission.incomplete_final_answer") return false;
  if (looksLikeBlockedOrFailedFinal(finalAnswer.text)) return false;
  if (looksLikeTruncatedMarkdown(finalAnswer.text)) return false;
  return (
    evaluateMissionGoalSlotCoverage({
      goalText: missionGoalText(mission),
      finalText: finalAnswer.text,
    }).issues.length === 0
  );
}

function looksLikeBlockedOrFailedFinal(text: string): boolean {
  return /\b(?:blocked|unavailable|unreachable|cannot be reached|could not be reached|connection refused|ECONNREFUSED|timed out|timeouts?|timeout|not verified|unverified|failed|failure|did not complete|not completed|could not complete)\b/i.test(
    text
  );
}

function looksLikeTruncatedMarkdown(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) return true;
  const lastLfIndex = trimmed.lastIndexOf("\n");
  const lastNonEmpty = trimmed.slice(Math.max(0, lastLfIndex + 1));
  const pipeCount = (lastNonEmpty.match(/\|/g) ?? []).length;
  if (lastNonEmpty.trimStart().startsWith("|") && pipeCount < 2) return true;
  return hasUnclosedTrailingInlineMarkdown(lastNonEmpty);
}

function hasUnclosedTrailingInlineMarkdown(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.endsWith("[")) return true;
  if (trimmed.endsWith("**")) return countOccurrences(trimmed, "**") % 2 === 1;
  if (trimmed.endsWith("__")) return countOccurrences(trimmed, "__") % 2 === 1;
  return false;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = value.indexOf(needle, index);
    if (next < 0) return count;
    count += 1;
    index = next + needle.length;
  }
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
  if (reason === "partial_sub_agent_final") {
    return {
      name: "tool_loop_closeout",
      status: "pass",
      detail: toolLoopCloseoutDetail(finalAnswer, "Final answer synthesized from bounded partial sub-agent final content."),
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
  const latestUserIndex = latestUserPlanIndex(events);
  const staleBeforeIndex = Math.max(latestUserIndex, latestToolActivityIndex(events));
  let latest: ActivityEvent | null = null;
  for (const [index, event] of events.entries()) {
    if (event.kind !== "thought" || event.text.trim().length === 0) continue;
    if (isLifecycleStatusText(event.text)) continue;
    if (index <= staleBeforeIndex) continue;
    if (hasUnresolvedToolCallBeforeAnswer(events, latestUserIndex, index)) continue;
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

function hasUnresolvedToolCallBeforeAnswer(
  events: ActivityEvent[],
  afterIndex: number,
  answerIndex: number
): boolean {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (let index = afterIndex + 1; index < answerIndex; index += 1) {
    const event = events[index];
    if (event?.kind !== "tool") continue;
    const toolCallId = event.runtime?.toolCallId;
    if (!toolCallId) continue;
    if (event.runtime?.toolPhase === "call") {
      callIds.add(toolCallId);
    } else if (event.runtime?.toolPhase === "result") {
      resultIds.add(toolCallId);
    }
  }
  for (const callId of callIds) {
    if (!resultIds.has(callId)) return true;
  }
  return false;
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
  return events.reduce((count, event) => {
    if (event.evidence?.length) return count + event.evidence.length;
    if (event.kind === "browser" || event.kind === "doc" || event.kind === "artifact") return count + 1;
    if (event.kind !== "tool") return count;
    if (event.runtime?.toolPhase !== "result") return count;
    if (event.runtime.admission === "skipped") return count;
    return count + countToolEvidenceUnits(event);
  }, 0);
}

function collectEvidenceText(events: ActivityEvent[]): string {
  return events
    .filter((event) => {
      if (event.evidence?.length) return true;
      if (event.kind === "browser" || event.kind === "doc" || event.kind === "artifact") return true;
      if (event.kind !== "tool") return false;
      if (event.runtime?.toolPhase !== "result") return false;
      return event.runtime.admission !== "skipped";
    })
    .map(eventTextBlob)
    .join("\n\n");
}

function collectEvidenceSourceLabels(events: ActivityEvent[]): string[] {
  const labels = new Map<string, string>();
  for (const event of events) {
    for (const evidence of event.evidence ?? []) {
      addSourceLabel(labels, evidence.label);
    }
    const toolEvidenceLabels = readToolEvidenceSourceLabels(event);
    if (toolEvidenceLabels.length === 0) {
      addSourceLabel(labels, event.runtime?.sourceLabel);
    }
    addSourceLabel(labels, event.runtime?.sourceName);
    addSourceLabel(labels, event.runtime?.sourceTitle);
    for (const label of toolEvidenceLabels) {
      addSourceLabel(labels, label);
    }
  }
  return [...labels.values()];
}

function countToolEvidenceUnits(event: ActivityEvent): number {
  const parsed = parseToolResultEvent(event);
  if (!parsed) return 1;
  const pages = readToolPayloadPages(parsed.payload);
  const sourceResults = readToolPayloadSourceResults(parsed.payload);
  const completedSourceResults = sourceResults.filter((item) => item.status !== "failed");
  return Math.max(1, pages.length, completedSourceResults.length, countEvidenceSummarySources(parsed.evidence_summary));
}

function readToolEvidenceSourceLabels(event: ActivityEvent): string[] {
  if (event.kind !== "tool" || event.runtime?.toolPhase !== "result" || event.runtime.admission === "skipped") {
    return [];
  }
  const parsed = parseToolResultEvent(event);
  if (!parsed) return [];
  const labels: string[] = [];
  labels.push(...readEvidenceSummarySourceLabels(parsed.evidence_summary));
  for (const sourceResult of readToolPayloadSourceResults(parsed.payload)) {
    if (sourceResult.status === "failed") continue;
    if (sourceResult.label && !looksLikeUrl(sourceResult.label)) labels.push(sourceResult.label);
  }
  for (const page of readToolPayloadPages(parsed.payload)) {
    if (page.title) labels.push(page.title);
  }
  return labels;
}

function parseToolResultEvent(event: ActivityEvent): {
  payload?: unknown;
  evidence_summary?: unknown;
} | null {
  return parseToolResultText(event.runtime?.resultContent ?? event.text);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function parseToolResultText(text: string): { payload?: unknown; evidence_summary?: unknown } | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { payload?: unknown; evidence_summary?: unknown })
      : null;
  } catch {
    return null;
  }
}

function countEvidenceSummarySources(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  const matches = value.match(/(?:^|\n)\s*Source\s+\d+\s*:/gi);
  return matches?.length ?? 0;
}

function readEvidenceSummarySourceLabels(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*Page title:\s*(.+?)\s*$/i)?.[1]?.trim())
    .filter((label): label is string => Boolean(label));
}

function readToolPayloadPages(payload: unknown): Array<{ finalUrl?: string; title?: string }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const pages: Array<{ finalUrl?: string; title?: string }> = [];
  const seen = new Set<string>();
  const addPage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const page = value as Record<string, unknown>;
    const finalUrl = readOptionalString(page.finalUrl);
    const title = readOptionalString(page.title);
    const key = finalUrl ?? title;
    if (!key || seen.has(key)) return;
    seen.add(key);
    pages.push({ ...(finalUrl ? { finalUrl } : {}), ...(title ? { title } : {}) });
  };
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) addPage(page);
  }
  if (Array.isArray(record.sourceResults)) {
    for (const sourceResult of record.sourceResults) {
      if (!sourceResult || typeof sourceResult !== "object" || Array.isArray(sourceResult)) continue;
      addPage((sourceResult as Record<string, unknown>).page);
    }
  }
  addPage(record.page);
  return pages;
}

function readToolPayloadSourceResults(payload: unknown): Array<{ status?: string; label?: string; url?: string }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const sourceResults = (payload as Record<string, unknown>).sourceResults;
  if (!Array.isArray(sourceResults)) {
    return [];
  }
  return sourceResults.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const result: { status?: string; label?: string; url?: string } = {};
    const status = readOptionalString(record.status);
    const label = readOptionalString(record.label);
    const url = readOptionalString(record.url);
    if (status) result.status = status;
    if (label) result.label = label;
    if (url) result.url = url;
    return [result];
  });
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function addSourceLabel(labels: Map<string, string>, value: string | undefined): void {
  const normalized = normalizeSourceLabel(value);
  if (!normalized) return;
  if (isInternalSourceTransportLabel(normalized)) return;
  labels.set(normalized, value!.trim());
}

function isInternalSourceTransportLabel(normalizedLabel: string): boolean {
  return (
    /\braw\s+(?:fetch|source|html|page)\b|\b(?:fetch|source|html|page)\s+raw\b/.test(normalizedLabel) ||
    /\bbounded\s+probe\b/.test(normalizedLabel)
  );
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
  const labelTokens = new Set(tokenizeSourceLabel(label));
  if (
    labelTokens.has("form") &&
    labelTokens.has("submit") &&
    /\bbrowser\.form\.submit\b/i.test(normalizedText) &&
    /\b(?:approved|applied|executed|submitted|postsubmission)\b/i.test(normalizedText)
  ) {
    return true;
  }
  if (
    labelTokens.has("dryrun") &&
    (labelTokens.has("submission") || labelTokens.has("submit")) &&
    /\b(?:browser\.form\.submit|submission executed|submit dry-run|dry-run submitted|submitted locally after approval)\b/i.test(
      normalizedText,
    ) &&
    /\b(?:approved|executed|submitted|postsubmission|post-submit|after approval)\b/i.test(
      normalizedText,
    )
  ) {
    return true;
  }
  if (
    labelTokens.has("approval") &&
    labelTokens.has("form") &&
    /\b(?:approval form|approval gate fixture|browser\.form\.submit|form identified|pre[- ]submission|post[- ]submission|submit dry[- ]run)\b/i.test(
      normalizedText,
    )
  ) {
    return true;
  }
  if (
    labelTokens.has("three") &&
    labelTokens.has("stream") &&
    /\broute\b/i.test(normalizedText) &&
    /\bbudget\b/i.test(normalizedText) &&
    /\b(?:readiness|ready|risk|dashboard)\b/i.test(normalizedText)
  ) {
    return true;
  }
  if (
    labelTokens.has("route") &&
    (/\broute\b[\s\S]{0,80}\b(?:source|page|data|evidence|stream)\b/i.test(normalizedText) ||
      /\b(?:source|page|data|evidence|stream)\b[\s\S]{0,80}\broute\b/i.test(normalizedText))
  ) {
    return true;
  }
  if (
    labelTokens.has("budget") &&
    (/\bbudget\b[\s\S]{0,80}\b(?:source|page|data|evidence|stream)\b/i.test(normalizedText) ||
      /\b(?:source|page|data|evidence|stream)\b[\s\S]{0,80}\bbudget\b/i.test(normalizedText))
  ) {
    return true;
  }
  if (
    (labelTokens.has("live") || labelTokens.has("readiness") || labelTokens.has("ready")) &&
    (/\b(?:live|readiness|ready)\b[\s\S]{0,80}\b(?:source|page|data|evidence|dashboard|stream|complete)\b/i.test(normalizedText) ||
      /\b(?:source|page|data|evidence|dashboard|stream|complete)\b[\s\S]{0,80}\b(?:live|readiness|ready)\b/i.test(normalizedText))
  ) {
    return true;
  }
  if (
    labelTokens.has("slow") &&
    (labelTokens.has("timeout") || labelTokens.has("source")) &&
    /\b(?:timeout|timedout|timed|bounded)\b/i.test(normalizedText)
  ) {
    return true;
  }
  if (
    labelTokens.has("slow") &&
    (labelTokens.has("resume") || labelTokens.has("recovery") || labelTokens.has("continue")) &&
    /\b(?:resume|resumed|retry|continue|continued|recovered|recovery|timeout)\b/i.test(normalizedText)
  ) {
    return true;
  }
  if (
    labelTokens.has("browser") &&
    labelTokens.has("render") &&
    /\b(?:http status|status 200|200 ok|page title|visible|rendered|browser)\b/i.test(normalizedText)
  ) {
    return true;
  }
  if (labelTokens.has("operations") && labelTokens.has("dashboard") && hasOpsDashboardEvidence(normalizedText)) {
    const restartScoped =
      labelTokens.has("post") ||
      labelTokens.has("restart") ||
      labelTokens.has("reconnect") ||
      labelTokens.has("resume") ||
      labelTokens.has("reopen") ||
      labelTokens.has("recheck");
    if (!restartScoped || hasRestartedBrowserEvidence(normalizedText)) {
      return true;
    }
  }
  if (
    labelTokens.has("search") &&
    (labelTokens.has("support") || labelTokens.has("verification") || labelTokens.has("verify")) &&
    /\b(?:search|web_search)\b/i.test(normalizedText) &&
    /\b(?:support|supported|supports|支持|不支持|明确支持|明确不支持)\b/i.test(normalizedText)
  ) {
    return true;
  }
  if (
    (labelTokens.has("pricing") || labelTokens.has("price")) &&
    (labelTokens.has("source") || labelTokens.has("verify") || labelTokens.has("verification")) &&
    /\b(?:provider|providers|platform|api|model)\b/i.test(normalizedText) &&
    /\b(?:price|pricing|input price|output price|输入价格|输出价格|[$￥¥]\s*\d)\b/i.test(
      normalizedText
    ) &&
    /\b(?:source|evidence url|localhost|127\.0\.0\.1|证据 url|来源)\b/i.test(normalizedText)
  ) {
    return true;
  }
  const sourceTokens = distinctiveSourceLabelTokens(label);
  if (sourceTokens.length === 0) return true;
  return sourceTokens.every((token) => textTokens.has(token));
}

function hasOpsDashboardEvidence(text: string): boolean {
  return (
    /\bqueue depth\b[\s\S]{0,80}\b\d+\b/i.test(text) ||
    /\bSLA breaches?\b[\s\S]{0,80}\b\d+\b/i.test(text) ||
    /\bescalation\b[\s\S]{0,80}\b(?:active|triggered|fires?|threshold|policy)\b/i.test(text)
  );
}

function hasRestartedBrowserEvidence(text: string): boolean {
  return /\b(?:restart|restarted|reconnect(?:ed)?|reload(?:ed)?|resume(?:d)?|reopen(?:ed)?|recheck(?:ed)?|cold resume|warm resume)\b/i.test(
    text
  );
}

const GENERIC_SOURCE_LABEL_TOKENS = new Set([
  "analysis",
  "brief",
  "browser",
  "capture",
  "captured",
  "capabilities",
  "capability",
  "check",
  "cold",
  "compare",
  "comparison",
  "collection",
  "dashboard",
  "decision",
  "evidence",
  "evaluate",
  "evaluation",
  "extract",
  "extraction",
  "fetch",
  "fresh",
  "full",
  "inspection",
  "live",
  "local",
  "note",
  "of",
  "open",
  "opened",
  "page",
  "research",
  "researcher",
  "report",
  "render",
  "rendered",
  "review",
  "scan",
  "session",
  "snapshot",
  "source",
  "stream",
  "summary",
  "synthesize",
  "synthesis",
  "tool",
  "url",
  "verification",
  "verify",
  "view",
  "worker",
  "after",
  "before",
  "continue",
  "continuation",
  "follow",
  "followup",
  "post",
  "pre",
  "product",
  "pull",
  "read",
  "re",
  "recheck",
  "rechecked",
  "recover",
  "recovered",
  "recovery",
  "reopen",
  "reopened",
  "reconnect",
  "reconnected",
  "reconnection",
  "refine",
  "inspect",
  "inspected",
  "resume",
  "retry",
  "restart",
  "restarted",
  "revisit",
]);

function distinctiveSourceLabelTokens(label: string): string[] {
  const tokens = tokenizeSourceLabel(label);
  return tokens.filter((token) => !GENERIC_SOURCE_LABEL_TOKENS.has(token) && !/^v\d+$/i.test(token));
}

function tokenizeSourceLabel(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .map(canonicalSourceToken)
    .filter((token) => token.length > 1);
}

function canonicalSourceToken(token: string): string {
  if (token === "ops") return "operations";
  if (token === "operational") return "operations";
  return token;
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

const BROWSER_SPECIFIC_FAILURE_BUCKETS = new Set([
  "target_not_found",
  "attach_failed",
  "expert_session_detached",
  "cdp_command_timeout",
  "browser_cdp_unavailable",
  "detached_target",
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
  const explicitBrowserBucket = normalizeBrowserFailureBucket(event.runtime?.browserDiagnosticBucket ?? "");
  if (explicitBrowserBucket) return explicitBrowserBucket;

  const text = eventTextBlob(event);
  const sessionBrowserBucket = extractSessionBrowserRecoveryBucket(event, text);
  if (sessionBrowserBucket) return sessionBrowserBucket;
  if (isColdBrowserRecoveryEvidence(event, text)) return "session_not_found";

  const isBrowserFailureEvidence = isBrowserFailureEvidenceEvent(event);
  if (isBrowserFailureEvidence) {
    const candidates = [event.runtime?.bucket, event.runtime?.closeKind, event.runtime?.failureBucket];
    for (const candidate of candidates) {
      const normalized = normalizeBrowserFailureBucket(typeof candidate === "string" ? candidate : "");
      if (normalized) return normalized;
    }
  }

  if (!isFailureEvidenceEvent(event)) return null;

  const directBucket = matchBrowserFailureBucket(text);
  const normalizedDirect = normalizeBrowserFailureBucket(directBucket ?? "");
  if (normalizedDirect && (BROWSER_SPECIFIC_FAILURE_BUCKETS.has(normalizedDirect) || isBrowserFailureEvidence)) {
    return normalizedDirect;
  }

  if (!isBrowserFailureEvidence) return null;
  if (/\b(?:target detached|detached target|browser session detached)\b/i.test(text)) return "detached_target";
  if (/\b(?:session not found|browser session not found)\b/i.test(text)) return "session_not_found";
  if (/\b(?:cdp|transport|websocket|connection refused|ECONNREFUSED|fetch failed)\b/i.test(text)) return "transport_failure";
  return null;
}

function extractSessionBrowserRecoveryBucket(event: ActivityEvent, text: string): string | null {
  if (event.kind !== "tool" || event.runtime?.toolPhase !== "result") return null;
  const toolName = event.runtime.toolName ?? "";
  if (toolName !== "sessions_spawn" && toolName !== "sessions_send") return null;
  if (!/"agent_id"\s*:\s*"browser"/i.test(text) && !/\bbrowserRecovery\b|\bfailureBuckets\b/i.test(text)) {
    return null;
  }
  return normalizeBrowserFailureBucket(matchBrowserFailureBucket(text) ?? "");
}

function isColdBrowserRecoveryEvidence(event: ActivityEvent, text: string): boolean {
  if (!/\bbrowser\b/i.test(text)) return false;
  if (
    !/\b(?:cold[-\s]?recovered\s+session|new browser session|session not found|browser session not found|session (?:was )?unavailable|previous session (?:was )?unavailable|prior browser session (?:was )?unavailable|fresh browser opened|recovery confirmed)\b/i.test(
      text
    )
  ) {
    return false;
  }
  if (event.kind === "recovery") return true;
  if (event.kind === "tool" && event.runtime?.toolPhase === "result") {
    const toolName = event.runtime.toolName ?? "";
    return toolName === "sessions_spawn" || toolName === "sessions_send";
  }
  return event.kind === "thought" && /\b(?:source|verified|recovered|session|residual risk)\b/i.test(text);
}

function matchBrowserFailureBucket(text: string): string | null {
  return (
    text.match(
      /\b(target_not_found|attach_failed|expert_session_detached|cdp_command_timeout|browser_cdp_unavailable|detached_target|session_not_found|transport_failure|owner_mismatch|lease_conflict)\b/i
    )?.[1] ?? null
  );
}

function isBrowserFailureEvidenceEvent(event: ActivityEvent): boolean {
  if (!isFailureEvidenceEvent(event)) return false;
  if (event.kind === "browser") return true;
  const runtime = event.runtime ?? {};
  const structuralText = [
    event.actor,
    ...(event.tags ?? []),
    runtime.toolName,
    runtime.route,
    runtime.sourceLabel,
    runtime.transportLabel,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (/\b(?:browser|bridge|cdp|direct[-_\s]?cdp|chrome|expert)\b/i.test(structuralText)) return true;
  if (event.kind === "recovery" && /\b(?:browser|cdp|direct[-_\s]?cdp|chrome)\b/i.test(eventTextBlob(event))) {
    return true;
  }
  return false;
}

function isFailureEvidenceEvent(event: ActivityEvent): boolean {
  if (event.emph === "danger") return true;
  if (event.kind === "recovery") return true;
  const runtime = event.runtime ?? {};
  const candidates = [
    runtime.isError,
    runtime.phase,
    runtime.status,
    runtime.continuityState,
    runtime.bucket,
    runtime.closeKind,
    runtime.failureBucket,
    runtime.browserDiagnosticBucket,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBrowserFailureBucket(typeof candidate === "string" ? candidate : "");
    if (normalized) return true;
  }
  return /\b(?:true|failed|failure|cancelled|timeout|recoverable|unrecoverable)\b/i.test(candidates.join(" "));
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

function countCompletedSessionResultEvents(events: ActivityEvent[]): number {
  const values = new Set<string>();
  for (const event of events) {
    if (event.runtime?.toolName !== "sessions_spawn" && event.runtime?.toolName !== "sessions_send") continue;
    if (structuredToolResultStatus(event) !== "completed") continue;
    values.add(readSessionResultEvidenceKey(event));
  }
  return values.size;
}

function readSessionResultEvidenceKey(event: ActivityEvent): string {
  const content = event.runtime?.resultContent;
  if (typeof content === "string" && content.trim()) {
    try {
      const parsed = JSON.parse(content) as { session_key?: unknown };
      if (typeof parsed.session_key === "string" && parsed.session_key.trim()) return parsed.session_key;
    } catch {
      const match = content.match(/"session_key"\s*:\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    }
  }
  return event.runtime?.toolCallId ?? event.id;
}

function eventTextBlob(event: ActivityEvent): string {
  return [event.text, event.tags?.join(" ") ?? "", event.runtime ? Object.values(event.runtime).join(" ") : ""].join(" ");
}

function isTimeoutOutcomeEvent(event: ActivityEvent): boolean {
  const status = structuredToolResultStatus(event);
  if (status === "completed" || status === "failed" || status === "cancelled") return false;
  if (status === "timeout") return true;
  return /\btime(?:d)?\s*out|timeout\b/i.test(eventTextBlob(event));
}

function structuredToolResultStatus(event: ActivityEvent): string | null {
  const content = event.runtime?.resultContent;
  if (typeof content === "string" && content.trim()) {
    try {
      const parsed = JSON.parse(content) as { status?: unknown };
      if (typeof parsed.status === "string") return parsed.status;
    } catch {
      const match = content.match(/"status"\s*:\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    }
  }
  const text = eventTextBlob(event);
  const returnedCompleted = /\bTool\s+\S+\s+returned\b/i.test(text) && /"status"\s*:\s*"completed"/i.test(text);
  if (returnedCompleted) return "completed";
  return null;
}

function missionGoalText(mission: Mission, events?: ActivityEvent[], finalAnswer?: ActivityEvent | null): string {
  const latestUser = events && finalAnswer ? latestUserPlanBeforeAnswer(events, finalAnswer) : null;
  const latestUserText = latestUser?.text.trim() ?? "";
  const activeGoalText = shouldPreferLatestUserGoal(latestUserText) ? latestUserText : mission.desc;
  return uniqueNonEmptyStrings([mission.title, activeGoalText]).join("\n");
}

function latestUserPlanBeforeAnswer(events: ActivityEvent[], finalAnswer: ActivityEvent): ActivityEvent | null {
  let latest: ActivityEvent | null = null;
  for (const event of events) {
    if (event.tMs > finalAnswer.tMs) continue;
    if (event.kind !== "plan") continue;
    if (event.actor !== "user" && event.runtime?.teamRole !== "user") continue;
    latest = event;
  }
  return latest;
}

function shouldPreferLatestUserGoal(text: string): boolean {
  if (!text) return false;
  if (/^user says\s+\S+$/i.test(text)) return false;
  if (/^(?:继续|继续吧|go on|continue|keep going|resume)$/i.test(text.trim())) return false;
  return true;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
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

function missionRequestsResidualRisk(text: string): boolean {
  return /\b(residual risk|risk|risks|not verified|unverified|uncertainty|unknown|limitation|caveat)\b|风险|未验证|待确认|不确定|限制|缺口/i.test(
    text
  );
}

function missionRequestsConciseAnswer(text: string): boolean {
  return /\b(?:only answer|answer only|respond only|return only|just answer|exactly(?:\s+these)?\s+\d+\s+(?:items?|fields?|points?))\b|只(?:回答|输出|返回|列出)\s*(?:这|以下)?\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:项|点|个|条)|只(?:回答|输出|返回|列出)/i.test(
    text
  );
}

function mentionsEvidenceUse(text: string): boolean {
  return (
    /\b(source|evidence|verified|observed|browser|tool result|local fixture|fixture|citation|proof|confirmed|based on|according to)\b|来源|证据|已验证|观察|基于|根据/i.test(
      text
    ) || mentionsSourceBoundExcerptTable(text)
  );
}

function mentionsSourceBoundExcerptTable(text: string): boolean {
  const hasSourceLocator =
    /\bhttps?:\/\/\S+/i.test(text) ||
    /(?:^|\|)\s*(?:检查的\s*)?URL\s*(?:\||$)/i.test(text);
  const hasTitleDimension =
    /(?:页面\s*)?标题|页面\s*title|\bpage\s+title\b|\btitle\b/i.test(text);
  const hasQuotedExcerptDimension =
    /关键\s*原文\s*摘录|原文\s*摘录|quoted?\s+excerpt|source\s+excerpt|direct\s+quote|quote/i.test(text) ||
    /["“][^"”\n]{24,}["”]/.test(text);
  return hasSourceLocator && hasTitleDimension && hasQuotedExcerptDimension;
}

function mentionsUnsupportedUncertainty(text: string, evidenceText = ""): boolean {
  return (
    /\b(tbd|to be confirmed|needs confirmation|pending confirmation|placeholder(?!\s+domain)|estimate only|rough estimate|temporarily unable|unable to confirm)\b/i.test(
      text
    ) ||
    /(待确认|估算|占位(?!域名|链接)|暂无法确认|暂时无法|无法确认|需要后续验证)/i.test(text) ||
    mentionsSourceExternalOperationsUpgrade(text, evidenceText)
  );
}

function mentionsSourceExternalOperationsUpgrade(text: string, evidenceText: string): boolean {
  const strongRestriction =
    /(?:不得|不能|禁止|不可|不应)[^。；;\n]{0,120}(?:生产|运营|实际运营|真实环境|测试环境|真实服务|正式业务|真实业务|联网业务|业务场景)/.test(
      text
    ) ||
    /\b(?:must not|cannot|prohibited|forbidden|not allowed)\b[\s\S]{0,120}\b(?:operations?|production|real service|real services|real environment|test environment|business use|networked business)\b/i.test(
      text
    );
  if (strongRestriction && !evidenceStatesStrictOperationsRestriction(evidenceText)) return true;
  return (
    /(?:路由冲突|安全风险|恶意(?:测试)?流量|abuse risk|security risk|routing conflict)/i.test(text) &&
    !/(?:路由冲突|安全风险|恶意(?:测试)?流量|abuse risk|security risk|routing conflict)/i.test(evidenceText)
  );
}

function evidenceStatesStrictOperationsRestriction(evidenceText: string): boolean {
  return (
    /(?:不得|不能|禁止|不可|不应)[^。；;\n]{0,120}(?:生产|运营|实际运营|真实环境|测试环境|真实服务|正式业务|真实业务|联网业务|业务场景)/.test(
      evidenceText
    ) ||
    /\b(?:must not|cannot|prohibited|forbidden|not allowed)\b[\s\S]{0,120}\b(?:operations?|production|real service|real services|real environment|test environment|business use|networked business)\b/i.test(
      evidenceText
    )
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
