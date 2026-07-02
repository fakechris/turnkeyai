import type {
  GenerateTextResult,
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";
import type { ToolProgressEvent, ToolResult } from "@turnkeyai/agent-core/tool";
import type {
  NativeToolProgressTrace,
  NativeToolResultTrace,
  NativeToolRoundTrace,
} from "./native-tool-messages";
import type { RolePromptPacket } from "./prompt-policy";
import {
  normalizeToolInputForSignature,
  stableJson,
  toolCallSignature,
} from "./react/predicates";
import { parseSessionToolResult } from "./session-tool-result-protocol";

export interface SessionContinuationDirective {
  sessionKey: string;
  messageHint: string;
}

export interface SessionContinuationLookupDirective {
  messageHint: string;
}

export const SESSION_TOOL_RESULT_PROTOCOL = "turnkeyai.session_tool_result.v1";

export const SUPPLEMENTAL_LOCAL_TIMEOUT_PROBE_TIMEOUT_SECONDS = 45;

export const SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS = 10_000;

export function taskPromptLooksLikeSourceCheckContinuation(taskPrompt: string): boolean {
  return (
    /\b(?:slow-source|slow source|slow-fixture|slow fixture|source-check|source check)\b/i.test(taskPrompt) &&
    /\b(?:continue|retry|resume|recovered|recovery|follow-?up|same source-check context|same source check context|existing source-check context|existing source check context)\b/i.test(
      taskPrompt,
    ) &&
    /\b(?:timeout|timed out|bounded attempt|release-risk|release risk|risk note|residual risk)\b/i.test(taskPrompt)
  );
}

export function readSessionKeyFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = (input as Record<string, unknown>)["session_key"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function taskRequestsSessionTranscript(taskPrompt: string): boolean {
  return /\b(?:full|complete|entire|raw)\s+(?:session\s+)?(?:transcript|history|log)\b|\b(?:show|print|dump|export)\s+(?:the\s+)?(?:session\s+)?(?:transcript|history|log)\b|完整(?:会话|历史|记录)|原始(?:会话|历史|记录)/iu.test(
    taskPrompt,
  );
}

export function sliceUtf8(value: string, maxBytes: number): string {
  // gemini + coderabbit K3.6: keep the persisted slice strictly
  // <= maxBytes. The earlier version appended an "…[truncated]"
  // suffix AFTER slicing, blowing the byte budget by 14 bytes.
  // The trace already carries a `contentTruncated: true` flag so
  // the UI knows to label it — no need to encode "truncated" in
  // the bytes themselves.
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  // Step back if the last byte is a continuation byte (10xxxxxx)
  // until we land on a codepoint boundary.
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

export function limitIndependentEvidenceSpawnCalls(
  toolCalls: LLMToolCall[],
  input: {
    taskPrompt: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  const requiredStreams = inferIndependentEvidenceStreamCount(input.taskPrompt);
  if (requiredStreams < 2) {
    return toolCalls;
  }
  const spawnCalls = toolCalls.filter((call) => call.name === "sessions_spawn");
  if (spawnCalls.length <= 1) {
    return toolCalls;
  }
  const completedStreams = countCompletedSessionEvidenceResults(
    input.toolTrace,
  );
  const remainingStreams = Math.max(0, requiredStreams - completedStreams);
  if (spawnCalls.length <= remainingStreams) {
    return toolCalls;
  }
  let keptSpawns = 0;
  return toolCalls.filter((call) => {
    if (call.name !== "sessions_spawn") {
      return true;
    }
    keptSpawns += 1;
    return keptSpawns <= remainingStreams;
  });
}

export function inferIndependentEvidenceStreamCount(taskPrompt: string): number {
  if (isTwoSourceComparisonTask(taskPrompt)) {
    return Math.min(6, uniqueHttpUrlCount(taskPrompt));
  }
  if (/\b(?:three|3) independent evidence streams\b/i.test(taskPrompt)) {
    return 3;
  }
  if (
    /\b(?:three|3)\b[\s\S]{0,80}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:route|budget|live readiness)\b[\s\S]{0,120}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  if (
    /\bgather evidence from (?:three|3) independent child sessions\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  const sourceLineCount = taskPrompt
    .split(/\r?\n/)
    .filter((line) =>
      /^\s*(?:[-*]\s*)?(?:Research source|Capability source|Route source|Budget source|Live signal dashboard|Live readiness dashboard|[A-Z][\w -]{2,30}: use (?:an? )?(?:explore|browser) session)\b/i.test(
        line,
      ),
    ).length;
  return sourceLineCount >= 3 ? sourceLineCount : 0;
}

export function isTwoSourceComparisonTask(taskPrompt: string): boolean {
  if (uniqueHttpUrlCount(taskPrompt) !== 2) return false;
  return (
    /\b(?:compare|comparison|between|versus|vs\.?|tradeoff|recommendation)\b/i.test(taskPrompt) ||
    /\b(?:review|check|inspect|fetch|extract)\b[\s\S]{0,120}\b(?:two|2)\b[\s\S]{0,80}\b(?:source pages?|sources?|urls?)\b/i.test(
      taskPrompt,
    ) ||
    /比较|对比|两个来源|两个页面|两个\s*URL/i.test(taskPrompt)
  );
}

export function uniqueHttpUrlCount(text: string): number {
  return new Set(extractHttpUrls(text)).size;
}

export function countCompletedSessionEvidenceResults(
  toolTrace: NativeToolRoundTrace[],
): number {
  const completedSessionKeys = new Set<string>();
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      if (!result.content) {
        continue;
      }
      const parsed = parseSessionToolResult(result.content);
      if (
        !parsed ||
        parsed.status !== "completed" ||
        !readCompletedSessionEvidence(parsed)
      ) {
        continue;
      }
      completedSessionKeys.add(parsed.session_key);
    }
  }
  return completedSessionKeys.size;
}

export function enforceSupplementalLocalTimeoutProbeToolCall(
  toolCalls: LLMToolCall[],
  messages: LLMMessage[],
): LLMToolCall[] {
  const latest = messages.at(-1);
  const latestText =
    latest?.role === "user" ? readMessageContentText(latest.content) : "";
  if (
    !latestText.includes(
      "Runtime correction: resumed timeout evidence is still content-poor.",
    )
  ) {
    return toolCalls;
  }
  const selected =
    toolCalls.find(
      (call) => call.name === "sessions_spawn" || call.name === "sessions_send",
    ) ?? toolCalls[0];
  const selectedText =
    selected?.name === "sessions_spawn"
      ? readStringInput(selected.input, "task")
      : selected?.name === "sessions_send"
        ? readStringInput(selected.input, "message")
        : null;
  const url =
    extractHttpUrls(latestText).find((candidate) => {
      try {
        return isLoopbackHostname(new URL(candidate).hostname);
      } catch {
        return false;
      }
    }) ?? extractHttpUrls(latestText)[0];
  return [
    {
      id: selected?.id ?? "runtime-supplemental-local-timeout-probe",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label:
          (selected ? readStringInput(selected.input, "label") : undefined) ??
          "supplemental local timeout probe",
        timeout_seconds: SUPPLEMENTAL_LOCAL_TIMEOUT_PROBE_TIMEOUT_SECONDS,
        task: [
          "Use private browser page tools for browser-visible/local runtime evidence; do not spawn or continue another session.",
          `Supplemental local timeout probe mode: call browser_open with timeout_ms ${SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS} and then stop with observed evidence or explicit unavailable fields.`,
          selectedText,
          url
            ? `Open ${url} as an operator would see it with a bounded local-runtime attempt.`
            : "Open the loopback URL from the parent correction with a bounded local-runtime attempt.",
          "Return only observed evidence: final URL, title, visible marker/text, loading completion, console/network failures if available, screenshot/artifact references if captured, and any remaining unverified items.",
          "If the page still does not produce evidence, report that status/body/header/rendered content remain unavailable and keep the release-risk conclusion source-bounded.",
        ]
          .filter(
            (part): part is string =>
              typeof part === "string" && part.trim().length > 0,
          )
          .join("\n\n"),
      },
    },
  ];
}

export function readCompletedSessionEvidence(
  parsed: NonNullable<ReturnType<typeof parseSessionToolResult>>,
): string | null {
  if (typeof parsed.final_content === "string" && parsed.final_content.trim()) {
    const finalContent = parsed.final_content.trim();
    if (parsed.agent_id === "browser") {
      const browserEvidence = [
        parsed.evidence_summary,
        finalContent,
        parsed.result,
      ]
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .map((item) => item.trim());
      return dedupeStrings(browserEvidence).join("\n\n");
    }
    const payload = parsed.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const mode = (payload as Record<string, unknown>)["mode"];
        if (mode === "llm_sub_agent") {
          return [finalContent, readBrowserFailureBucketSummary(payload as Record<string, unknown>)]
            .filter((item): item is string => Boolean(item))
            .join("\n\n");
        }
      }
  }
  const evidence = [parsed.result, parsed.evidence_summary]
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
  return evidence.length > 0 ? [...new Set(evidence)].join("\n\n") : null;
}

export function readBrowserFailureBucketSummary(payload: Record<string, unknown>): string | null {
  const buckets = normalizeBrowserFailureBucketRecords(payload["failureBuckets"]);
  const recovery = payload["browserRecovery"];
  if (recovery && typeof recovery === "object" && !Array.isArray(recovery)) {
    buckets.push(...normalizeBrowserFailureBucketRecords((recovery as Record<string, unknown>)["failureBuckets"]));
  }
  if (buckets.length === 0) {
    return null;
  }
  const merged = new Map<string, number>();
  for (const bucket of buckets) {
    merged.set(bucket.bucket, (merged.get(bucket.bucket) ?? 0) + bucket.count);
  }
  return `Browser failure buckets: ${[...merged.entries()]
    .map(([bucket, count]) => `${bucket}=${count}`)
    .sort()
    .join(", ")}.`;
}

export function normalizeBrowserFailureBucketRecords(value: unknown): Array<{ bucket: string; count: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const bucket = record["bucket"];
    const count = record["count"];
    if (typeof bucket !== "string" || !bucket.trim()) {
      return [];
    }
    return [{ bucket: bucket.trim(), count: typeof count === "number" && Number.isFinite(count) ? count : 1 }];
  });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasPermissionGateEvidence(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some(
    (round) =>
      round.calls.some((call) => call.name.startsWith("permission_")) ||
      (round.progress ?? []).some((progress) => {
        const eventType = progress.detail?.["eventType"];
        return (
          typeof eventType === "string" && eventType.startsWith("permission.")
        );
      }),
  );
}

export function shouldSuppressReadOnlyPermissionQueryToolCalls(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string; sessionContext: string },
): boolean {
  return toolCalls.some((call) => {
    if (call.name !== "permission_query") {
      return false;
    }
    const callText = stableJson(normalizeToolInputForSignature(call.input));
    return (
      isSourceBackedReadOnlyTask(context.taskPrompt) ||
      isClearlyUnrequestedReadOnlyPermissionQuery(callText, context.taskPrompt) ||
      disclaimsIntendedBrowserMutation(callText) ||
      (disclaimsIntendedBrowserMutation(context.taskPrompt) &&
        !requestsApprovalGatedBrowserAction(context.taskPrompt))
    );
  });
}

function isSourceBackedReadOnlyTask(taskPrompt: string): boolean {
  const sourceReadOnlyTask =
    /\b(?:read[- ]only|source-backed|source backed|provider|pricing|price|search\/web_search|web_search|extract|evidence source|listed sources?|research note|api provider)\b/i.test(
      taskPrompt,
    );
  if (!sourceReadOnlyTask) {
    return false;
  }
  return !/\b(?:submit|submission|form|click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in|mutat(?:e|ion)|side[- ]effect|dry[- ]run)\b/i.test(
    taskPrompt,
  );
}

function isClearlyUnrequestedReadOnlyPermissionQuery(
  callText: string,
  taskPrompt: string,
): boolean {
  if (taskAllowsPermissionTools(taskPrompt)) {
    return false;
  }
  if (!/\b(?:browser\.form\.submit|form submission|approval-gated browser form submission)\b/i.test(callText)) {
    return false;
  }
  const sourceReadOnlyTask =
    isSourceBackedReadOnlyTask(taskPrompt);
  return sourceReadOnlyTask;
}

export function buildReadOnlyPermissionQuerySuppressionPrompt(): string {
  return [
    "Runtime correction: read-only browser inspection does not require approval.",
    "The previous permission_query describes no intended form submission, mutation, or side effect, so it must not enter the native approval flow.",
    "Do not call permission_query, permission_result, permission_applied, or browser mutation tools.",
    "Produce the final answer from completed evidence. If any requested item remains unverified, state it explicitly and give the safe next action.",
  ].join("\n");
}

export function taskAllowsPermissionTools(taskPrompt: string): boolean {
  if (disclaimsApprovalGatedBrowserAction(taskPrompt)) {
    return false;
  }
  return (
    /\b(?:permission_(?:query|result|applied)|permission\.(?:query|result|applied)|approval_id|approval id|pending approval|operator approval|operator decision|approval (?:gate|request|decision|granted|approved|denied|applied)|approved action|denied action)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:approve|approved|approval|permission|operator review)\b[\s\S]{0,180}\b(?:submit|submission|form|click|mutat(?:e|ion)|side[- ]effects?|browser\.form\.submit|apply|execute|dry[- ]run)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:submit|submission|form|click|mutat(?:e|ion)|side[- ]effects?|browser\.form\.submit|apply|execute|dry[- ]run)\b[\s\S]{0,180}\b(?:approve|approved|approval|permission|operator review)\b/i.test(
      taskPrompt,
    )
  );
}

export function hasMissingApprovalGateRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval-gated browser action",
      ),
  );
}

export function taskPromptSaysApprovalAlreadyApplied(taskPrompt: string): boolean {
  return /\b(?:runtime\s+)?permission cache\b[\s\S]{0,120}\balready applied\b|\bpermission\.applied\b|\bpermission_applied\b/i.test(
    taskPrompt,
  );
}

export function requestsApprovalGatedBrowserAction(taskPrompt: string): boolean {
  if (disclaimsApprovalGatedBrowserAction(taskPrompt)) {
    return false;
  }
  return (
    /\bapproval\b/i.test(taskPrompt) &&
    /\bbrowser\b/i.test(taskPrompt) &&
    looksApprovalGatedBrowserSideEffect(taskPrompt) &&
    browserSpawnPerformsMutatingAction(taskPrompt)
  );
}

export function disclaimsApprovalGatedBrowserAction(taskPrompt: string): boolean {
  if (
    /\b(?:not\s+(?:a\s+)?form submission|not\s+(?:a\s+)?browser mutation|do not mutate|don't mutate|without mutat(?:ing|ion)|no browser mutation|no form submission)\b/i.test(
      taskPrompt,
    )
  ) {
    return true;
  }
  if (!/\bread[- ]only\b/i.test(taskPrompt)) {
    return false;
  }
  return (
    /\bno\b[^.\n]{0,180}\b(?:browser\s+)?(?:form|click|navigation|submit|submission|mutation|side[- ]effect|approval[- ]gated action)\b[^.\n]{0,120}\b(?:needed|required|necessary|will be performed|should run|is needed)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:do\s+not|don't|never)\b[^.\n]{0,180}\b(?:click|submit|submission|form|deposit|purchase|buy|order|book|reserve|save|update|delete|remove|archive|mutat(?:e|ion)|side[- ]effect|request approval|approval)\b/i.test(
      taskPrompt,
    )
  );
}

export function taskRequestsTimeoutFollowupContinuation(taskPrompt: string): boolean {
  const timeoutSourceRequest = /\b(?:slow source|bounded attempt|source does not return|doesn't return|timed out|timeout|earlier timeout|previous timeout|prior timeout)\b/i.test(
    taskPrompt,
  );
  const continuationRequest = /\b(?:follow-up|followup|resume|continue|continuation|same source-check context|same source check context|existing source-check context|existing source check context)\b/i.test(
    taskPrompt,
  );
  const explicitHowToContinue = /\b(?:explain how|describe how|state how|say how)\b[\s\S]{0,120}\b(?:mission|work|source-check|source check)\b[\s\S]{0,80}\b(?:continue|resume|retry)\b/i.test(
    taskPrompt,
  );
  const resumeAfterTimeout = /\b(?:resume|continue)\b[\s\S]{0,160}\b(?:existing|same)\b[\s\S]{0,120}\b(?:source-check|source check|context)\b[\s\S]{0,220}\b(?:earlier|previous|prior)?\s*timeout\b|\b(?:earlier|previous|prior)\s*timeout\b[\s\S]{0,220}\b(?:limits?|conclusion|resume|continue|retry|source-check|source check)\b/i.test(
    taskPrompt,
  );
  return (
    timeoutSourceRequest &&
    continuationRequest &&
    (explicitHowToContinue || resumeAfterTimeout)
  );
}

export function readMessageContentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) return String(block.text);
        if (block.type === "tool_result" && "content" in block)
          return String(block.content);
      }
      return "";
    })
    .join("\n");
}

export function findSessionContinuationDirective(
  taskPrompt: string,
): SessionContinuationDirective | null {
  let latestUserText = extractLatestUserContinuationText(taskPrompt);
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    if (!shouldForceSlowSourceRecoveryContinuation(taskPrompt)) {
      return null;
    }
    latestUserText =
      "Continue the same slow-source source-check context after the previous timeout. Resume the existing source-check session.";
  }
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    return null;
  }
  const messageHint = buildSessionContinuationMessageHint(
    taskPrompt,
    latestUserText,
  );
  const sessionResults = extractSessionToolResultRecords(taskPrompt);
  let selectedSessionKey: string | null = null;
  let selectedPriority = 0;
  const preferEarliestSession =
    continuationRequestPrefersEarliestSession(latestUserText);
  for (let index = sessionResults.length - 1; index >= 0; index -= 1) {
    const result = sessionResults[index]!;
    const sessionKey = result["session_key"];
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      continue;
    }
    const priority = sessionToolResultContinuationPriority(
      result,
      latestUserText,
    );
    if (priority <= selectedPriority) {
      if (
        !(
          preferEarliestSession &&
          selectedSessionKey &&
          priority === selectedPriority
        )
      ) {
        continue;
      }
    }
    if (!preferEarliestSession && priority <= selectedPriority) {
      continue;
    }
    selectedSessionKey = sessionKey.trim();
    selectedPriority = priority;
  }
  if (selectedSessionKey) {
    const listedResolvedSessionKey = resolveListedSessionKeyFromPrefix(
      taskPrompt,
      selectedSessionKey,
    );
    if (listedResolvedSessionKey) {
      return { sessionKey: listedResolvedSessionKey, messageHint };
    }
    if (
      extractLikelyTruncatedTimeoutSessionKeyPrefixes(
        taskPrompt,
        latestUserText,
      ).some(
        (prefix) =>
          relaxedSessionKeySignature(selectedSessionKey).startsWith(prefix) ||
          prefix.startsWith(relaxedSessionKeySignature(selectedSessionKey)),
      )
    ) {
      return null;
    }
    if (
      selectedPriority < 3 &&
      continuationRequestPrefersResumableSession({
        latestUserText,
        context: taskPrompt,
      })
    ) {
      return null;
    }
    return { sessionKey: selectedSessionKey, messageHint };
  }
  const explicitSessionKey = selectExplicitContinuationSessionKey(
    taskPrompt,
    latestUserText,
  );
  if (explicitSessionKey) {
    return { sessionKey: explicitSessionKey, messageHint };
  }
  const listedSession = selectListedContinuationSessionKey(
    taskPrompt,
    latestUserText,
  );
  const hasTruncatedTimeoutCandidate =
    contextHasTruncatedTimeoutContinuationCandidate(taskPrompt, latestUserText);
  if (
    listedSession &&
    !(hasTruncatedTimeoutCandidate && listedSession.priority < 3)
  ) {
    return { sessionKey: listedSession.sessionKey, messageHint };
  }
  if (hasTruncatedTimeoutCandidate) {
    return null;
  }
  const sessionMatches = [
    ...taskPrompt.matchAll(/"session_key"\s*:\s*"([^"]+)"/g),
  ];
  for (let index = sessionMatches.length - 1; index >= 0; index -= 1) {
    const match = sessionMatches[index]!;
    const sessionKey = match[1];
    if (!sessionKey) continue;
    const start = Math.max(0, (match.index ?? 0) - 1200);
    const end = Math.min(taskPrompt.length, (match.index ?? 0) + 1200);
    const context = taskPrompt.slice(start, end);
	    if (!sessionContextSupportsContinuation(context)) {
	      continue;
	    }
	    const priority = explicitSessionContinuationPriority(
	      sessionKey,
	      context,
	      latestUserText,
	    );
	    if (
	      priority <= 0 ||
	      (priority < 3 &&
	        continuationRequestPrefersResumableSession({
	          latestUserText,
	          context: taskPrompt,
	        }))
	    ) {
	      continue;
	    }
	    return {
	      sessionKey,
	      messageHint,
	    };
  }
  return null;
}

export function continuationRequestPrefersEarliestSession(
  latestUserText: string,
): boolean {
  return /\b(?:previous|prior|earlier|original|initial|same)\b[\s\S]{0,160}\b(?:thread|session|research|work|notes|context)\b|\b(?:rather than|instead of)\b[\s\S]{0,120}\b(?:starting|start)\b[\s\S]{0,80}\bfrom scratch\b/i.test(
    latestUserText,
  );
}

export function continuationRequestPrefersResumableSession(input: {
  latestUserText: string;
  context: string;
}): boolean {
  if (
    /\b(?:timeout|timed out|resumable|interrupted|cancelled|canceled|slow-source|slow source|source-check)\b/i.test(
      input.latestUserText,
    )
  ) {
    return true;
  }
  if (
    !/\b(?:timeout|timed out|WORKER_TIMEOUT|resumable|interrupted|cancelled|canceled)\b/i.test(
      input.context,
    )
  ) {
    return false;
  }
  return /\b(?:same|existing|previous|prior|attempt|source|retry|resume|continue)\b/i.test(
    input.latestUserText,
  );
}

export function findSessionContinuationLookupDirective(
  taskPrompt: string,
  context: string,
): SessionContinuationLookupDirective | null {
  let latestUserText = extractLatestUserContinuationText(taskPrompt);
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    if (!shouldForceSlowSourceRecoveryContinuation(context)) {
      return null;
    }
    latestUserText =
      "Continue the same slow-source source-check context after the previous timeout. Resume the existing source-check session.";
  }
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    return null;
  }
  if (contextHasSessionListResult(context)) {
    return contextHasTruncatedTimeoutContinuationCandidate(
      context,
      latestUserText,
    )
      ? {
          messageHint: buildSessionContinuationMessageHint(
            taskPrompt,
            latestUserText,
          ),
        }
      : null;
  }
  return {
    messageHint: buildSessionContinuationMessageHint(
      taskPrompt,
      latestUserText,
    ),
  };
}

export function shouldForceSlowSourceRecoveryContinuation(context: string): boolean {
  return (
    /\bSystem recovery:\s*the previous final answer did not satisfy required goal slots\b/i.test(
      context,
    ) &&
    taskPromptLooksLikeSourceCheckContinuation(context) &&
    contextHasTimeoutSessionResult(context) &&
    /\b(?:Resume or retry the same slow source-check context|same source-check context|required release-risk slots|release-risk slots)\b/i.test(
      context,
    )
  );
}

export function buildContinuationDirectiveContext(
  taskPrompt: string,
  messages: LLMMessage[],
): string {
  const toolEvidence = messages
    .filter((message) => message.role === "tool")
    .map((message) => llmMessageContentToText(message.content))
    .filter(
      (content) =>
        content.includes("session_key") || content.includes('"sessions"'),
    )
    .join("\n");
  return toolEvidence ? `${taskPrompt}\n${toolEvidence}` : taskPrompt;
}

export function llmMessageContentToText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return block.content;
      }
      if (block.type === "tool_use") {
        return JSON.stringify({ name: block.name, input: block.input });
      }
      return "";
    })
    .join("\n");
}

export function sessionContextSupportsContinuation(context: string): boolean {
  if (
    /\b(timeout|timed out|WORKER_TIMEOUT|resumable|interrupted|cancelled|canceled)\b/i.test(
      context,
    )
  ) {
    return true;
  }
  if (contextHasListedContinuableSession(context)) {
    return true;
  }
  for (const result of extractSessionToolResultRecords(context)) {
    if (sessionToolResultSupportsContinuation(result)) {
      return true;
    }
  }
  return false;
}

export function contextHasTimeoutSessionResult(context: string): boolean {
  return extractSessionToolResultRecords(context).some(
    (result) => result["status"] === "timeout",
  );
}

export function contextHasSessionListResult(context: string): boolean {
  return parseJsonObjectsFromContext(context).some((parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Array.isArray((parsed as Record<string, unknown>)["sessions"]);
  });
}

export function contextHasListedContinuableSession(context: string): boolean {
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    if (
      sessions.some((session) => {
        if (!session || typeof session !== "object" || Array.isArray(session)) {
          return false;
        }
        const record = session as Record<string, unknown>;
        const status = record["status"];
        return (
          typeof record["session_key"] === "string" &&
          typeof status === "string" &&
          /^(?:done|completed|resumable|timeout|cancelled|failed)$/.test(status)
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

export function selectListedContinuationSessionKey(
  context: string,
  latestUserText: string,
): { sessionKey: string; priority: number } | null {
  let selected: {
    sessionKey: string;
    priority: number;
    lastActiveAt: number;
  } | null = null;
  const truncatedTimeoutPrefixes =
    extractLikelyTruncatedTimeoutSessionKeyPrefixes(context, latestUserText);
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    for (const session of sessions) {
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        continue;
      }
      const record = session as Record<string, unknown>;
      const sessionKey =
        typeof record["session_key"] === "string"
          ? record["session_key"].trim()
          : "";
      let priority = listedSessionContinuationPriority(
        record,
        latestUserText,
      );
      if (
        sessionKey &&
        truncatedTimeoutPrefixes.some((prefix) =>
          relaxedSessionKeySignature(sessionKey).startsWith(prefix),
        )
      ) {
        priority = Math.max(priority, 6);
      }
      if (!sessionKey || priority <= 0) {
        continue;
      }
      const lastActiveAt =
        typeof record["last_active_at"] === "number"
          ? record["last_active_at"]
          : 0;
      if (
        !selected ||
        priority > selected.priority ||
        (priority === selected.priority &&
          lastActiveAt >= selected.lastActiveAt)
      ) {
        selected = { sessionKey, priority, lastActiveAt };
      }
    }
  }
  return selected
    ? { sessionKey: selected.sessionKey, priority: selected.priority }
    : null;
}

export function resolveListedSessionKeyFromPrefix(
  context: string,
  sessionKey: string,
): string | null {
  const signature = relaxedSessionKeySignature(sessionKey);
  if (signature.length < 24) {
    return null;
  }
  const matches: string[] = [];
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    for (const session of sessions) {
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        continue;
      }
      const candidate = (session as Record<string, unknown>)["session_key"];
      if (typeof candidate !== "string" || !candidate.trim()) {
        continue;
      }
      const candidateSignature = relaxedSessionKeySignature(candidate.trim());
      if (candidateSignature === signature) {
        return candidate.trim();
      }
      if (candidateSignature.startsWith(signature)) {
        matches.push(candidate.trim());
      }
    }
  }
  return [...new Set(matches)].length === 1 ? matches[0]! : null;
}

export function extractLikelyTruncatedTimeoutSessionKeyPrefixes(
  context: string,
  latestUserText: string,
): string[] {
  if (
    !continuationRequestPrefersResumableSession({
      latestUserText,
      context,
    }) ||
    !/\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(context)
  ) {
    return [];
  }
  const prefixes: string[] = [];
  const matches = [
    ...context.matchAll(
      /(?:"session_key"\s*:\s*"|session not found:\s*)(worker:[A-Za-z0-9_-]+:task(?::|-)[^\s"',|}\]\n]+)/gi,
    ),
  ];
  for (const match of matches) {
    const rawKey = match[1]?.trim();
    if (!rawKey) continue;
    const matchedText = match[0] ?? "";
    const ellipsized = /…|\.{3}/.test(rawKey);
    const notFoundPrefix = /^session not found:/i.test(matchedText);
    const likelyToolCallPrefix =
      /\bcall_(?:function_|func_)?[A-Za-z0-9]+$/i.test(rawKey) &&
      !/_\d+$/.test(rawKey);
    if (!ellipsized && !notFoundPrefix && !likelyToolCallPrefix) {
      continue;
    }
    const signature = relaxedSessionKeySignature(rawKey);
    const ellipsizedPrefix = readTruncatedSessionKeyPrefix(signature);
    const prefix = ellipsizedPrefix ?? (signature.length >= 24 ? signature : null);
    if (prefix) {
      prefixes.push(prefix);
    }
  }
  return [...new Set(prefixes)];
}

export function selectExplicitContinuationSessionKey(
  context: string,
  latestUserText: string,
): string | null {
  let selected: { sessionKey: string; priority: number; index: number } | null =
    null;
  const matches = [
    ...context.matchAll(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/g),
  ];
  for (const match of matches) {
    const sessionKey = match[0];
    if (!sessionKey || /(?:…|\.{3})/.test(sessionKey)) {
      continue;
    }
    const index = match.index ?? 0;
    const local = context.slice(
      Math.max(0, index - 800),
      Math.min(context.length, index + 800),
    );
    if (
      /"session_key"\s*:\s*"/.test(
        context.slice(Math.max(0, index - 40), index),
      )
    ) {
      continue;
    }
    const priority = explicitSessionContinuationPriority(
      sessionKey,
      local,
      latestUserText,
    );
    if (priority <= 0) {
      continue;
    }
    if (
      !selected ||
      priority > selected.priority ||
      (priority === selected.priority && index > selected.index)
    ) {
      selected = { sessionKey, priority, index };
    }
  }
  return selected?.sessionKey ?? null;
}

export function explicitSessionContinuationPriority(
  sessionKey: string,
  localContext: string,
  latestUserText: string,
): number {
  if (
    !/\b(?:resume|continue|continuation|timed out|timeout|resumable|interrupted|source-check|source check)\b/i.test(
      localContext,
    )
  ) {
    return 0;
  }
  let priority = 1;
  const agentId = inferWorkerKindFromSessionKey(sessionKey) ?? "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  if (/\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(localContext)) {
    priority += 3;
  }
  if (
    /\b(?:resume|continue|continuation|same|existing)\b/i.test(localContext)
  ) {
    priority += 2;
  }
  if (
    agentId === "explore" &&
    /\b(?:slow-source|slow source|source-check|source check|source|research|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 3;
  }
  if (
    agentId === "browser" &&
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(latestUserText)
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  return priority;
}

export function listedSessionContinuationPriority(
  record: Record<string, unknown>,
  latestUserText: string,
): number {
  const status = typeof record["status"] === "string" ? record["status"] : "";
  const agentId =
    typeof record["agent_id"] === "string" ? record["agent_id"] : "";
  const label = typeof record["label"] === "string" ? record["label"] : "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  let priority = 0;
  if (status === "timeout") {
    priority = 5;
  } else if (
    status === "resumable" ||
    status === "waiting_input" ||
    status === "waiting_external"
  ) {
    priority = 3;
  } else if (status === "cancelled" || status === "canceled") {
    priority = 3;
  } else if (
    status === "failed" &&
    /\b(?:continue|resume|retry|cancelled|canceled|source-check|source check|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    priority = 2;
  } else if (status === "done" || status === "completed") {
    priority = 1;
  }
  if (priority === 0) {
    return 0;
  }
  const relevanceText = `${agentId} ${label}`;
  if (
    /\b(?:slow-source|slow source|source-check|source check|source|research|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    if (agentId === "explore") {
      priority += 3;
    }
    if (/\b(?:slow|source|fetch|research|risk)\b/i.test(label)) {
      priority += 2;
    }
  }
  if (
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(
      latestUserText,
    ) &&
    agentId === "browser"
  ) {
    priority += 2;
  }
  if (
    /\b(?:slow-source|slow source|source-check|source check)\b/i.test(
      latestUserText,
    ) &&
    /\bbrowser\b/i.test(relevanceText)
  ) {
    priority -= 1;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  if (continuationTextMatchesSubject(relevanceText, latestUserText)) {
    priority += 4;
  }
  return priority;
}

export function contextHasTruncatedTimeoutContinuationCandidate(
  context: string,
  latestUserText: string,
): boolean {
  if (
    !continuationRequestPrefersResumableSession({
      latestUserText,
      context,
    })
  ) {
    return false;
  }
  const truncatedWorkerKey =
    /"session_key"\s*:\s*"worker:[^"]*(?:…|\.{3})[^"]*"/i;
  if (!truncatedWorkerKey.test(context)) {
    return false;
  }
  return /\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(context);
}

export function extractSessionToolResultRecords(
  context: string,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const parsed of parseJsonObjectsFromContext(context)) {
    collectSessionToolResultRecords(parsed, records);
  }
  return records;
}

export function collectSessionToolResultRecords(
  value: unknown,
  records: Array<Record<string, unknown>>,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const result = value as Record<string, unknown>;
  if (result["protocol"] === SESSION_TOOL_RESULT_PROTOCOL) {
    records.push(result);
  }
  for (const key of ["content", "resultContent"]) {
    const nested = result[key];
    if (
      typeof nested !== "string" ||
      !nested.includes(SESSION_TOOL_RESULT_PROTOCOL)
    ) {
      continue;
    }
    for (const parsed of parseJsonObjectsFromContext(nested)) {
      collectSessionToolResultRecords(parsed, records);
    }
  }
}

export function sessionToolResultSupportsContinuation(
  result: Record<string, unknown>,
): boolean {
  return sessionToolResultContinuationPriority(result) > 0;
}

export function sessionToolResultContinuationPriority(
  result: Record<string, unknown>,
  latestUserText = "",
): number {
  if (result["protocol"] !== SESSION_TOOL_RESULT_PROTOCOL) {
    return 0;
  }
  let priority = 0;
  if (
    result["status"] === "timeout" ||
    result["status"] === "cancelled" ||
    result["resumable"] === true
  ) {
    priority = result["status"] === "timeout" ? 4 : 3;
  } else if (result["status"] === "completed") {
    priority = 1;
  }
  if (priority === 0) {
    return 0;
  }
  const agentId =
    typeof result["agent_id"] === "string" ? result["agent_id"] : "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  if (
    result["status"] === "timeout" &&
    /\b(?:timeout|timed out|slow-source|slow source|source-check|source check)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 3;
  }
  if (
    agentId === "explore" &&
    /\b(?:slow-source|slow source|source-check|source check|source|research)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(latestUserText)
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  if (
    result["status"] === "cancelled" &&
    /\b(?:cancelled|canceled)\b/i.test(latestUserText)
  ) {
    priority += 3;
  }
  if (
    continuationTextMatchesSubject(
      sessionToolResultRelevanceText(result),
      latestUserText,
    )
  ) {
    priority += 4;
  }
  return priority;
}

export function continuationRequestTargetsResearchThread(latestUserText: string): boolean {
  return /\b(?:research|source|vendor|provider|notes|thread|work|evidence|comparison)\b|研究|来源|供应商|证据|对比|比较/i.test(
    latestUserText,
  );
}

export function continuationRequestTargetsBrowser(latestUserText: string): boolean {
  return /\b(?:browser|dashboard|page|tab|rendered|visual|screenshot|form|submit)\b|浏览器|页面|仪表盘|截图|渲染/i.test(
    latestUserText,
  );
}

export function continuationRequestRequiresBrowserEvidence(
  latestUserText: string,
): boolean {
  return /\b(?:rendered browser evidence|browser[- ]rendered evidence|browser-visible evidence|browser visible evidence|rendered evidence|browser evidence|visible page evidence|screenshot|snapshot)\b|浏览器证据|渲染证据|页面可见证据|截图|快照/i.test(
    latestUserText,
  );
}

export function sessionToolResultRelevanceText(
  result: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const key of [
    "agent_id",
    "label",
    "result",
    "final_content",
    "summary",
    "task",
  ]) {
    const value = result[key];
    if (typeof value === "string") {
      parts.push(value);
    }
  }
  const payload = result["payload"];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of ["label", "summary", "content", "result"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string") {
        parts.push(value);
      }
    }
  }
  return parts.join("\n");
}

export function continuationTextMatchesSubject(
  candidateText: string,
  latestUserText: string,
): boolean {
  const candidate = candidateText.toLowerCase();
  if (!candidate.trim()) return false;
  return continuationSubjectPhrases(latestUserText).some((phrase) =>
    candidate.includes(phrase.toLowerCase()),
  );
}

export function continuationSubjectPhrases(text: string): string[] {
  const phrases = new Set<string>();
  for (const match of text.matchAll(/[`"“]([^`"”]{3,80})[`"”]/g)) {
    addContinuationSubjectPhrase(phrases, match[1] ?? "");
  }
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z][A-Za-z0-9]*)+\b/g)) {
    addContinuationSubjectPhrase(phrases, match[0]);
  }
  for (const match of text.matchAll(/\b(?:Vendor|Provider|Project|Source|Researcher|Team|Customer)\s+[A-Z][A-Za-z0-9_-]+\b/g)) {
    addContinuationSubjectPhrase(phrases, match[0]);
  }
  return [...phrases];
}

export function addContinuationSubjectPhrase(
  phrases: Set<string>,
  rawPhrase: string,
): void {
  const phrase = rawPhrase
    .replace(/\b(?:same|previous|prior|existing|earlier|research|thread|notes|work|source|session)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (phrase.length < 4) return;
  if (/^(?:continue|resume|revisit|follow up|product lead)$/i.test(phrase)) {
    return;
  }
  if (phrase.split(/\s+/).length > 6) return;
  phrases.add(phrase);
}

export function parseJsonObjectsFromContext(context: string): unknown[] {
  const parsed: unknown[] = [];
  for (let index = 0; index < context.length; index += 1) {
    if (context[index] !== "{") {
      continue;
    }
    const end = findJsonObjectEnd(context, index);
    if (end === null) {
      continue;
    }
    try {
      parsed.push(JSON.parse(context.slice(index, end + 1)));
      index = end;
    } catch {
      // The context window may start or end inside a JSON blob. Keep scanning
      // for the next balanced object instead of falling back to raw status text.
    }
  }
  return parsed;
}

export function findJsonObjectEnd(context: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < context.length; index += 1) {
    const char = context[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

export function isExplicitSessionContinuationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (
    !/\b(continue|continuation|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /\b(?:follow-?up|later|afterward|afterwards|future)\b.{0,120}\b(?:may|might|can|could|should)\s+(?:ask|request)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /\b(?:may|might|can|could|should)\s+(?:ask|request)\b.{0,120}\b(?:continue|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^(?:please\s+)?(?:continue|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return /\b(?:continue|resume|retry|revisit)\s+(?:from|the|that|this|same|existing|previous|prior)\b/i.test(
    normalized,
  );
}

export function extractLatestUserContinuationText(taskPrompt: string): string {
  const verbatimDirection = extractVerbatimGoalDirection(taskPrompt);
  if (verbatimDirection) {
    return sliceUtf8(
      verbatimDirection.replace(/\s+/g, " ").trim(),
      1200,
    );
  }
  const lines = taskPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const latestUserLine = [...lines]
    .reverse()
    .find((line) => /^\[?user\]?(?:[:：]|\s+)/i.test(line));
  const hasSessionContinuationContext =
    extractSessionToolResultRecords(taskPrompt).length > 0 ||
    /"session_key"\s*:|worker:[A-Za-z0-9_-]+:task(?::|-)/.test(taskPrompt);
  const continuationLineIndex = latestUserLine
    ? -1
    : !hasSessionContinuationContext
      ? -1
    : (() => {
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          if (isExplicitSessionContinuationRequest(lines[index]!)) {
            return index;
          }
        }
        return -1;
      })();
  const content = latestUserLine
    ? latestUserLine.replace(/^\[?user\]?(?:[:：]|\s+)\s*/i, "")
    : continuationLineIndex >= 0
      ? lines.slice(continuationLineIndex).join("\n")
    : (lines.at(-1) ?? taskPrompt);
  return sliceUtf8(
    content.replace(/\s+/g, " ").trim() ||
      "Continue the same delegated work from the existing session.",
    1200,
  );
}

export function extractVerbatimGoalDirection(taskPrompt: string): string | null {
  const latest = extractVerbatimGoalSection(
    taskPrompt,
    "Latest user direction",
  );
  if (latest) {
    return latest;
  }
  return extractVerbatimGoalSection(taskPrompt, "Original user goal");
}

export function extractVerbatimGoalSection(
  taskPrompt: string,
  sectionLabel: "Latest user direction" | "Original user goal",
): string | null {
  const match = taskPrompt.match(
    new RegExp(
      `(?:^|\\n)\\s*${escapeRegExp(sectionLabel)}\\s*\\(verbatim\\):\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:Latest user direction|Original user goal)\\s*\\(verbatim\\):|\\n\\s*(?:\\[truncated\\]|The goal above is binding:|Task brief:|Recent turns:|Role scratchpad:|Retrieved memory:|Worker evidence:|Execution continuity:|Output contract:)\\b|$)`,
      "i",
    ),
  );
  const content = match?.[1]?.trim();
  return content ? content : null;
}

export function buildSessionContinuationMessageHint(
  taskPrompt: string,
  latestUserText: string,
): string {
  const priorContext = extractPriorContinuationContext(
    taskPrompt,
    latestUserText,
  );
  if (!priorContext) {
    return latestUserText;
  }
  return [
    latestUserText,
    "",
    "Continuation context from the original task:",
    priorContext,
    "",
    "Preserve the original task's decision criteria, required dimensions, entity names, source labels, and user terminology from that context unless the latest user message explicitly changes scope.",
  ].join("\n");
}

export function extractPriorContinuationContext(
  taskPrompt: string,
  latestUserText: string,
): string {
  const latestIndex = taskPrompt.lastIndexOf(latestUserText);
  const priorRaw =
    latestIndex > 0 ? taskPrompt.slice(0, latestIndex) : taskPrompt;
  const compact = priorRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[?tool\]?[:：\s]/i.test(line))
    .filter((line) => !line.includes(SESSION_TOOL_RESULT_PROTOCOL))
    .filter((line) => !/^\{.*"session_key".*\}$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sliceUtf8(compact, 1600);
}

export function applySessionContinuationDirective(
  toolCalls: LLMToolCall[],
  directive: SessionContinuationDirective | null,
): LLMToolCall[] {
  if (!directive || toolCalls.length === 0) {
    return toolCalls;
  }
  if (toolCalls.some((call) => call.name === "sessions_send")) {
    return toolCalls
      .filter((call) => call.name !== "sessions_spawn")
      .map((call) =>
        call.name === "sessions_send"
          ? {
              ...call,
              input: {
                ...call.input,
                session_key: directive.sessionKey,
                message: mergeSessionContinuationMessage(
                  directive,
                  readStringInput(call.input, "message"),
                ),
              },
            }
          : call,
      );
  }
  const continuationToolIndex = toolCalls.findIndex(
    (call) =>
      call.name === "sessions_spawn" ||
      call.name === "sessions_history" ||
      call.name === "sessions_list",
  );
  if (continuationToolIndex < 0) {
    return toolCalls;
  }
  const rewritten = toolCalls[continuationToolIndex]!;
  const proposedMessage =
    readStringInput(rewritten.input, "message") ??
    readStringInput(rewritten.input, "task") ??
    readStringInput(rewritten.input, "reason");
  return [
    ...toolCalls.slice(0, continuationToolIndex),
    {
      ...rewritten,
      name: "sessions_send",
      input: {
        session_key: directive.sessionKey,
        message: mergeSessionContinuationMessage(
          directive,
          proposedMessage,
        ),
        ...(readStringInput(rewritten.input, "label")
          ? { label: readStringInput(rewritten.input, "label") }
          : {}),
      },
    },
    ...toolCalls
      .slice(continuationToolIndex + 1)
      .filter((call) => call.name !== "sessions_spawn" && call.name !== "sessions_history" && call.name !== "sessions_list"),
  ];
}

export function mergeSessionContinuationMessage(
  directive: SessionContinuationDirective,
  proposedMessage: string | undefined,
): string {
  const proposed = proposedMessage?.trim();
  if (
    !proposed ||
    proposed === directive.messageHint ||
    proposed.includes("Continuation context from the original task")
  ) {
    return proposed || directive.messageHint;
  }
  if (
    !directive.messageHint.includes(
      "Continuation context from the original task",
    )
  ) {
    return proposed;
  }
  return [
    proposed,
    "",
    "Runtime continuity guard:",
    directive.messageHint,
  ].join("\n");
}

export function applySessionContinuationLookupDirective(
  toolCalls: LLMToolCall[],
  directive: SessionContinuationLookupDirective | null,
): LLMToolCall[] {
  if (!directive || toolCalls.length === 0) {
    return toolCalls;
  }
  const sendIndex = toolCalls.findIndex(
    (call) => call.name === "sessions_send",
  );
  if (sendIndex >= 0) {
    const sent = toolCalls[sendIndex]!;
    const agentId = inferWorkerKindFromSessionKey(
      readStringInput(sent.input, "session_key"),
    );
    return [
      ...toolCalls
        .slice(0, sendIndex)
        .filter(
          (call) =>
            call.name !== "sessions_spawn" && call.name !== "sessions_send",
        ),
      {
        ...sent,
        name: "sessions_list",
        input: {
          limit: 5,
          ...(agentId ? { agent_id: agentId, kinds: [agentId] } : {}),
          reason: `continuation lookup: ${directive.messageHint}`,
        },
      },
      ...toolCalls
        .slice(sendIndex + 1)
        .filter(
          (call) =>
            call.name !== "sessions_spawn" && call.name !== "sessions_send",
        ),
    ];
  }
  if (toolCalls.some((call) => call.name === "sessions_list")) {
    return toolCalls.filter((call) => call.name !== "sessions_spawn");
  }
  const spawnIndex = toolCalls.findIndex(
    (call) => call.name === "sessions_spawn",
  );
  if (spawnIndex < 0) {
    return toolCalls;
  }
  const spawned = toolCalls[spawnIndex]!;
  const agentId = readStringInput(spawned.input, "agent_id");
  return [
    ...toolCalls.slice(0, spawnIndex),
    {
      ...spawned,
      name: "sessions_list",
      input: {
        limit: 5,
        ...(agentId ? { agent_id: agentId, kinds: [agentId] } : {}),
        reason: `continuation lookup: ${directive.messageHint}`,
      },
    },
    ...toolCalls
      .slice(spawnIndex + 1)
      .filter((call) => call.name !== "sessions_spawn"),
  ];
}

export function inferWorkerKindFromSessionKey(sessionKey: unknown): string | null {
  if (typeof sessionKey !== "string") {
    return null;
  }
  const match = sessionKey.match(/^worker:([A-Za-z0-9_-]+):task(?::|-)/);
  return match?.[1] ?? null;
}

export const SESSION_SEND_ALIAS_NAMES = new Set([
  "session_continue",
  "session_resume",
  "session_update",
  "sessions_continue",
  "sessions_resume",
  "sessions_update",
]);

export function normalizeSessionToolAliasCalls(
  toolCalls: LLMToolCall[],
): LLMToolCall[] {
  return toolCalls.map((call) => {
    if (!SESSION_SEND_ALIAS_NAMES.has(call.name)) {
      return call;
    }
    const sessionKey =
      readStringInput(call.input, "session_key") ??
      readStringInput(call.input, "session") ??
      readStringInput(call.input, "session_id") ??
      readStringInput(call.input, "worker_session") ??
      readStringInput(call.input, "worker_session_key");
    const message =
      readStringInput(call.input, "message") ??
      readStringInput(call.input, "task") ??
      readStringInput(call.input, "instruction") ??
      readStringInput(call.input, "instructions") ??
      readStringInput(call.input, "update") ??
      readStringInput(call.input, "content") ??
      readStringInput(call.input, "query");
    return {
      ...call,
      name: "sessions_send",
      input: {
        ...call.input,
        ...(sessionKey ? { session_key: sessionKey } : {}),
        ...(message ? { message } : {}),
      },
    };
  });
}

export function normalizeSessionToolCalls(
  toolCalls: LLMToolCall[],
  sessionContext = "",
): LLMToolCall[] {
  const knownSessionKeys = extractKnownWorkerSessionKeys(sessionContext);
  return toolCalls.map((call) => {
    if (call.name !== "sessions_send" && call.name !== "sessions_history") {
      return call;
    }
    const sessionKey = readStringInput(call.input, "session_key");
    const extractedSessionKey = sessionKey
      ? extractWorkerSessionKey(sessionKey)
      : undefined;
    const normalizedSessionKey = extractedSessionKey
      ? resolveKnownWorkerSessionKey(extractedSessionKey, knownSessionKeys)
      : undefined;
    if (!normalizedSessionKey || normalizedSessionKey === sessionKey) {
      return call;
    }
    return {
      ...call,
      input: {
        ...call.input,
        session_key: normalizedSessionKey,
      },
    };
  });
}

export function normalizeExplicitContinuationHistoryCalls(
  toolCalls: LLMToolCall[],
  taskPrompt: string,
): LLMToolCall[] {
  if (
    !taskLooksLikeExplicitSessionContinuation(taskPrompt) ||
    taskRequestsSessionTranscript(taskPrompt)
  ) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (call.name !== "sessions_history") {
      return call;
    }
    const sessionKey = readSessionKeyFromToolInput(call.input);
    if (!sessionKey) {
      return call;
    }
    const proposedMessage =
      readStringInput(call.input, "message") ??
      readStringInput(call.input, "reason") ??
      readStringInput(call.input, "query");
    return {
      ...call,
      name: "sessions_send",
      input: {
        session_key: sessionKey,
        message:
          proposedMessage?.trim() ||
          [
            "Continue this existing sub-agent session for the user's follow-up.",
            "Let the source-check finish with the evidence it can collect, then return verified facts, unverified scope, residual risk, and how to continue if evidence is still incomplete.",
          ].join(" "),
      },
    };
  });
}

export function taskLooksLikeExplicitSessionContinuation(taskPrompt: string): boolean {
  return (
    taskRequestsTimeoutFollowupContinuation(taskPrompt) ||
    /\b(?:continue|resume|retry|follow[- ]?up)\b[\s\S]{0,180}\b(?:existing|same|previous|prior|earlier|source[- ]check|source check|session|attempt|context)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:existing|same|previous|prior|earlier)\b[\s\S]{0,180}\b(?:continue|resume|retry|follow[- ]?up)\b/i.test(
      taskPrompt,
    )
  );
}

export function normalizeLocalUrlWebFetchCalls(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string },
): LLMToolCall[] {
  return toolCalls.map((call) => {
    if (call.name !== "web_fetch") {
      return call;
    }
    const url =
      readStringInput(call.input, "url") ??
      readStringInput(call.input, "uri") ??
      readStringInput(call.input, "href");
    const inputText = [url, stableJson(call.input)].filter(Boolean).join("\n");
    if (!containsPrivateOrLoopbackHttpUrl(inputText)) {
      return call;
    }
    const targetUrl = url ?? extractHttpUrls(inputText)[0] ?? "";
    return {
      ...call,
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label: readStringInput(call.input, "label") ?? "local-url-fetch",
        task: [
          "Open the local/private URL as a browser-visible source instead of using web_fetch.",
          targetUrl ? `URL: ${targetUrl}` : null,
          "Extract only evidence visible from the page and preserve source-bounded residual risk.",
          context.taskPrompt ? `Parent task: ${context.taskPrompt}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      },
    };
  });
}

export function normalizePrivateUrlResearchSpawnCalls(
  toolCalls: LLMToolCall[],
  context: { browserAvailable: boolean; taskPrompt: string },
): LLMToolCall[] {
  if (!context.browserAvailable) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (
      call.name !== "sessions_spawn" ||
      readStringInput(call.input, "agent_id") !== "explore"
    ) {
      return call;
    }
    const task = readStringInput(call.input, "task") ?? "";
    const label = readStringInput(call.input, "label") ?? "";
    const combined = [task, label].join("\n");
    const targetsBrowserRequiredUrl = toolCallTargetsBrowserRequiredUrl({
      toolCallText: combined,
      taskPrompt: context.taskPrompt,
    });
    if (
      !containsPrivateOrLoopbackHttpUrl(combined) &&
      !targetsBrowserRequiredUrl
    ) {
      return call;
    }
    if (
      isLoopbackReadOnlySourceExploreTask({
        toolCallText: combined,
        taskPrompt: context.taskPrompt,
        targetsBrowserRequiredUrl,
      }) ||
      (allowsLoopbackExploreForE2E() &&
        containsLoopbackHttpUrl(combined) &&
        !containsPrivateNonLoopbackHttpUrl(combined) &&
        !taskRequiresBrowserEvidence(combined) &&
        !targetsBrowserRequiredUrl)
    ) {
      return call;
    }
    const reason = targetsBrowserRequiredUrl
      ? "Use the browser worker for this browser-visible URL source; do not use public-source fetch."
      : "Use the browser worker for this local/private URL source; do not use public-source fetch.";
    return {
      ...call,
      input: {
        ...call.input,
        agent_id: "browser",
        task: [
          reason,
          "Inspect the rendered page as the user would see it, extract only observed facts, and mark missing fields as not verified.",
          task,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  });
}

export function normalizeBoundedTimeoutSourceSpawnAgents(
  toolCalls: LLMToolCall[],
  context: { exploreAvailable: boolean; taskPrompt: string },
): LLMToolCall[] {
  if (
    !context.exploreAvailable ||
    !looksBoundedTimeoutSourceCheck(context.taskPrompt)
  ) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (
      call.name !== "sessions_spawn" ||
      readStringInput(call.input, "agent_id") !== "browser"
    ) {
      return call;
    }
    const task = readStringInput(call.input, "task") ?? "";
    const label = readStringInput(call.input, "label") ?? "";
    const callText = [task, label].join("\n");
    if (extractHttpUrls(callText).length === 0) {
      return call;
    }
    const browserRequired =
      taskRequiresBrowserEvidence(context.taskPrompt) ||
      taskRequiresBrowserEvidence(callText) ||
      hasHardBrowserRequiredSignal(context.taskPrompt) ||
      hasHardBrowserRequiredSignal(callText) ||
      toolCallTargetsBrowserRequiredUrl({
        toolCallText: callText,
        taskPrompt: context.taskPrompt,
      });
    if (browserRequired) {
      return call;
    }
    return {
      ...call,
      input: {
        ...call.input,
        agent_id: "explore",
        task: [
          "Use the explore worker for this bounded source-check; browser-visible/rendered evidence was not requested.",
          task,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  });
}

export function normalizeBoundedTimeoutDuplicateSourceSpawns(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string },
): LLMToolCall[] {
  if (!looksBoundedTimeoutSourceCheck(context.taskPrompt)) {
    return toolCalls;
  }
  const selectedByUrlSet = new Map<string, { index: number; score: number }>();
  const droppedIndexes = new Set<number>();
  toolCalls.forEach((call, index) => {
    if (call.name !== "sessions_spawn") {
      return;
    }
    const urls = dedupeStrings(
      extractHttpUrls(
        [
          readStringInput(call.input, "task") ?? "",
          readStringInput(call.input, "label") ?? "",
        ].join("\n"),
      ).map(normalizeUrlForComparison),
    ).sort();
    if (urls.length !== 1) {
      return;
    }
    const urlSetKey = urls.join("\n");
    const score = scoreBoundedTimeoutSourceSpawn(call, context.taskPrompt);
    const current = selectedByUrlSet.get(urlSetKey);
    if (!current || score > current.score) {
      if (current) {
        droppedIndexes.add(current.index);
      }
      selectedByUrlSet.set(urlSetKey, { index, score });
      return;
    }
    droppedIndexes.add(index);
  });
  if (droppedIndexes.size === 0) {
    return toolCalls;
  }
  return toolCalls.filter((_, index) => !droppedIndexes.has(index));
}

export function looksBoundedTimeoutSourceCheck(text: string): boolean {
  return (
    /\b(?:bounded attempt|bounded retry|does not return|doesn't return|slow[- ]source|source[- ]check|timeout|timed out|resume(?:d)? the existing source|continue from the slow[- ]source)\b/i.test(
      text,
    ) && extractHttpUrls(text).length > 0
  );
}

export function scoreBoundedTimeoutSourceSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): number {
  const agentId = readStringInput(call.input, "agent_id") ?? "";
  const callText = [
    readStringInput(call.input, "task") ?? "",
    readStringInput(call.input, "label") ?? "",
  ].join("\n");
  const browserRequired =
    taskRequiresBrowserEvidence(taskPrompt) ||
    taskRequiresBrowserEvidence(callText) ||
    toolCallTargetsBrowserRequiredUrl({ toolCallText: callText, taskPrompt });
  if (browserRequired) {
    if (agentId === "browser") return 30;
    if (agentId === "explore") return 10;
    return 0;
  }
  if (agentId === "explore") return 30;
  if (agentId === "browser") return 10;
  return 0;
}

export function normalizeApprovalGatedBrowserSpawnCalls(
  toolCalls: LLMToolCall[],
  context: {
    taskPrompt: string;
    sessionContext: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  const browserSpawnCalls = toolCalls.filter(isBrowserSessionSpawn);
  if (browserSpawnCalls.length === 0) {
    return toolCalls;
  }
  const contextText = [
    context.taskPrompt,
    context.sessionContext,
    ...browserSpawnCalls.flatMap((call) => [
      readStringInput(call.input, "task") ?? "",
      readStringInput(call.input, "label") ?? "",
      readStringInput(call.input, "action") ?? "",
    ]),
  ].join("\n");
  if (!looksApprovalGatedBrowserSideEffect(contextText)) {
    return toolCalls;
  }
  const prematureMutatingBrowserSpawn = browserSpawnCalls.find((call) =>
    (() => {
      const callText = [
        readStringInput(call.input, "task") ?? "",
        readStringInput(call.input, "label") ?? "",
        readStringInput(call.input, "action") ?? "",
      ].join("\n");
      return (
        looksApprovalGatedBrowserSideEffect(callText) &&
        browserSpawnPerformsMutatingAction(callText) &&
        !disclaimsIntendedBrowserMutation(callText)
      );
    })(),
  );
  if (
    prematureMutatingBrowserSpawn &&
    !taskPromptSaysApprovalAlreadyApplied(context.taskPrompt) &&
    !hasPermissionGateContextEvidence(context.sessionContext) &&
    !hasPermissionGateEvidence(context.toolTrace) &&
    !toolCalls.some((call) => call.name.startsWith("permission_"))
  ) {
    return toolCalls.flatMap((call) => {
      if (!isBrowserSessionSpawn(call)) {
        return [call];
      }
      if (call !== prematureMutatingBrowserSpawn) {
        return [];
      }
      const permissionQuery = buildPermissionQueryFromBrowserSpawn(
        call,
        context.taskPrompt,
      );
      const inspectionCall = buildPreApprovalBrowserInspectionSpawn(
        call,
        context.taskPrompt,
      );
      return inspectionCall ? [inspectionCall, permissionQuery] : [permissionQuery];
    });
  }
  if (browserSpawnCalls.length <= 1) {
    return toolCalls;
  }
  const seenSignatures = new Set<string>();
  return toolCalls.filter((call) => {
    if (!isBrowserSessionSpawn(call)) {
      return true;
    }
    const signature = toolCallSignature(call);
    if (!seenSignatures.has(signature)) {
      seenSignatures.add(signature);
      return true;
    }
    return false;
  });
}

export function hasPermissionGateContextEvidence(context: string): boolean {
  return /\bpermission_(?:query|result|applied)\b|\bpermission\.(?:query|result|applied)\b|\bapproval_id\b|\bpermission cache\b[\s\S]{0,120}\balready applied\b/i.test(
    context,
  );
}

export function buildPermissionQueryFromBrowserSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): LLMToolCall {
  const task = readStringInput(call.input, "task") ?? "";
  const label = readStringInput(call.input, "label") ?? "";
  const url = extractHttpUrls(`${task}\n${taskPrompt}`)[0];
  return {
    ...call,
    name: "permission_query",
    input: {
      action: "browser.form.submit",
      title: "Approve local dry-run browser form submission",
      risk:
        "Applies an approval-gated browser form submission in an isolated local dry-run page.",
      level: "approval",
      scope: "mutate",
      worker_kind: "browser",
      rationale:
        "The user asked to carry a browser form submission through the approval gate before applying the action.",
      payload: {
        ...(url ? { url } : {}),
        task: task || label || "approval-gated browser form submission",
      },
    },
  };
}

export function buildPreApprovalBrowserInspectionSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): LLMToolCall | null {
  const task = readStringInput(call.input, "task") ?? "";
  const label = readStringInput(call.input, "label") ?? "";
  const callText = [task, label].join("\n");
  if (!shouldPreservePreApprovalBrowserInspection(callText, taskPrompt)) {
    return null;
  }
  const url = extractHttpUrls(`${callText}\n${taskPrompt}`)[0];
  if (!url) {
    return null;
  }
  return {
    ...call,
    id: `${call.id}-inspection`,
    input: {
      ...call.input,
      agent_id: "browser",
      label: label || "Pre-approval browser inspection",
      task: [
        "Pre-approval browser inspection only.",
        `Open ${url} as a rendered browser page and observe what is visible before any approval-gated action.`,
        "Report the final URL, page title, visible fixture/marker text, form fields, submission control, and screenshot/snapshot evidence if available.",
        "Do not submit the form, click the submit control, fill fields, save, mutate, or perform any side effect. The form submission remains blocked until permission_query/permission_result/permission_applied clears it.",
      ].join("\n"),
    },
  };
}

export function shouldPreservePreApprovalBrowserInspection(
  callText: string,
  taskPrompt: string,
): boolean {
  const combined = `${taskPrompt}\n${callText}`;
  if (!looksApprovalGatedBrowserSideEffect(combined)) {
    return false;
  }
  if (!/\b(?:approval[- ]?form|approval form|dry[- ]run|operator review|browser\.form\.submit|form submission)\b/i.test(combined)) {
    return false;
  }
  return (
    containsPrivateOrLoopbackHttpUrl(combined) ||
    /\b(?:open|inspect|observe|rendered|screenshot|snapshot|visible|page evidence|what evidence the page showed)\b/i.test(
      combined,
    )
  );
}

export function enforceMissingApprovalGateRepairToolCalls(
  toolCalls: LLMToolCall[],
  context: {
    messages: LLMMessage[];
    repairMarkers: LLMMessage[];
    taskPrompt: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  if (
    !hasMissingApprovalGateRepairPrompt(context.repairMarkers) ||
    !requestsApprovalGatedBrowserAction(context.taskPrompt) ||
    hasPermissionGateEvidence(context.toolTrace) ||
    toolCalls.some((call) => call.name === "permission_query")
  ) {
    return toolCalls;
  }
  const selected = toolCalls[0];
  return [
    buildPermissionQueryFromBrowserSpawn(
      selected ?? {
        id: "runtime-missing-approval-gate",
        name: "sessions_spawn",
        input: {},
      },
      context.taskPrompt,
    ),
  ];
}

export function disclaimsIntendedBrowserMutation(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:not\s+(?:a\s+)?form submission|not\s+(?:a\s+)?browser mutation|do not mutate|don't mutate|without mutat(?:ing|ion)|no browser mutation|no form submission)\b/i.test(
      normalized,
    ) ||
    /\b(?:inspect|inspection|observe|review|report|summarize|read|check)\b[\s\S]{0,120}\bbefore\s+(?:submission|submit|submitting|mutation|side[- ]effect)\b/i.test(
      normalized,
    ) ||
    /\b(?:read[- ]only|inspection only|observe[- ]only|no[- ]mutation)\b[\s\S]{0,180}\b(?:no|not|without|unintended)\b[\s\S]{0,120}\b(?:submit|submission|form submission|mutat(?:e|ion)|side[- ]effects?|browser side[- ]effect)\b/i.test(
      normalized,
    ) ||
    /\b(?:no|not|without)\b[\s\S]{0,80}\b(?:form submission|submission|submit|mutat(?:e|ion)|side[- ]effects?)\b[\s\S]{0,160}\b(?:intended|needed|required|will run|will be performed|should run|should be performed)\b/i.test(
      normalized,
    ) ||
    /\b(?:submitting|submit(?:ting)? a form|form submission|browser mutation|side[- ]effect)\b[\s\S]{0,120}\b(?:would be|is)\s+(?:an\s+)?unintended\b/i.test(
      normalized,
    )
  );
}

export function isBrowserSessionSpawn(call: LLMToolCall): boolean {
  return (
    call.name === "sessions_spawn" &&
    readStringInput(call.input, "agent_id") === "browser"
  );
}

export function taskRequiresBrowserEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (explicitlyDisclaimsBrowserRenderedEvidence(normalized)) {
    return false;
  }
  return (
    /\b(?:browser-visible|browser rendered|browser-rendered|browser-observed|as (?:a|an) (?:user|operator) would see|user-visible|visible page|rendered page|rendered DOM|client[- ]side|JavaScript-rendered|JS-rendered|dynamic dashboard|live dashboard)\b/i.test(
      normalized,
    ) ||
    /\b(?:rendered browser page|browser page rendered|fully render(?:ed)?|rendered values?|visible values?|exact visible text|exact visible values?)\b/i.test(
      normalized,
    ) ||
    /\b(?:live signal|signal dashboard|real-time indicators?|visible metrics?|metrics? dashboards?)\b/i.test(
      normalized,
    ) ||
    /\b(?:dashboards?|metrics?|signal values?)\b[\s\S]{0,120}\bshown on (?:the )?page\b/i.test(
      normalized,
    ) ||
    /\b(?:iframe|embedded source frame|frame content|shadow(?:-style)? component|shadow DOM|details popup|popup workflow|open the details popup)\b/i.test(
      normalized,
    )
  );
}

export function explicitlyDisclaimsBrowserRenderedEvidence(text: string): boolean {
  return (
    /\b(?:not|never)\s+(?:a\s+)?(?:browser-visible|browser-rendered|browser rendered|browser-observed|user-visible)\b/i.test(
      text,
    ) ||
    /\b(?:no|without)\s+(?:client[- ]side|JavaScript-rendered|JS-rendered|rendered DOM|browser-rendered|browser rendered|browser-visible)\s+(?:rendering|content|evidence|required|needed)?\b/i.test(
      text,
    ) ||
    /\bstatic HTML only\b[\s\S]{0,80}\b(?:no|without)\s+(?:JavaScript|JS|client[- ]side|browser-rendered|browser rendered)\b/i.test(
      text,
    )
  );
}

export function toolCallTargetsBrowserRequiredUrl(input: {
  toolCallText: string;
  taskPrompt: string;
}): boolean {
  const urls = extractHttpUrls(input.toolCallText);
  if (urls.length === 0 || !taskRequiresBrowserEvidence(input.taskPrompt)) {
    return false;
  }
  return urls.some((url) =>
    taskPromptRequiresBrowserForUrl(input.taskPrompt, url),
  );
}

export function taskPromptRequiresBrowserForUrl(
  taskPrompt: string,
  url: string,
): boolean {
  const normalizedUrl = normalizeUrlForComparison(url);
  const lines = taskPrompt.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (
      !extractHttpUrls(line).some(
        (candidate) => normalizeUrlForComparison(candidate) === normalizedUrl,
      )
    ) {
      continue;
    }
    const localContext = [
      lines[index - 1],
      line,
      lines[index + 1],
      lines[index + 2],
    ]
      .filter((item): item is string => typeof item === "string")
      .join("\n");
    if (taskRequiresBrowserEvidence(localContext)) {
      return true;
    }
  }
  return false;
}

export function normalizeUrlForComparison(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function looksApprovalGatedBrowserSideEffect(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const hasApprovalContext =
    /\b(?:approval|approve|approved|permission|authorize|authorized|operator\s+review|gate|gated|dry-?run)\b/i.test(
      normalized,
    ) || /\bbrowser\.[a-z0-9_.-]+\b/i.test(normalized);
  const hasBrowserMutation =
    /\b(?:submit|click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in|form)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    );
  return hasApprovalContext && hasBrowserMutation;
}

export function browserSpawnPerformsMutatingAction(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:submit|submission|form\.submit)\b[\s\S]{0,80}\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b/i.test(
      normalized,
    ) ||
    /\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b[\s\S]{0,80}\b(?:submit|submission|form\.submit)\b/i.test(
      normalized,
    ) ||
    /\b(?:click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    )
  );
}

export function extractWorkerSessionKey(value: string): string | undefined {
  return value.match(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/)?.[0];
}

export function extractKnownWorkerSessionKeys(context: string): string[] {
  const matches =
    context.match(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/g) ?? [];
  return [...new Set(matches)];
}

export function resolveKnownWorkerSessionKey(
  sessionKey: string,
  knownSessionKeys: string[],
): string {
  if (knownSessionKeys.includes(sessionKey)) {
    return sessionKey;
  }
  const sessionSignature = relaxedSessionKeySignature(sessionKey);
  const matches = knownSessionKeys.filter(
    (candidate) => relaxedSessionKeySignature(candidate) === sessionSignature,
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  const truncatedPrefix = readTruncatedSessionKeyPrefix(sessionSignature);
  if (truncatedPrefix) {
    const prefixMatches = knownSessionKeys.filter((candidate) =>
      relaxedSessionKeySignature(candidate).startsWith(truncatedPrefix),
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0]!;
    }
  }
  return sessionKey;
}

export function relaxedSessionKeySignature(sessionKey: string): string {
  return sessionKey
    .replace(/call_function_/g, "call_")
    .replace(/call_func_/g, "call_")
    .replace(/call_funct(?:ion)?(?=…|\.{3})/g, "call_")
    .replace(/call_func(?=…|\.{3})/g, "call_");
}

export function readTruncatedSessionKeyPrefix(sessionKey: string): string | null {
  const ellipsisIndex = sessionKey.search(/…|\.\.\./);
  if (ellipsisIndex < 0) {
    return null;
  }
  const prefix = sessionKey.slice(0, ellipsisIndex);
  return prefix.length >= 24 ? prefix : null;
}

export function readStringInput(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function containsPrivateOrLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return isPrivateOrLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  });
}

export function containsLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return isLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  });
}

export function containsPrivateNonLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return (
        isPrivateOrLoopbackHostname(parsed.hostname) &&
        !isLoopbackHostname(parsed.hostname)
      );
    } catch {
      return false;
    }
  });
}

export function isLoopbackReadOnlySourceExploreTask(input: {
  toolCallText: string;
  taskPrompt: string;
  targetsBrowserRequiredUrl: boolean;
}): boolean {
  if (
    input.targetsBrowserRequiredUrl ||
    taskRequiresBrowserEvidence(input.taskPrompt) ||
    taskRequiresBrowserEvidence(input.toolCallText) ||
    !containsLoopbackHttpUrl(input.toolCallText) ||
    containsPrivateNonLoopbackHttpUrl(input.toolCallText)
  ) {
    return false;
  }
  const normalized = input.toolCallText.toLowerCase();
  return (
    /\b(?:source pages?|source|pricing|price|url extraction|read-only url|fetch|extract|retrieve|research|review|compare|comparison|evidence|content)\b/i.test(
      normalized,
    ) && !hasHardBrowserRequiredSignal(normalized)
  );
}

export function hasHardBrowserRequiredSignal(input: string): boolean {
  return /\b(?:authenticated|login|logged in|account|password|2fa|mfa|otp|credential|api key|secret|token|interactive|click|fill|submit|submission|form|approval|dry-run|dry run|operator review|side effect|side-effect|mutation|save|purchase|delete|update|visual|screenshot|snapshot|js-rendered|javascript-rendered|client-side|rendered dashboard|dashboard|as a user would see|active browser)\b/i.test(
    input,
  );
}

export function allowsLoopbackExploreForE2E(): boolean {
  return process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE === "1";
}

export function extractHttpUrls(text: string): string[] {
  return Array.from(text.matchAll(/\bhttps?:\/\/[^\s"'`<>]+/gi))
    .map((match) => trimHttpUrlCandidate(match[0] ?? ""))
    .filter(Boolean);
}

export function trimHttpUrlCandidate(candidate: string): string {
  let value = candidate.trim();
  while (value) {
    try {
      new URL(value);
      return value;
    } catch {
      const next = value.replace(/[)\],;.!?。，“”‘’！？：:]$/g, "");
      if (next === value) {
        return value;
      }
      value = next;
    }
  }
  return value;
}

export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(hostname) || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrLoopbackHostname(normalized.slice("::ffff:".length));
  }
  if (
    /^(?:fc|fd)[0-9a-f]{2}:/i.test(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized)
  ) {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const a = numbers[0]!;
  const b = numbers[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHostname(normalized.slice("::ffff:".length));
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  return (
    numbers.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255,
    ) && numbers[0] === 127
  );
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

export function maybeAppendBrowserFailureBucketVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  evidenceText: string;
}): GenerateTextResult {
  const buckets = collectBrowserFailureBucketNames(input.evidenceText);
  if (buckets.length === 0) {
    return input.result;
  }
  if (expectsExactFinalAnswerShape(input.taskPrompt, input.result.text)) {
    return input.result;
  }
  const missingBuckets = buckets.filter(
    (bucket) => !browserFailureBucketVisible(input.result.text, bucket),
  );
  if (missingBuckets.length === 0) {
    return input.result;
  }
  const limitation = buildBrowserFailureBucketVisibilityLine(missingBuckets, input.result.text);
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${limitation}`.trim(),
  };
}

export function collectBrowserFailureBucketNames(text: string): string[] {
  const buckets = new Set<string>();
  const pattern =
    /\b(target_not_found|attach_failed|expert_session_detached|cdp_command_timeout|browser_cdp_unavailable|detached_target|session_not_found|wait_condition_timeout|transport_failure|owner_mismatch|lease_conflict)\b/gi;
  for (const match of text.matchAll(pattern)) {
    buckets.add(match[1]!.toLowerCase());
  }
  return [...buckets].sort();
}

export function browserFailureBucketVisible(text: string, bucket: string): boolean {
  if (bucket === "cdp_command_timeout") {
    return /\b(?:CDP|snapshot|screenshot|capture|browser)\b[\s\S]{0,160}\b(?:timed out|timeout|incomplete|not captured|not verified|unverified|bounded)\b/i.test(
      text,
    );
  }
  if (bucket === "browser_cdp_unavailable") {
    return /\b(?:browser|CDP|Chrome DevTools)\b[\s\S]{0,160}\b(?:unavailable|unreachable|not reachable|connection refused)\b/i.test(
      text,
    );
  }
  if (bucket === "detached_target") {
    return /\b(?:browser|target|tab|page)\b[\s\S]{0,160}\bdetached\b|\bdetached\b[\s\S]{0,160}\b(?:browser|target|tab|page)\b/i.test(
      text,
    );
  }
  if (new RegExp(`\\b${escapeRegExp(bucket)}\\b`, "i").test(text)) {
    return true;
  }
  return /\b(?:browser|session|target|transport|attach|detached|profile)\b[\s\S]{0,160}\b(?:recovered|failed|unavailable|not found|detached|bounded|unverified)\b/i.test(
    text,
  );
}

export function buildBrowserFailureBucketVisibilityLine(buckets: string[], resultText: string): string {
  if (buckets.includes("detached_target")) {
    return [
      `Browser limitation: browser target detached during browser work (${buckets.join(", ")}).`,
      "Treat the verified page facts as bounded target evidence; browser target details beyond the reported URL, marker, screenshot, or visible text remain incomplete or unverified.",
      "Next action: retry or continue the browser task after the target is stable if additional rendered details matter.",
    ].join(" ");
  }
  if (buckets.includes("cdp_command_timeout")) {
    return [
      `Browser limitation: ${buckets.join(", ")} occurred during browser CDP capture/snapshot work.`,
      "Treat the verified page facts as bounded to recovered browser evidence; deeper CDP traversal or missing capture details remain unverified.",
      "Next action: retry or continue the browser capture with a longer timeout if those missing details matter.",
    ].join(" ");
  }
  if (hasRecoveredRenderedBrowserEvidence(resultText)) {
    return [
      `Browser limitation: ${buckets.join(", ")} occurred during browser work.`,
      "Treat the verified page facts above as bounded to recovered browser evidence; no additional browser-visible facts are claimed beyond the reported marker, URL, screenshot, or confirmation text.",
      "Next action: retry or continue the browser task only if extra rendered details beyond those reported facts matter.",
    ].join(" ");
  }
  return [
    `Browser limitation: ${buckets.join(", ")} occurred during browser work.`,
    "Verified: the browser failure bucket itself is the available source-backed evidence; rendered page content remains unverified.",
    "Next action: retry or continue the browser task after the browser target/session is stable if the missing rendered evidence matters.",
  ].join(" ");
}

export function hasRecoveredRenderedBrowserEvidence(text: string): boolean {
  if (
    /\b(?:rendered|browser-visible|visible page|page content)\b[\s\S]{0,120}\b(?:unverified|not verified|unknown|missing|blocked|not confirmed)\b/i.test(
      text
    ) ||
    /\b(?:unverified|not verified|unknown|missing|blocked|not confirmed)\b[\s\S]{0,120}\b(?:rendered|browser-visible|visible page|page content)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return (
    /\b(?:marker|confirmation marker|success text|confirmation text|final URL|screenshot|snapshot|post-submit|post submission|post-submission|page confirmed|browser fixture evidence)\b/i.test(
      text
    ) ||
    /\b(?:verified|observed|confirmed|found)\b[\s\S]{0,160}\b(?:page|fixture|marker|screenshot|snapshot|URL|confirmation|success text|rendered|browser-visible)\b/i.test(
      text
    )
  );
}

export function requestsStatusVisibleTextEvidenceUrlLines(taskPrompt: string): boolean {
  return (
    /(?:只|仅|只需|仅需)(?:用|以)?(?:回答|输出|返回|给出)[^\n。；;]{0,24}(?:三|3)\s*(?:行|条|句)/i.test(
      taskPrompt,
    ) &&
    /状态/.test(taskPrompt) &&
    /最终可见文本/.test(taskPrompt) &&
    /证据\s*URL/i.test(taskPrompt)
  );
}

export function shouldAppendRecoveredTimeoutCloseoutVisibility(input: {
  resultText: string;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const recoveredTimeoutContext =
    (hasSessionTimeoutEvidence(input) ||
      taskRequestsTimeoutContinuationCloseout(input.taskPrompt)) &&
    toolTraceHasCall(input.toolTrace, "sessions_send");
  if (!recoveredTimeoutContext) {
    return false;
  }
  if (
    taskRequestsUnverifiedTimeoutCloseout(input.taskPrompt) &&
    !mentionsUnverifiedScope(input.resultText)
  ) {
    return true;
  }
  return (
    !hasTimeoutCloseoutGuidance(input.resultText)
  );
}

export function maybeAppendRecoveredTimeoutCloseoutVisibility(
  result: GenerateTextResult,
): GenerateTextResult {
  if (hasTimeoutCloseoutGuidance(result.text)) {
    return result;
  }
  return {
    ...result,
    text: `${result.text.trim()}\n\nTimeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.`.trim(),
  };
}

export function maybeAppendRequiredTimeoutFollowupVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): GenerateTextResult {
  if (!taskRequestsTimeoutFollowupContinuation(input.taskPrompt)) {
    return input.result;
  }
  const contextText = [
    input.taskPrompt,
    input.result.text,
    ...input.messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
  const hasRecoveredTimeoutEvidence =
    hasSessionTimeoutEvidence(input) ||
    /\b(?:timeout|timed out|timeout recovery|recovered after .*timeout|resumed after .*timeout|earlier timeout|previous timeout|prior timeout)\b/i.test(
      contextText,
    );
  if (!hasRecoveredTimeoutEvidence || !toolTraceHasCall(input.toolTrace, "sessions_send")) {
    return input.result;
  }
  const missingLines: string[] = [];
  if (!hasTimeoutContinuationGuidance(input.result.text)) {
    missingLines.push(
      "Continuation guidance: continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
    );
  }
  if (!mentionsUnverifiedScope(input.result.text)) {
    missingLines.push(
      "Unverified scope: production-equivalent release health and any source facts beyond the recovered result remain unverified.",
    );
  }
  if (!mentionsTimeout(input.result.text)) {
    missingLines.push(
      "Timeout recovery: this answer follows a resumed source-check after an earlier timeout.",
    );
  }
  if (missingLines.length === 0) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${missingLines.join(" ")}`.trim(),
  };
}

export function maybeAppendBrowserRecoveryResidualRiskVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): GenerateTextResult {
  if (requestsStatusVisibleTextEvidenceUrlLines(input.taskPrompt)) {
    return input.result;
  }
  if (!taskRequiresBrowserEvidence(input.taskPrompt)) {
    return input.result;
  }
  if (mentionsUnverifiedScope(input.result.text) || /\bresidual risks?\b/i.test(input.result.text)) {
    return input.result;
  }
  const contextText = [
    input.taskPrompt,
    input.result.text,
    ...input.messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
  if (!/\b(?:residual risk|unverified scope|remaining risk|what remains unverified)\b/i.test(contextText)) {
    return input.result;
  }
  const hasBrowserRecoveryOrTimeout =
    toolTraceHasTimeoutResult(input.toolTrace) ||
    /\b(?:browser recovery metadata|resume mode|cold resume|recovered browser|browser.*timed out|timed out.*browser|screenshot.*timed out|snapshot.*timed out|scroll.*timed out|wait_for.*timed out)\b/i.test(
      contextText,
    );
  if (!hasBrowserRecoveryOrTimeout) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\nResidual risk: this browser review is source-bounded to recovered local fixture evidence; wider production state and any browser traversal that timed out remain unverified.`.trim(),
  };
}

export function taskRequestsTimeoutContinuationCloseout(taskPrompt: string): boolean {
  return /\b(?:explain|state|say|describe)\b[\s\S]{0,160}\bwhether\b[\s\S]{0,160}\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,160}\b(?:still\s+)?limits?\b[\s\S]{0,120}\bconclusion\b|\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,120}\b(?:still\s+)?limits?\b[\s\S]{0,120}\bconclusion\b/i.test(
    taskPrompt,
  );
}

export function taskRequestsUnverifiedTimeoutCloseout(taskPrompt: string): boolean {
  return (
    taskRequestsTimeoutContinuationCloseout(taskPrompt) &&
    /\b(?:unverified|not verified|residual risk|uncertainty|uncertain)\b/i.test(
      taskPrompt,
    )
  );
}

export function mentionsUnverifiedScope(text: string): boolean {
  return /\b(?:unverified|not verified|unconfirmed|uncertain|uncertainty|not confirmed)\b/i.test(
    text,
  );
}

export function shouldPreserveRecoveredTimeoutCloseout(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  evidenceText: string;
}): boolean {
  if (shouldAppendTimeoutContinuationVisibility(input)) {
    return true;
  }
  return (
    hasSessionTimeoutEvidence(input) &&
    toolTraceHasCall(input.toolTrace, "sessions_send") &&
    mentionsTimeout(input.evidenceText)
  );
}

export function hasTimeoutCloseoutGuidance(text: string): boolean {
  return (
    hasTimeoutContinuationGuidance(text) ||
    /\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,120}\b(?:no longer|still|does not|doesn't)\b[\s\S]{0,80}\blimits?\b[\s\S]{0,80}\bconclusion\b/i.test(
      text,
    )
  );
}

export function hasTimeoutContinuationGuidance(text: string): boolean {
  return (
    /\b(?:continue|retry|resume|resumable|bounded retry|timeout-gated)\b/i.test(
      text,
    ) ||
    /\b(?:next step|next action)\b[\s\S]{0,80}\b(?:continue|retry|resume|bounded retry)\b/i.test(
      text,
    ) ||
    /\b(?:configure|increase|extend)\b[\s\S]{0,80}\b(?:tool-call\s+)?timeouts?\b/i.test(
      text,
    ) ||
    /\btimeouts?\b[\s\S]{0,80}\b(?:retry|recover|configure|exclude|timeout-gated|bounded retry)\b/i.test(
      text,
    )
  );
}

export function mentionsTimeout(text: string): boolean {
  return /\b(?:timeout|timed out)\b/i.test(text);
}

export function toolTraceHasCall(
  toolTrace: NativeToolRoundTrace[],
  toolName: string,
): boolean {
  return toolTrace.some((roundTrace) =>
    roundTrace.calls.some((call) => call.name === toolName),
  );
}

export function toolTraceHasTimeoutResult(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some((roundTrace) =>
    roundTrace.results.some((result) => {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        return false;
      }
      if (typeof result.content !== "string") {
        return false;
      }
      return parseSessionToolResult(result.content)?.status === "timeout";
    }),
  );
}

export function hasSessionTimeoutEvidence(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (toolTraceHasTimeoutResult(input.toolTrace)) {
    return true;
  }
  return contextHasTimeoutSessionResult(
    buildContinuationDirectiveContext(input.taskPrompt, input.messages),
  );
}

export function maybeRedactForbiddenLocalUrls(input: {
  result: GenerateTextResult;
  packet: RolePromptPacket;
}): GenerateTextResult {
  const constraintText = `${input.packet.taskPrompt}\n${input.packet.outputContract}`;
  if (!forbidsFinalUrls(constraintText)) {
    return input.result;
  }
  const redacted = input.result.text.replace(
    /\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)\],;]*)?/gi,
    "local fixture source",
  );
  if (redacted === input.result.text) {
    return input.result;
  }
  return {
    ...input.result,
    text: redacted,
  };
}

export function forbidsFinalUrls(text: string): boolean {
  return /\b(?:do not include (?:source )?urls?|do not use [^\n.]*links?|links? (?:are )?forbidden|no links?|bare http:\/\/\s*\/\s*https?:\/\/ URLs?)\b/i.test(
    text,
  );
}

export function expectsExactFinalAnswerShape(
  taskPrompt: string,
  resultText: string,
): boolean {
  const combined = `${taskPrompt}\n${resultText}`;
  if (/^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])\s*$/.test(resultText)) {
    try {
      JSON.parse(resultText);
      return true;
    } catch {
      // Fall through to prompt-shape checks.
    }
  }
  return /\b(?:respond with only|output only|answer only|final answer must|answer must be|use this exact final answer|exact final answer shape|valid json|json object|json array|csv only|markdown table only)\b|(?:只|仅|只需|仅需)(?:用|以)?(?:回答|输出|返回|给出)[^\n。；;]{0,24}(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*(?:行|条|句)|^\s*Final Answer\s*:/im.test(
    combined,
  );
}

export function shouldAppendTimeoutContinuationVisibility(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const taskPromptSuffix = input.taskPrompt.slice(
    Math.max(0, input.taskPrompt.length - 4000),
  );
  if (
    !isExplicitSessionContinuationRequest(
      extractLatestUserContinuationText(taskPromptSuffix),
    ) &&
    !isExplicitSessionContinuationRequest(taskPromptSuffix)
  ) {
    return false;
  }
  if (
    !input.toolTrace.some((roundTrace) =>
      roundTrace.calls.some((call) => call.name === "sessions_send"),
    )
  ) {
    return false;
  }
  const context = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  return (
    toolTraceHasTimeoutResult(input.toolTrace) ||
    contextHasTimeoutSessionResult(context)
  );
}

// PR K3.6: byte cap for the per-result content slice we persist in tool traces.
// Generous enough to capture a full HTML snapshot of a typical page, small
// enough that a chain of long-running browser sessions doesn't bloat metadata.
// The full content still flows through the LLM tool loop in memory.
export const ROLE_TOOL_RESULT_TRACE_CAP_BYTES = 8 * 1024;

export function toNativeToolResultTrace(
  toolResult: ToolResult,
): NativeToolResultTrace {
  const bytes = Buffer.byteLength(toolResult.content, "utf8");
  const traceContent = compactToolResultTraceContent(toolResult.content);
  const traceBytes = Buffer.byteLength(traceContent.content, "utf8");
  const truncated = traceBytes > ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
  return {
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    isError: toolResult.isError === true,
    contentBytes: bytes,
    content: truncated
      ? sliceUtf8(traceContent.content, ROLE_TOOL_RESULT_TRACE_CAP_BYTES)
      : traceContent.content,
    ...(truncated || traceContent.compacted ? { contentTruncated: true } : {}),
    ...(toolResult.cancelled ? { cancelled: true } : {}),
    ...(toolResult.skipped ? { skipped: true } : {}),
  };
}

export function compactToolResultTraceContent(content: string): {
  content: string;
  compacted: boolean;
} {
  const parsed = parseSessionToolResult(content);
  if (!parsed) {
    return { content, compacted: false };
  }
  const compacted = {
    protocol: parsed.protocol,
    status: parsed.status,
    agent_id: parsed.agent_id,
    ...(parsed.label ? { label: parsed.label } : {}),
    session_key: parsed.session_key,
    task_id: parsed.task_id,
    ...(parsed.parent_session_key
      ? { parent_session_key: parsed.parent_session_key }
      : {}),
    ...(parsed.tool_call_id ? { tool_call_id: parsed.tool_call_id } : {}),
    ...(parsed.resumable ? { resumable: parsed.resumable } : {}),
    ...(parsed.timeout_seconds == null
      ? {}
      : { timeout_seconds: parsed.timeout_seconds }),
    ...(parsed.evidence_available == null
      ? {}
      : { evidence_available: parsed.evidence_available }),
    tool_chain: parsed.tool_chain,
    ...compactSessionPayloadArtifactRefs(parsed.payload),
    ...compactSessionPayloadEvidenceExcerpt(parsed.payload),
    ...(typeof parsed.evidence_summary === "string"
      ? { evidence_summary: sliceUtf8(parsed.evidence_summary, 1024) }
      : {}),
    final_content:
      typeof parsed.final_content === "string"
        ? sliceUtf8(parsed.final_content, 3 * 1024)
        : null,
    result:
      typeof parsed.result === "string" ? sliceUtf8(parsed.result, 1024) : "",
  };
  const compactContent = fitCompactToolResultTraceContent(compacted);
  return {
    content: compactContent,
    compacted: compactContent !== content,
  };
}

export function fitCompactToolResultTraceContent(
  input: Record<string, unknown>,
): string {
  const compacted = { ...input };
  const serialize = () => JSON.stringify(compacted, null, 2);
  const fits = (value: string) =>
    Buffer.byteLength(value, "utf8") <= ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
  const trySerialize = () => {
    const value = serialize();
    return fits(value) ? value : null;
  };

  const initial = trySerialize();
  if (initial) return initial;

  const shrinkStringField = (field: string, maxBytes: number) => {
    const value = compacted[field];
    if (typeof value === "string") {
      compacted[field] = maxBytes > 0 ? sliceUtf8(value, maxBytes) : "";
    }
  };
  const deleteField = (field: string) => {
    delete compacted[field];
  };
  const prunePayload = (
    field: "screenshotPaths" | "artifactIds",
    limit: number,
  ) => {
    const payload = compacted.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const values = readStringArray(record[field]);
    if (values.length > limit) {
      record[field] = values.slice(0, limit);
      record[`${field}Truncated`] = true;
      record[`${field}Count`] = values.length;
    }
  };

  const steps: Array<() => void> = [
    () => shrinkStringField("final_content", 2048),
    () => shrinkStringField("result", 768),
    () => shrinkStringField("evidence_summary", 512),
    () => shrinkStringField("evidence_excerpt", 512),
    () => shrinkStringField("final_content", 1024),
    () => shrinkStringField("result", 384),
    () => deleteField("evidence_summary"),
    () => deleteField("evidence_excerpt"),
    () => shrinkStringField("final_content", 512),
    () => shrinkStringField("result", 0),
    () => {
      compacted.final_content = null;
    },
    () => prunePayload("screenshotPaths", 4),
    () => prunePayload("artifactIds", 16),
  ];

  for (const step of steps) {
    step();
    const value = trySerialize();
    if (value) return value;
  }

  const minimal = {
    protocol: compacted.protocol,
    status: compacted.status,
    agent_id: compacted.agent_id,
    session_key: compacted.session_key,
    task_id: compacted.task_id,
    tool_chain: compacted.tool_chain,
    payload: compacted.payload,
    result: "session tool result compacted",
    final_content: null,
  };
  const minimalContent = JSON.stringify(minimal, null, 2);
  if (fits(minimalContent)) return minimalContent;
  return JSON.stringify({
    protocol: compacted.protocol,
    status: compacted.status,
    result: "session tool result compacted",
  });
}

export function compactSessionPayloadEvidenceExcerpt(
  payload: unknown,
): { evidence_excerpt: string } | Record<string, never> {
  const evidence = readPayloadEvidenceExcerpt(payload);
  return evidence ? { evidence_excerpt: sliceUtf8(evidence, 2 * 1024) } : {};
}

export function compactSessionPayloadArtifactRefs(
  payload: unknown,
):
  | { payload: { artifactIds?: string[]; screenshotPaths?: string[] } }
  | Record<string, never> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const artifactIds = readStringArray(record.artifactIds);
  const screenshotPaths = readStringArray(record.screenshotPaths);
  if (artifactIds.length === 0 && screenshotPaths.length === 0) {
    return {};
  }
  return {
    payload: {
      ...(artifactIds.length ? { artifactIds } : {}),
      ...(screenshotPaths.length ? { screenshotPaths } : {}),
    },
  };
}

export function readPayloadEvidenceExcerpt(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const pages = readPayloadEvidencePages(record);
  const parts = [
    readStringField(record.content),
    ...pages.flatMap((page) => [
      readStringField(page.finalUrl),
      readStringField(page.title),
      readStringField(page.textExcerpt),
    ]),
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => part.trim());
  const joined = dedupeStrings(parts).join("\n");
  return joined || null;
}

export function readPayloadEvidencePages(
  record: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const pages: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const addPage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const page = value as Record<string, unknown>;
    const key =
      readStringField(page.finalUrl) ??
      readStringField(page.requestedUrl) ??
      JSON.stringify(page).slice(0, 120);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    pages.push(page);
  };
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) {
      addPage(page);
    }
  }
  if (Array.isArray(record.sourceResults)) {
    for (const sourceResult of record.sourceResults) {
      if (
        !sourceResult ||
        typeof sourceResult !== "object" ||
        Array.isArray(sourceResult)
      ) {
        continue;
      }
      addPage((sourceResult as Record<string, unknown>).page);
    }
  }
  addPage(record.page);
  return pages;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
}

export function toNativeToolProgressTrace(
  call: LLMToolCall,
  progress: ToolProgressEvent,
  ts: number,
): NativeToolProgressTrace {
  return {
    toolCallId: call.id,
    toolName: progress.toolName || call.name,
    phase: progress.phase,
    summary: progress.summary,
    ...(progress.detail ? { detail: progress.detail } : {}),
    ts,
  };
}

export function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
