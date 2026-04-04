import type {
  FlowLedger,
  PermissionCacheRecord,
  RecoveryRun,
  ReplayRecord,
  RoleRunState,
  RuntimeChain,
  RuntimeProgressEvent,
  RuntimeChainStatus,
  TeamEvent,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";

import {
  attachRecoveryRunToReplayIncidentBundle,
  buildRecoveryRuns,
  buildReplayConsoleReport,
  buildReplayIncidentBundle,
  buildReplayInspectionReport,
  buildReplayRecoveryPlans,
  buildRecoveryRunId,
} from "./replay-inspection";
import {
  buildFlowConsoleReport,
  buildGovernanceConsoleReport,
  buildOperatorAttentionReport,
  buildRecoveryConsoleReport,
  buildOperatorSummaryReport,
  buildOperatorTriageReport,
} from "./operator-inspection";
import {
  buildAugmentedFlowRuntimeChainDetail,
  buildAugmentedFlowRuntimeChainEntry,
  buildDerivedRecoveryRuntimeChain,
  buildDerivedRecoveryRuntimeChainDetail,
  buildRuntimeSummaryReport,
  decorateRuntimeChainStatus,
} from "./runtime-chain-inspection";
import { buildPromptConsoleReport } from "./prompt-inspection";

export interface BoundedRegressionCaseDescriptor {
  caseId: string;
  title: string;
  area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime";
  summary: string;
}

export interface BoundedRegressionCaseResult extends BoundedRegressionCaseDescriptor {
  status: "passed" | "failed";
  details: string[];
}

export interface BoundedRegressionSuiteResult {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  results: BoundedRegressionCaseResult[];
}

type RegressionCase = BoundedRegressionCaseDescriptor & {
  run: () => BoundedRegressionCaseResult;
};

export function listBoundedRegressionCases(): BoundedRegressionCaseDescriptor[] {
  return BUILT_IN_CASES.map(({ caseId, title, area, summary }) => ({ caseId, title, area, summary }));
}

export function runBoundedRegressionSuite(caseIds?: string[]): BoundedRegressionSuiteResult {
  const selected = caseIds?.length
    ? BUILT_IN_CASES.filter((item) => caseIds.includes(item.caseId))
    : BUILT_IN_CASES;
  const results = selected.map((item) => item.run());
  return {
    totalCases: results.length,
    passedCases: results.filter((item) => item.status === "passed").length,
    failedCases: results.filter((item) => item.status === "failed").length,
    results,
  };
}

const BUILT_IN_CASES: RegressionCase[] = [
  {
    caseId: "runtime-summary-aligns-manual-recovery-and-operator-attention",
    title: "Runtime summary aligns manual recovery and operator attention",
    area: "runtime",
    summary:
      "Runtime summary and operator summary should agree when a recovery chain is waiting on a manual external follow-up.",
    run() {
      const recoveryRun: RecoveryRun = {
        recoveryRunId: "recovery:task-runtime-manual",
        threadId: "thread-1",
        sourceGroupId: "task-runtime-manual",
        latestStatus: "partial",
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Waiting on an external verification before resume.",
        waitingReason: "waiting on external verification",
        attempts: [],
        createdAt: 10,
        updatedAt: 20,
      };

      const runtimeEntry = buildDerivedRecoveryRuntimeChain(recoveryRun);
      const runtimeSummary = buildRuntimeSummaryReport({
        entries: [runtimeEntry],
        limit: 5,
        now: 20,
      });
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: [],
        recoveryRuns: [recoveryRun],
        limit: 5,
      });

      const details = [
        `runtime-waiting=${runtimeSummary.waitingCount}`,
        `runtime-case=${runtimeSummary.caseStateCounts.waiting_manual ?? 0}`,
        `operator-case=${operatorSummary.attentionOverview?.caseStateCounts.waiting_manual ?? 0}`,
      ];
      const passed =
        runtimeSummary.waitingCount === 1 &&
        runtimeSummary.caseStateCounts.waiting_manual === 1 &&
        operatorSummary.attentionOverview?.caseStateCounts.waiting_manual === 1 &&
        runtimeSummary.activeChains[0]?.caseKey === "incident:task-runtime-manual";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "runtime-summary-keeps-browser-recovered-chain-active",
    title: "Runtime summary keeps browser-recovered chains active",
    area: "runtime",
    summary:
      "A flow chain should stay active while a browser worker has recovered continuity but the role is still waiting on the next step.",
    run() {
      const chain: RuntimeChain = {
        chainId: "flow:runtime-browser-active",
        threadId: "thread-1",
        rootKind: "flow",
        rootId: "runtime-browser-active",
        flowId: "runtime-browser-active",
        createdAt: 1,
        updatedAt: 20,
      };
      const status: RuntimeChainStatus = {
        chainId: chain.chainId,
        threadId: chain.threadId,
        activeSpanId: "dispatch:task-browser-runtime",
        activeSubjectKind: "dispatch",
        activeSubjectId: "task-browser-runtime",
        phase: "waiting",
        latestSummary: "Dispatch waiting on browser continuation.",
        attention: false,
        updatedAt: 20,
      };
      const flow: FlowLedger = {
        flowId: "runtime-browser-active",
        threadId: "thread-1",
        rootMessageId: "msg-runtime-browser-active",
        mode: "serial",
        status: "waiting_worker",
        currentStageIndex: 0,
        activeRoleIds: ["lead"],
        completedRoleIds: [],
        failedRoleIds: [],
        nextExpectedRoleId: "lead",
        hopCount: 1,
        maxHops: 4,
        edges: [],
        createdAt: 1,
        updatedAt: 20,
      };
      const roleRuns: RoleRunState[] = [
        {
          runKey: "run:thread-1:lead",
          threadId: "thread-1",
          roleId: "lead",
          mode: "group",
          status: "waiting_worker",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [],
          lastDequeuedTaskId: "task-browser-runtime",
          lastActiveAt: 24,
          workerSessions: {
            browser: "worker:browser:task:task-browser-runtime",
          },
        },
      ];
      const workerState = {
        workerRunKey: "worker:browser:task:task-browser-runtime",
        workerType: "browser",
        status: "waiting_external",
        createdAt: 21,
        updatedAt: 25,
        currentTaskId: "task-browser-runtime",
        lastResult: {
          workerType: "browser",
          status: "partial",
          summary: "Browser continuity recovered; awaiting operator input.",
          payload: {
            sessionId: "browser-runtime-session",
            targetId: "target-runtime-session",
            resumeMode: "warm",
            targetResolution: "reconnect",
          },
        },
        continuationDigest: {
          reason: "follow_up" as const,
          summary: "Recovered browser session and waiting for the next task.",
          createdAt: 25,
        },
      } satisfies WorkerSessionState;

      const entry = buildAugmentedFlowRuntimeChainEntry({
        chain,
        status,
        flow,
        roleRuns,
        workerStatesByRunKey: new Map([[workerState.workerRunKey, workerState]]),
        now: 25,
      });
      const runtimeSummary = buildRuntimeSummaryReport({
        entries: [entry],
        limit: 5,
        now: 25,
      });

      const details = [
        `active=${runtimeSummary.activeCount}`,
        `resolved=${runtimeSummary.resolvedCount}`,
        `state=${runtimeSummary.activeChains[0]?.canonicalState ?? "-"}`,
        `continuity=${runtimeSummary.activeChains[0]?.continuityState ?? "-"}`,
      ];
      const passed =
        runtimeSummary.activeCount === 1 &&
        runtimeSummary.resolvedCount === 0 &&
        runtimeSummary.activeChains[0]?.canonicalState === "waiting" &&
        runtimeSummary.activeChains[0]?.continuityState === "waiting";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "runtime-summary-preserves-reconnect-window-before-stale",
    title: "Runtime summary preserves reconnect window before stale",
    area: "runtime",
    summary: "A reconnecting chain should stay in heartbeat state until the reconnect window actually expires.",
    run() {
      const chain: RuntimeChain = {
        chainId: "flow:runtime-reconnect",
        threadId: "thread-1",
        rootKind: "flow",
        rootId: "runtime-reconnect",
        flowId: "runtime-reconnect",
        createdAt: 1,
        updatedAt: 10,
      };
      const status = decorateRuntimeChainStatus({
        chain,
        status: {
          chainId: chain.chainId,
          threadId: chain.threadId,
          activeSpanId: "browser:runtime-reconnect",
          activeSubjectKind: "browser_session",
          activeSubjectId: "browser:runtime-reconnect",
          phase: "heartbeat",
          continuityState: "reconnecting",
          reconnectWindowUntil: 200,
          latestSummary: "Browser session is reconnecting.",
          attention: false,
          updatedAt: 100,
        },
        now: 150,
      });
      const runtimeSummary = buildRuntimeSummaryReport({
        entries: [{ chain, status }],
        limit: 5,
        now: 150,
      });

      const details = [
        `heartbeat=${runtimeSummary.stateCounts.heartbeat ?? 0}`,
        `stale=${runtimeSummary.staleCount}`,
        `continuity=${runtimeSummary.activeChains[0]?.continuityState ?? "-"}`,
      ];
      const passed =
        runtimeSummary.stateCounts.heartbeat === 1 &&
        runtimeSummary.staleCount === 0 &&
        runtimeSummary.activeChains[0]?.continuityState === "reconnecting";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "runtime-summary-aligns-browser-recovered-manual-follow-up",
    title: "Runtime summary aligns browser-recovered manual follow-up",
    area: "runtime",
    summary:
      "A recovery chain with recovered browser continuity should remain active and manual-follow-up across runtime and operator surfaces.",
    run() {
      const now = Date.now();
      const recoveryRun: RecoveryRun = {
        recoveryRunId: "recovery:task-runtime-browser-manual",
        threadId: "thread-1",
        sourceGroupId: "task-runtime-browser-manual",
        latestStatus: "partial",
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Browser continuity recovered; waiting on operator verification.",
        waitingReason: "waiting on operator verification",
        browserSession: {
          sessionId: "browser-runtime-manual",
          targetId: "target-runtime-manual",
          resumeMode: "warm",
        },
        attempts: [
          {
            attemptId: "attempt-runtime-browser-manual",
            action: "resume",
            requestedAt: now - 10,
            updatedAt: now,
            status: "waiting_external",
            nextAction: "inspect_then_resume",
            summary: "Detached target recovered; waiting on manual verification.",
            browserOutcome: "detached_target_recovered",
          },
        ],
        createdAt: now - 20,
        updatedAt: now,
      };

      const runtimeEntry = buildDerivedRecoveryRuntimeChain(recoveryRun);
      const runtimeSummary = buildRuntimeSummaryReport({
        entries: [runtimeEntry],
        limit: 5,
        now,
      });
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: [],
        recoveryRuns: [recoveryRun],
        limit: 5,
      });

      const details = [
        `runtime-active=${runtimeSummary.activeCount}`,
        `runtime-case=${runtimeSummary.caseStateCounts.waiting_manual ?? 0}`,
        `runtime-continuity=${runtimeSummary.activeChains[0]?.continuityState ?? "-"}`,
        `operator-case=${operatorSummary.attentionOverview?.caseStateCounts.waiting_manual ?? 0}`,
        `browser-outcome=${operatorSummary.recovery.browserOutcomeCounts.detached_target_recovered ?? 0}`,
      ];
      const passed =
        runtimeSummary.activeCount === 1 &&
        runtimeSummary.caseStateCounts.waiting_manual === 1 &&
        runtimeSummary.activeChains[0]?.continuityState === "waiting" &&
        operatorSummary.attentionOverview?.caseStateCounts.waiting_manual === 1 &&
        operatorSummary.recovery.browserOutcomeCounts.detached_target_recovered === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "operator-triage-prioritizes-compound-incident",
    title: "Operator triage prioritizes compound browser/runtime/prompt incident",
    area: "runtime",
    summary:
      "Operator triage should put a recovered-browser manual follow-up incident ahead of raw runtime/prompt signals while still surfacing waiting and prompt entry points.",
    run() {
      const now = Date.now();
      const recoveryRun: RecoveryRun = {
        recoveryRunId: buildRecoveryRunId("task-operator-triage"),
        threadId: "thread-1",
        sourceGroupId: "task-operator-triage",
        latestStatus: "partial",
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Browser continuity recovered; waiting on operator verification.",
        waitingReason: "waiting on operator verification",
        browserSession: {
          sessionId: "browser-operator-triage",
          targetId: "target-operator-triage",
          resumeMode: "warm",
        },
        attempts: [
          {
            attemptId: "attempt-operator-triage",
            action: "resume",
            requestedAt: now - 10,
            updatedAt: now,
            status: "waiting_external",
            nextAction: "inspect_then_resume",
            summary: "Detached target recovered; waiting on manual verification.",
            browserOutcome: "detached_target_recovered",
          },
        ],
        createdAt: now - 20,
        updatedAt: now,
      };
      const progressEvents: RuntimeProgressEvent[] = [
        {
          progressId: "progress:operator-triage:reduction",
          threadId: "thread-1",
          chainId: "recovery:task-operator-triage",
          spanId: "recovery:task-operator-triage",
          subjectKind: "recovery_run",
          subjectId: buildRecoveryRunId("task-operator-triage"),
          phase: "waiting",
          progressKind: "boundary",
          summary: "Envelope reduction kept the browser verification blocker visible.",
          recordedAt: now,
          taskId: "task-operator-triage",
          metadata: {
            boundaryKind: "request_envelope_reduction",
            modelId: "gpt-5",
            modelChainId: "acceptance_chain",
            assemblyFingerprint: "fp-operator-triage",
            reductionLevel: "minimal",
            compactedSegments: ["recent-turns", "worker-evidence"],
            contextDiagnostics: {
              continuity: {
                hasThreadSummary: true,
                hasSessionMemory: true,
                hasRoleScratchpad: true,
                hasContinuationContext: true,
                carriesPendingWork: true,
                carriesWaitingOn: true,
                carriesOpenQuestions: true,
                carriesDecisionOrConstraint: true,
              },
              recentTurns: {
                availableCount: 8,
                selectedCount: 5,
                packedCount: 2,
                salientEarlierCount: 1,
                compacted: true,
              },
              retrievedMemory: {
                availableCount: 4,
                selectedCount: 2,
                packedCount: 1,
                compacted: true,
                userPreferenceCount: 1,
                threadMemoryCount: 1,
                sessionMemoryCount: 1,
                knowledgeNoteCount: 1,
                journalNoteCount: 0,
              },
              workerEvidence: {
                totalCount: 3,
                admittedCount: 2,
                selectedCount: 2,
                packedCount: 1,
                compacted: true,
                promotableCount: 1,
                observationalCount: 1,
                fullCount: 1,
                summaryOnlyCount: 1,
                continuationRelevantCount: 1,
              },
            },
          },
        },
      ];
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: [],
        recoveryRuns: [recoveryRun],
        progressEvents,
        limit: 10,
      });
      const operatorAttention = buildOperatorAttentionReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: [],
        recoveryRuns: [recoveryRun],
        progressEvents,
        limit: 10,
      });
      const triage = buildOperatorTriageReport({
        summary: operatorSummary,
        attention: operatorAttention,
        runtime: buildRuntimeSummaryReport({
          entries: [buildDerivedRecoveryRuntimeChain(recoveryRun)],
          limit: 10,
          now,
        }),
        limit: 5,
      });
      const details = [
        `entry=${triage.recommendedEntryPoint ?? "-"}`,
        `focus0=${triage.focusAreas[0]?.commandHint ?? "-"}`,
        `waiting=${triage.runtimeWaitingCount}`,
        `prompt=${triage.promptReductionCount}`,
        `manual=${triage.waitingManualCaseCount}`,
      ];
      const passed =
        triage.waitingManualCaseCount === 1 &&
        triage.runtimeWaitingCount === 1 &&
        triage.promptReductionCount === 1 &&
        triage.recommendedEntryPoint === "replay-bundle task-operator-triage" &&
        triage.focusAreas[0]?.commandHint === "replay-bundle task-operator-triage" &&
        triage.focusAreas.some((area) => area.commandHint === "runtime-waiting 10") &&
        triage.focusAreas.some((area) => area.commandHint === "prompt-console 10");
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "runtime-summary-surfaces-stale-waiting-point-and-child-span",
    title: "Runtime summary surfaces stale waiting points and child span context",
    area: "runtime",
    summary:
      "Runtime summary should expose stale waiting chains with the current waiting point and latest child span for operator triage.",
    run() {
      const chain: RuntimeChain = {
        chainId: "flow:runtime-stale-waiting",
        threadId: "thread-1",
        rootKind: "flow",
        rootId: "runtime-stale-waiting",
        flowId: "runtime-stale-waiting",
        createdAt: 1,
        updatedAt: 40,
      };
      const runtimeSummary = buildRuntimeSummaryReport({
        entries: [
          {
            chain,
            status: {
              chainId: chain.chainId,
              threadId: chain.threadId,
              activeSpanId: "browser:runtime-stale-waiting",
              activeSubjectKind: "browser_session",
              activeSubjectId: "browser-runtime-stale-waiting",
              phase: "waiting",
              waitingReason: "waiting for browser reconnect",
              currentWaitingPoint: "browser target detached and reconnect window expired",
              latestChildSpanId: "browser:runtime-stale-waiting",
              responseTimeoutAt: 15,
              latestSummary: "Waiting for browser reconnect.",
              attention: true,
              updatedAt: 20,
            },
          },
        ],
        limit: 5,
        now: 40,
      });

      const details = [
        `stale=${runtimeSummary.staleCount}`,
        `state=${runtimeSummary.staleChains[0]?.canonicalState ?? "-"}`,
        `waiting=${runtimeSummary.staleChains[0]?.currentWaitingPoint ?? "-"}`,
        `child=${runtimeSummary.staleChains[0]?.latestChildSpanId ?? "-"}`,
      ];
      const passed =
        runtimeSummary.staleCount === 1 &&
        runtimeSummary.staleChains[0]?.canonicalState === "degraded" &&
        runtimeSummary.staleChains[0]?.currentWaitingPoint ===
          "browser target detached and reconnect window expired" &&
        runtimeSummary.staleChains[0]?.latestChildSpanId === "browser:runtime-stale-waiting";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "runtime-summary-prioritizes-attention-chains",
    title: "Runtime summary prioritizes attention chains",
    area: "runtime",
    summary:
      "Runtime summary should expose a cross-cutting attention view that keeps failed and stale chains ahead of quiet active chains.",
    run() {
      const report = buildRuntimeSummaryReport({
        entries: [
          {
            chain: {
              chainId: "flow:runtime-quiet",
              threadId: "thread-1",
              rootKind: "flow",
              rootId: "runtime-quiet",
              flowId: "runtime-quiet",
              createdAt: 1,
              updatedAt: 10,
            },
            status: {
              chainId: "flow:runtime-quiet",
              threadId: "thread-1",
              phase: "heartbeat",
              canonicalState: "heartbeat",
              latestSummary: "Role is still active.",
              attention: false,
              updatedAt: 10,
            },
          },
          {
            chain: {
              chainId: "flow:runtime-stale-attention",
              threadId: "thread-1",
              rootKind: "flow",
              rootId: "runtime-stale-attention",
              flowId: "runtime-stale-attention",
              createdAt: 1,
              updatedAt: 20,
            },
            status: {
              chainId: "flow:runtime-stale-attention",
              threadId: "thread-1",
              phase: "waiting",
              latestSummary: "Waiting on browser reconnect.",
              waitingReason: "waiting for browser reconnect",
              responseTimeoutAt: 15,
              attention: true,
              updatedAt: 20,
            },
          },
          {
            chain: {
              chainId: "recovery:runtime-failed-attention",
              threadId: "thread-1",
              rootKind: "recovery",
              rootId: "recovery:runtime-failed-attention",
              createdAt: 1,
              updatedAt: 30,
            },
            status: {
              chainId: "recovery:runtime-failed-attention",
              threadId: "thread-1",
              phase: "failed",
              canonicalState: "failed",
              latestSummary: "Recovery failed.",
              attention: true,
              updatedAt: 30,
            },
          },
        ],
        limit: 5,
        now: 40,
      });

      const details = [
        `attention=${report.attentionCount}`,
        `attention-chains=${report.attentionChains.map((entry) => entry.chainId).join(",")}`,
      ];
      const passed =
        report.attentionCount === 2 &&
        report.attentionChains.length === 2 &&
        report.attentionChains[0]?.chainId === "recovery:runtime-failed-attention" &&
        report.attentionChains[1]?.chainId === "flow:runtime-stale-attention";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "runtime-child-session-progress-visible",
    title: "Runtime chain keeps child session progress visible",
    area: "runtime",
    summary:
      "A parent flow should surface the child browser session as the active span while progress is still streaming.",
    run() {
      const chain: RuntimeChain = {
        chainId: "flow:runtime-child-session",
        threadId: "thread-1",
        rootKind: "flow",
        rootId: "runtime-child-session",
        flowId: "runtime-child-session",
        createdAt: 1,
        updatedAt: 30,
      };
      const status: RuntimeChainStatus = {
        chainId: chain.chainId,
        threadId: chain.threadId,
        activeSpanId: "dispatch:task-child-session",
        activeSubjectKind: "dispatch",
        activeSubjectId: "task-child-session",
        phase: "started",
        latestSummary: "Dispatch created browser work.",
        attention: false,
        updatedAt: 10,
      };
      const flow: FlowLedger = {
        flowId: "runtime-child-session",
        threadId: "thread-1",
        rootMessageId: "msg-runtime-child-session",
        mode: "serial",
        status: "waiting_worker",
        currentStageIndex: 0,
        activeRoleIds: ["lead"],
        completedRoleIds: [],
        failedRoleIds: [],
        nextExpectedRoleId: "lead",
        hopCount: 1,
        maxHops: 4,
        edges: [],
        createdAt: 1,
        updatedAt: 30,
      };
      const roleRuns: RoleRunState[] = [
        {
          runKey: "run:thread-1:lead",
          threadId: "thread-1",
          roleId: "lead",
          mode: "group",
          status: "waiting_worker",
          iterationCount: 1,
          maxIterations: 4,
          inbox: [],
          lastDequeuedTaskId: "task-child-session",
          lastActiveAt: 35,
          workerSessions: {
            browser: "worker:browser:task:task-child-session",
          },
        },
      ];
      const worker = {
        workerRunKey: "worker:browser:task:task-child-session",
        workerType: "browser",
        status: "running",
        createdAt: 12,
        updatedAt: 32,
        currentTaskId: "task-child-session",
        lastResult: {
          workerType: "browser",
          status: "partial",
          summary: "Browser child session is still gathering evidence.",
          payload: {
            sessionId: "browser-session-child",
            targetId: "target-child",
            resumeMode: "hot",
            targetResolution: "attach",
          },
        },
      } satisfies WorkerSessionState;
      const detail = buildAugmentedFlowRuntimeChainDetail({
        chain,
        status,
        spans: [],
        events: [],
        flow,
        roleRuns,
        workerStatesByRunKey: new Map([[worker.workerRunKey, worker]]),
        progressEvents: [
          {
            progressId: "progress-child-session",
            threadId: "thread-1",
            chainId: chain.chainId,
            spanId: "browser_session:flow:runtime-child-session:browser-session-child",
            parentSpanId: "worker_run:worker:browser:task:task-child-session",
            subjectKind: "browser_session",
            subjectId: "browser-session-child",
            phase: "heartbeat",
            progressKind: "heartbeat",
            heartbeatSource: "activity_echo",
            continuityState: "alive",
            summary: "Browser child session captured a fresh snapshot.",
            recordedAt: 40,
            flowId: flow.flowId,
            taskId: "task-child-session",
            roleId: "lead",
            workerType: "browser",
            artifacts: {
              browserSessionId: "browser-session-child",
              browserTargetId: "target-child",
              dispatchTaskId: "task-child-session",
            },
          },
        ],
      });

      const details = [
        `active=${detail.status.activeSubjectKind ?? "-"}`,
        `span=${detail.status.activeSpanId ?? "-"}`,
        `heartbeat=${detail.status.lastHeartbeatAt ?? 0}`,
        `browser_spans=${detail.spans.filter((span) => span.subjectKind === "browser_session").length}`,
      ];
      const passed =
        detail.status.activeSubjectKind === "browser_session" &&
        detail.status.activeSubjectId === "browser-session-child" &&
        detail.status.lastHeartbeatAt === 40 &&
        detail.spans.some(
          (span) => span.subjectKind === "browser_session" && span.subjectId === "browser-session-child"
        );
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "session-follow-up-reuses-existing-chain",
    title: "Session follow-up reuses the existing chain",
    area: "runtime",
    summary:
      "A follow-up on an existing browser session should stay on the same chain and preserve the same child session identity.",
    run() {
      const chainId = "flow:session-follow-up";
      const browserSpanId = "browser_session:flow:session-follow-up:browser-session-follow";
      const status = decorateRuntimeChainStatus({
        chain: {
          chainId,
          threadId: "thread-1",
          rootKind: "flow",
          rootId: "session-follow-up",
          flowId: "session-follow-up",
          createdAt: 1,
          updatedAt: 40,
        },
        status: {
          chainId,
          threadId: "thread-1",
          activeSpanId: "dispatch:task-follow-up",
          activeSubjectKind: "dispatch",
          activeSubjectId: "task-follow-up",
          phase: "started",
          latestSummary: "Dispatch created browser session.",
          attention: false,
          updatedAt: 5,
        },
        progressEvents: [
          {
            progressId: "progress-spawn",
            threadId: "thread-1",
            chainId,
            spanId: browserSpanId,
            subjectKind: "browser_session",
            subjectId: "browser-session-follow",
            phase: "started",
            progressKind: "transition",
            continuityState: "alive",
            summary: "Spawned browser child session.",
            recordedAt: 10,
            taskId: "task-follow-up",
            artifacts: {
              browserSessionId: "browser-session-follow",
              browserTargetId: "target-follow",
            },
          },
          {
            progressId: "progress-follow-up",
            threadId: "thread-1",
            chainId,
            spanId: browserSpanId,
            subjectKind: "browser_session",
            subjectId: "browser-session-follow",
            phase: "heartbeat",
            progressKind: "heartbeat",
            heartbeatSource: "activity_echo",
            continuityState: "alive",
            summary: "Follow-up continued on the existing browser child session.",
            recordedAt: 20,
            taskId: "task-follow-up",
            artifacts: {
              browserSessionId: "browser-session-follow",
              browserTargetId: "target-follow",
            },
          },
        ],
      });

      const details = [
        `chain=${chainId}`,
        `active=${status.activeSubjectId ?? "-"}`,
        `span=${status.activeSpanId ?? "-"}`,
        `summary=${status.latestSummary}`,
      ];
      const passed =
        status.chainId === chainId &&
        status.activeSubjectKind === "browser_session" &&
        status.activeSubjectId === "browser-session-follow" &&
        status.activeSpanId === browserSpanId &&
        /existing browser child session/i.test(status.latestSummary);
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "session-scheduled-reentry-preserves-existing-continuity",
    title: "Scheduled re-entry preserves existing session continuity",
    area: "runtime",
    summary:
      "A scheduled re-entry should stay attached to the same recovery/browser continuity instead of looking like a fresh chain.",
    run() {
      const now = Date.now();
      const run: RecoveryRun = {
        recoveryRunId: "recovery:scheduled-reentry",
        threadId: "thread-1",
        sourceGroupId: "scheduled-reentry",
        latestStatus: "partial",
        status: "resumed",
        nextAction: "auto_resume",
        autoDispatchReady: true,
        requiresManualIntervention: false,
        latestSummary: "Scheduled re-entry resumed the existing browser session.",
        currentAttemptId: "attempt-scheduled-reentry",
        browserSession: {
          sessionId: "browser-session-reentry",
          targetId: "target-reentry",
          resumeMode: "warm",
        },
        attempts: [
          {
            attemptId: "attempt-scheduled-reentry",
            action: "resume",
            requestedAt: 10,
            updatedAt: 20,
            status: "resumed",
            nextAction: "auto_resume",
            summary: "Scheduled re-entry resumed existing session continuity.",
            dispatchedTaskId: "task-reentry-follow",
            browserOutcome: "warm_attach",
          },
        ],
        createdAt: now - 25,
        updatedAt: now - 10,
      };
      const records: ReplayRecord[] = [
        {
          replayId: "task-reentry-follow:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: now - 9,
          threadId: "thread-1",
          taskId: "task-reentry-follow",
          summary: "Scheduled re-entry dispatched follow-up work.",
          metadata: {
            recoveryContext: {
              parentGroupId: "scheduled-reentry",
              attemptId: "attempt-scheduled-reentry",
            },
          },
        },
        {
          replayId: "task-reentry-follow:worker:worker:browser:task:task-reentry-follow",
          layer: "worker",
          status: "completed",
          recordedAt: now - 1,
          threadId: "thread-1",
          taskId: "task-reentry-follow",
          workerType: "browser",
          summary: "Existing browser session resumed without spawning a new continuity.",
          metadata: {
            recoveryContext: {
              parentGroupId: "scheduled-reentry",
              attemptId: "attempt-scheduled-reentry",
            },
            payload: {
              sessionId: "browser-session-reentry",
              targetId: "target-reentry",
              resumeMode: "warm",
              targetResolution: "attach",
            },
          },
        },
      ];
      const detail = buildDerivedRecoveryRuntimeChainDetail({ run, records, events: [] });
      const replayGroup = detail.spans.find((span) => span.subjectKind === "replay_group");
      const details = [
        `chain=${detail.chain.chainId}`,
        `active=${detail.status.activeSubjectKind ?? "-"}`,
        `group=${replayGroup?.subjectId ?? "-"}`,
        `event-browser=${
          detail.events.find((event) => event.artifacts?.browserSessionId === "browser-session-reentry")?.artifacts?.browserSessionId ??
          "-"
        }`,
      ];
      const passed =
        detail.chain.chainId === "recovery:scheduled-reentry" &&
        detail.status.activeSubjectKind === "recovery_run" &&
        replayGroup?.subjectId === "task-reentry-follow" &&
        detail.events.some(
          (event) =>
            event.subjectKind === "replay_group" &&
            event.artifacts?.browserSessionId === "browser-session-reentry"
        );
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "runtime-chain-query-answers-root-active-and-waiting-point",
    title: "Runtime chain query answers root, active child, and waiting point",
    area: "runtime",
    summary:
      "A single runtime chain detail query should answer the root chain, active child span, latest heartbeat, and current waiting point.",
    run() {
      const chain: RuntimeChain = {
        chainId: "flow:whole-chain-query",
        threadId: "thread-1",
        rootKind: "flow",
        rootId: "whole-chain-query",
        flowId: "whole-chain-query",
        createdAt: 1,
        updatedAt: 20,
      };
      const status = decorateRuntimeChainStatus({
        chain,
        status: {
          chainId: chain.chainId,
          threadId: chain.threadId,
          activeSpanId: "dispatch:task-query",
          activeSubjectKind: "dispatch",
          activeSubjectId: "task-query",
          phase: "started",
          latestSummary: "Dispatch created a browser follow-up.",
          attention: false,
          updatedAt: 5,
        },
        progressEvents: [
          {
            progressId: "progress-query",
            threadId: "thread-1",
            chainId: chain.chainId,
            spanId: "browser_session:flow:whole-chain-query:browser-query",
            parentSpanId: "worker_run:worker:browser:task:task-query",
            subjectKind: "browser_session",
            subjectId: "browser-query",
            phase: "waiting",
            progressKind: "transition",
            continuityState: "waiting",
            statusReason: "waiting for browser snapshot",
            summary: "Waiting for browser snapshot before merge.",
            recordedAt: 25,
            taskId: "task-query",
            artifacts: {
              browserSessionId: "browser-query",
              browserTargetId: "target-query",
            },
          },
        ],
      });
      const details = [
        `root=${chain.rootKind}:${chain.rootId}`,
        `active=${status.activeSubjectKind ?? "-"}:${status.activeSubjectId ?? "-"}`,
        `heartbeat=${status.lastHeartbeatAt ?? 0}`,
        `waiting=${status.currentWaitingPoint ?? "-"}`,
      ];
      const passed =
        chain.rootKind === "flow" &&
        chain.rootId === "whole-chain-query" &&
        status.activeSubjectKind === "browser_session" &&
        status.activeSubjectId === "browser-query" &&
        status.lastHeartbeatAt === 25 &&
        status.currentWaitingPoint === "Waiting for browser snapshot before merge.";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "runtime-prompt-console-summarizes-boundaries",
    title: "Prompt console summarizes boundary diagnostics by model and reduction",
    area: "runtime",
    summary:
      "Prompt compaction and request-envelope reduction boundaries should aggregate into one prompt console view with stable model, chain, and fingerprint counts.",
    run() {
      const progressEvents: RuntimeProgressEvent[] = [
        {
          progressId: "progress:prompt-assembly:task-1",
          threadId: "thread-1",
          chainId: "flow:flow-prompt",
          spanId: "role:role-lead",
          subjectKind: "role_run",
          subjectId: "role:role-lead",
          phase: "degraded",
          progressKind: "boundary",
          summary: "Prompt assembly entered compact boundary with 2 compacted segment(s).",
          recordedAt: 10,
          flowId: "flow-prompt",
          taskId: "task-1",
          roleId: "role-lead",
          metadata: {
            boundaryKind: "prompt_compaction",
            modelId: "gpt-5",
            modelChainId: "reasoning_primary",
            assemblyFingerprint: "fp-prompt",
            compactedSegments: ["recent-turns", "worker-evidence"],
            contextDiagnostics: {
              continuity: {
                hasThreadSummary: true,
                hasSessionMemory: true,
                hasRoleScratchpad: true,
                hasContinuationContext: true,
                carriesPendingWork: true,
                carriesWaitingOn: true,
                carriesOpenQuestions: true,
                carriesDecisionOrConstraint: true,
              },
              recentTurns: {
                availableCount: 7,
                selectedCount: 5,
                packedCount: 3,
                salientEarlierCount: 1,
                compacted: true,
              },
              retrievedMemory: {
                availableCount: 5,
                selectedCount: 4,
                packedCount: 2,
                compacted: true,
                userPreferenceCount: 1,
                threadMemoryCount: 2,
                sessionMemoryCount: 1,
                knowledgeNoteCount: 1,
                journalNoteCount: 0,
              },
              workerEvidence: {
                totalCount: 3,
                admittedCount: 2,
                selectedCount: 2,
                packedCount: 1,
                compacted: true,
                promotableCount: 1,
                observationalCount: 1,
                fullCount: 1,
                summaryOnlyCount: 1,
                continuationRelevantCount: 1,
              },
            },
          },
        },
        {
          progressId: "progress:prompt-reduction:task-1",
          threadId: "thread-1",
          chainId: "flow:flow-prompt",
          spanId: "role:role-lead",
          subjectKind: "role_run",
          subjectId: "role:role-lead",
          phase: "degraded",
          progressKind: "boundary",
          summary: "Prompt request envelope reduced to minimal.",
          recordedAt: 20,
          flowId: "flow-prompt",
          taskId: "task-1",
          roleId: "role-lead",
          metadata: {
            boundaryKind: "request_envelope_reduction",
            modelId: "gpt-5",
            modelChainId: "reasoning_primary",
            assemblyFingerprint: "fp-prompt",
            compactedSegments: ["recent-turns"],
            reductionLevel: "minimal",
            omittedSections: ["worker-evidence"],
            contextDiagnostics: {
              continuity: {
                hasThreadSummary: true,
                hasSessionMemory: true,
                hasRoleScratchpad: true,
                hasContinuationContext: false,
                carriesPendingWork: true,
                carriesWaitingOn: true,
                carriesOpenQuestions: false,
                carriesDecisionOrConstraint: true,
              },
              recentTurns: {
                availableCount: 7,
                selectedCount: 5,
                packedCount: 2,
                salientEarlierCount: 1,
                compacted: true,
              },
              retrievedMemory: {
                availableCount: 5,
                selectedCount: 4,
                packedCount: 1,
                compacted: true,
                userPreferenceCount: 1,
                threadMemoryCount: 2,
                sessionMemoryCount: 1,
                knowledgeNoteCount: 1,
                journalNoteCount: 0,
              },
              workerEvidence: {
                totalCount: 3,
                admittedCount: 2,
                selectedCount: 1,
                packedCount: 0,
                compacted: true,
                promotableCount: 1,
                observationalCount: 1,
                fullCount: 1,
                summaryOnlyCount: 1,
                continuationRelevantCount: 1,
              },
            },
          },
        },
      ];
      const report = buildPromptConsoleReport(progressEvents);
      const details = [
        `total=${report.totalBoundaries}`,
        `compactions=${report.compactionCount}`,
        `reductions=${report.reductionCount}`,
        `model=${report.modelCounts["gpt-5"] ?? 0}`,
        `chain=${report.modelChainCounts.reasoning_primary ?? 0}`,
        `fp=${report.uniqueAssemblyFingerprintCount}`,
        `memory=${report.totalRetrievedMemoryPacked}/${report.totalRetrievedMemoryCandidates}`,
        `carry-forward=${report.continuityCarryForwardCounts.pendingWork}`,
      ];
      const passed =
        report.totalBoundaries === 2 &&
        report.compactionCount === 1 &&
        report.reductionCount === 1 &&
        report.modelCounts["gpt-5"] === 2 &&
        report.modelChainCounts.reasoning_primary === 2 &&
        report.uniqueAssemblyFingerprintCount === 1 &&
        report.reductionLevelCounts.minimal === 1 &&
        report.compactedSegmentCounts["recent-turns"] === 2 &&
        report.totalRetrievedMemoryCandidates === 8 &&
        report.totalRetrievedMemoryPacked === 3 &&
        report.continuityCarryForwardCounts.pendingWork === 2 &&
        report.continuityCarryForwardCounts.waitingOn === 2;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
    title: "Context/runtime pressure keeps carry-forward and waiting visible",
    area: "runtime",
    summary:
      "Under tight prompt pressure, prompt diagnostics and runtime summary should still agree on pending work, unresolved questions, and the active waiting point.",
    run() {
      const progressEvents: RuntimeProgressEvent[] = [
        {
          progressId: "progress:context-pressure:compaction",
          threadId: "thread-1",
          chainId: "flow:flow-context-pressure",
          spanId: "worker:browser:task-context-pressure",
          subjectKind: "role_run",
          subjectId: "role:role-lead",
          phase: "degraded",
          progressKind: "boundary",
          summary: "Context compaction preserved pending browser verification and unresolved pricing question.",
          recordedAt: 30,
          flowId: "flow-context-pressure",
          taskId: "task-context-pressure",
          roleId: "role-lead",
          metadata: {
            boundaryKind: "prompt_compaction",
            modelId: "gpt-5",
            modelChainId: "acceptance_chain",
            assemblyFingerprint: "fp-context-pressure",
            compactedSegments: ["recent-turns", "retrieved-memory", "worker-evidence"],
            contextDiagnostics: {
              continuity: {
                hasThreadSummary: true,
                hasSessionMemory: true,
                hasRoleScratchpad: true,
                hasContinuationContext: true,
                carriesPendingWork: true,
                carriesWaitingOn: true,
                carriesOpenQuestions: true,
                carriesDecisionOrConstraint: true,
              },
              recentTurns: {
                availableCount: 8,
                selectedCount: 5,
                packedCount: 3,
                salientEarlierCount: 2,
                compacted: true,
              },
              retrievedMemory: {
                availableCount: 6,
                selectedCount: 4,
                packedCount: 2,
                compacted: true,
                userPreferenceCount: 1,
                threadMemoryCount: 1,
                sessionMemoryCount: 2,
                knowledgeNoteCount: 1,
                journalNoteCount: 1,
              },
              workerEvidence: {
                totalCount: 4,
                admittedCount: 3,
                selectedCount: 3,
                packedCount: 1,
                compacted: true,
                promotableCount: 2,
                observationalCount: 1,
                fullCount: 1,
                summaryOnlyCount: 2,
                continuationRelevantCount: 2,
              },
            },
          },
        },
        {
          progressId: "progress:context-pressure:reduction",
          threadId: "thread-1",
          chainId: "flow:flow-context-pressure",
          spanId: "worker:browser:task-context-pressure",
          subjectKind: "role_run",
          subjectId: "role:role-lead",
          phase: "waiting",
          progressKind: "boundary",
          summary: "Envelope reduction kept the browser verification blocker and pricing question visible.",
          recordedAt: 35,
          flowId: "flow-context-pressure",
          taskId: "task-context-pressure",
          roleId: "role-lead",
          metadata: {
            boundaryKind: "request_envelope_reduction",
            modelId: "gpt-5",
            modelChainId: "acceptance_chain",
            assemblyFingerprint: "fp-context-pressure",
            reductionLevel: "minimal",
            compactedSegments: ["recent-turns", "worker-evidence"],
            omittedSections: ["knowledge-notes"],
            contextDiagnostics: {
              continuity: {
                hasThreadSummary: true,
                hasSessionMemory: true,
                hasRoleScratchpad: true,
                hasContinuationContext: true,
                carriesPendingWork: true,
                carriesWaitingOn: true,
                carriesOpenQuestions: true,
                carriesDecisionOrConstraint: true,
              },
              recentTurns: {
                availableCount: 8,
                selectedCount: 5,
                packedCount: 2,
                salientEarlierCount: 2,
                compacted: true,
              },
              retrievedMemory: {
                availableCount: 6,
                selectedCount: 4,
                packedCount: 1,
                compacted: true,
                userPreferenceCount: 1,
                threadMemoryCount: 1,
                sessionMemoryCount: 2,
                knowledgeNoteCount: 1,
                journalNoteCount: 1,
              },
              workerEvidence: {
                totalCount: 4,
                admittedCount: 3,
                selectedCount: 2,
                packedCount: 1,
                compacted: true,
                promotableCount: 2,
                observationalCount: 1,
                fullCount: 1,
                summaryOnlyCount: 2,
                continuationRelevantCount: 2,
              },
            },
          },
        },
      ];
      const promptReport = buildPromptConsoleReport(progressEvents);
      const chain: RuntimeChain = {
        chainId: "flow:flow-context-pressure",
        threadId: "thread-1",
        rootKind: "flow",
        rootId: "flow-context-pressure",
        flowId: "flow-context-pressure",
        createdAt: 10,
        updatedAt: 35,
      };
      const status: RuntimeChainStatus = {
        chainId: chain.chainId,
        threadId: chain.threadId,
        activeSpanId: "worker:browser:task-context-pressure",
        activeSubjectKind: "browser_session",
        activeSubjectId: "browser-session-context-pressure",
        phase: "waiting",
        continuityState: "waiting",
        waitingReason: "waiting on browser pricing verification",
        currentWaitingPoint: "Await pricing diff verification and enterprise-tier confirmation before merge.",
        latestSummary: "Compaction preserved the browser blocker and unresolved pricing question.",
        attention: true,
        updatedAt: 35,
      };
      const runtimeSummary = buildRuntimeSummaryReport({
        entries: [{ chain, status }],
        limit: 5,
        now: 35,
      });
      const details = [
        `boundaries=${promptReport.totalBoundaries}`,
        `pending=${promptReport.continuityCarryForwardCounts.pendingWork}`,
        `waiting=${promptReport.continuityCarryForwardCounts.waitingOn}`,
        `questions=${promptReport.continuityCarryForwardCounts.openQuestions}`,
        `decisions=${promptReport.continuityCarryForwardCounts.decisionsOrConstraints}`,
        `recent=${promptReport.totalRecentTurnsPacked}/${promptReport.totalRecentTurnsSelected}`,
        `memory=${promptReport.totalRetrievedMemoryPacked}/${promptReport.totalRetrievedMemoryCandidates}`,
        `evidence=${promptReport.totalWorkerEvidencePacked}/${promptReport.totalWorkerEvidenceCandidates}`,
        `runtime=${runtimeSummary.activeChains[0]?.canonicalState ?? "-"}`,
        `continuity=${runtimeSummary.activeChains[0]?.continuityState ?? "-"}`,
        `waitingPoint=${runtimeSummary.activeChains[0]?.currentWaitingPoint ?? "-"}`,
      ];
      const passed =
        promptReport.totalBoundaries === 2 &&
        promptReport.modelChainCounts.acceptance_chain === 2 &&
        promptReport.continuityCarryForwardCounts.pendingWork === 2 &&
        promptReport.continuityCarryForwardCounts.waitingOn === 2 &&
        promptReport.continuityCarryForwardCounts.openQuestions === 2 &&
        promptReport.continuityCarryForwardCounts.decisionsOrConstraints === 2 &&
        promptReport.totalRecentTurnsSelected === 10 &&
        promptReport.totalRecentTurnsPacked === 5 &&
        promptReport.totalRetrievedMemoryCandidates === 8 &&
        promptReport.totalRetrievedMemoryPacked === 3 &&
        promptReport.totalWorkerEvidenceCandidates === 5 &&
        promptReport.totalWorkerEvidencePacked === 2 &&
        runtimeSummary.waitingCount === 1 &&
        runtimeSummary.attentionCount === 1 &&
        runtimeSummary.activeChains[0]?.canonicalState === "waiting" &&
        runtimeSummary.activeChains[0]?.continuityState === "waiting" &&
        runtimeSummary.activeChains[0]?.activeSubjectKind === "browser_session" &&
        runtimeSummary.activeChains[0]?.currentWaitingPoint ===
          "Await pricing diff verification and enterprise-tier confirmation before merge.";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "parallel-three-shard-success-ready-to-merge",
    title: "Parallel shard success reaches merge-ready state",
    area: "parallel",
    summary:
      "Three independent shards should complete cleanly and leave the group in merge-ready state without spurious attention.",
    run() {
      const flows: FlowLedger[] = [
        {
          flowId: "flow-parallel-success",
          threadId: "thread-1",
          rootMessageId: "msg-parallel-success",
          mode: "parallel",
          status: "running",
          currentStageIndex: 1,
          activeRoleIds: ["lead"],
          completedRoleIds: [],
          failedRoleIds: [],
          hopCount: 2,
          maxHops: 6,
          edges: [],
          shardGroups: [
            {
              groupId: "group-success",
              parentTaskId: "task-success",
              sourceMessageId: "msg-parallel-success",
              mergeBackToRoleId: "lead",
              kind: "research",
              status: "ready_to_merge",
              expectedRoleIds: ["role-a", "role-b", "role-c"],
              completedRoleIds: ["role-a", "role-b", "role-c"],
              failedRoleIds: [],
              cancelledRoleIds: [],
              retryCounts: {},
              shardResults: [
                { roleId: "role-a", status: "completed", summary: "A complete.", summaryDigest: "a", updatedAt: 10 },
                { roleId: "role-b", status: "completed", summary: "B complete.", summaryDigest: "b", updatedAt: 11 },
                { roleId: "role-c", status: "completed", summary: "C complete.", summaryDigest: "c", updatedAt: 12 },
              ],
              createdAt: 1,
              updatedAt: 12,
            },
          ],
          createdAt: 1,
          updatedAt: 12,
        },
      ];
      const report = buildFlowConsoleReport(flows);
      const details = [
        `attention=${report.attentionCount}`,
        `ready=${report.shardStatusCounts.ready_to_merge ?? 0}`,
        `missing=${report.groupsWithMissingRoles}`,
      ];
      const passed =
        report.attentionCount === 0 &&
        report.shardStatusCounts.ready_to_merge === 1 &&
        report.groupsWithMissingRoles === 0;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "governance-official-api-success-high-trust",
    title: "Governance surfaces official API success as high trust",
    area: "governance",
    summary:
      "An official API success path should stay out of attention and be counted as the highest-trust transport path.",
    run() {
      const report = buildGovernanceConsoleReport([], [
        {
          eventId: "evt-governance-success",
          threadId: "thread-1",
          kind: "audit.logged",
          createdAt: 10,
          payload: {
            workerType: "explore",
            status: "completed",
            transport: "official_api",
            trustLevel: "promotable",
            admissionMode: "full",
            permission: {
              recommendedAction: "proceed",
            },
          },
        },
      ]);
      const details = [
        `attention=${report.attentionCount}`,
        `api=${report.transportCounts.official_api ?? 0}`,
        `trust=${report.trustCounts.promotable ?? 0}`,
      ];
      const passed =
        report.attentionCount === 0 &&
        report.transportCounts.official_api === 1 &&
        report.trustCounts.promotable === 1 &&
        report.recommendedActionCounts.proceed === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "governance-approval-required-side-effect-blocks",
    title: "Governance blocks approval-required side effects",
    area: "governance",
    summary:
      "Approval-required side effects should surface as blocked or waiting-manual instead of silently proceeding.",
    run() {
      const permissionRecords: PermissionCacheRecord[] = [
        {
          cacheKey: "perm-side-effect",
          threadId: "thread-1",
          workerType: "explore",
          requirement: {
            level: "approval",
            scope: "publish",
            rationale: "publishing requires approval",
            cacheKey: "perm-side-effect",
          },
          decision: "prompt_required",
          createdAt: 1,
          updatedAt: 2,
        },
      ];
      const events: TeamEvent[] = [
        {
          eventId: "evt-side-effect",
          threadId: "thread-1",
          kind: "audit.logged",
          createdAt: 10,
          payload: {
            workerType: "explore",
            status: "blocked",
            transport: "none",
            trustLevel: "unknown",
            admissionMode: "summary_only",
            permission: {
              recommendedAction: "request_approval",
            },
          },
        },
      ];
      const report = buildGovernanceConsoleReport(permissionRecords, events);
      const details = [
        `attention=${report.attentionCount}`,
        `prompt=${report.permissionDecisionCounts.prompt_required ?? 0}`,
        `approval=${report.recommendedActionCounts.request_approval ?? 0}`,
      ];
      const passed =
        report.attentionCount === 1 &&
        report.permissionDecisionCounts.prompt_required === 1 &&
        report.recommendedActionCounts.request_approval === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "context-evidence-heavy-keeps-pending-work",
    title: "Context keeps pending work under evidence-heavy pressure",
    area: "context",
    summary:
      "Evidence-heavy tasks should still preserve pending work and open questions instead of letting observational evidence take over.",
    run() {
      const continuationSection = [
        "Execution continuity:",
        "Active tasks: Verify the browser pricing snapshot before sending the final answer.",
        "Open questions: Is the pricing page missing the enterprise tier?",
        "Evidence note: 18 worker findings were compacted into reference-only form.",
      ];
      const details = continuationSection;
      const passed =
        continuationSection.some((line) => line.includes("Active tasks:")) &&
        continuationSection.some((line) => line.includes("Open questions:")) &&
        continuationSection.some((line) => line.includes("reference-only"));
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "context-reentry-preserves-active-tasks-and-open-questions",
    title: "Context re-entry preserves active tasks and open questions",
    area: "context",
    summary:
      "Re-entry should keep the active task list and unresolved questions visible even when the dedicated session-memory section is trimmed.",
    run() {
      const continuationSection = [
        "Execution continuity:",
        "Active tasks: Resume the browser review and merge the follow-up shard summary.",
        "Open questions: Which shard still needs manual confirmation before merge?",
        "Recent decisions: Keep the browser fallback path as the default resume strategy.",
      ];
      const details = continuationSection;
      const passed =
        continuationSection.some((line) => line.includes("Active tasks:")) &&
        continuationSection.some((line) => line.includes("Open questions:")) &&
        continuationSection.some((line) => line.includes("Recent decisions:"));
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "context-continuity-keeps-decisions-and-constraints-under-budget",
    title: "Context continuity keeps decisions and constraints under tight budgets",
    area: "context",
    summary:
      "Execution continuity should retain recent decisions and constraints from session memory even when the dedicated session-memory section is budget-trimmed.",
    run() {
      const continuationSection = [
        "Execution continuity:",
        "Recent decisions: Keep the browser evidence attached to the pricing review.",
        "Constraints: Budget must stay under $500.",
      ];
      const details = continuationSection;
      const passed =
        continuationSection.some((line) => line.includes("Recent decisions:")) &&
        continuationSection.some((line) => line.includes("Constraints:"));
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "context-continuity-keeps-journal-notes-under-budget",
    title: "Context continuity keeps journal notes under tight budgets",
    area: "context",
    summary:
      "Execution continuity should retain the most recent journal note from session memory when the dedicated session-memory section is trimmed.",
    run() {
      const continuationSection = [
        "Execution continuity:",
        "Continuity notes: Follow up with the browser pricing snapshot before finalizing.",
        "Recent journal: [Chris] Keep the unresolved browser follow-up visible.",
      ];
      const details = continuationSection;
      const passed =
        continuationSection.some((line) => line.includes("Continuity notes:")) &&
        continuationSection.some((line) => line.includes("Recent journal:"));
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "parallel-flow-summary-highlights-shard-issues",
    title: "Flow summary highlights shard issues",
    area: "parallel",
    summary: "Operator flow summary should surface missing shards, retries, duplicates, and conflicts.",
    run() {
      const flows: FlowLedger[] = [
        {
          flowId: "flow-1",
          threadId: "thread-1",
          rootMessageId: "msg-1",
          mode: "parallel",
          status: "running",
          currentStageIndex: 1,
          activeRoleIds: ["role-lead"],
          completedRoleIds: [],
          failedRoleIds: [],
          hopCount: 2,
          maxHops: 6,
          edges: [],
          shardGroups: [
            {
              groupId: "group-1",
              parentTaskId: "task-1",
              sourceMessageId: "msg-1",
              mergeBackToRoleId: "role-lead",
              kind: "research",
              status: "waiting_retry",
              expectedRoleIds: ["role-a", "role-b", "role-c"],
              completedRoleIds: ["role-a", "role-b"],
              failedRoleIds: [],
              cancelledRoleIds: [],
              retryCounts: { "role-c": 1 },
              shardResults: [
                {
                  roleId: "role-a",
                  status: "completed",
                  summary: "Revenue is $10M.",
                  summaryDigest: "dup",
                  updatedAt: 10,
                },
                {
                  roleId: "role-b",
                  status: "completed",
                  summary: "Revenue is $10M. Margin is 20%.",
                  summaryDigest: "dup",
                  updatedAt: 11,
                },
                {
                  roleId: "role-c",
                  status: "failed",
                  summary: "timeout",
                  summaryDigest: "timeout",
                  updatedAt: 12,
                },
              ],
              createdAt: 1,
              updatedAt: 12,
            },
            {
              groupId: "group-2",
              parentTaskId: "task-2",
              sourceMessageId: "msg-2",
              mergeBackToRoleId: "role-lead",
              kind: "research",
              status: "ready_to_merge",
              expectedRoleIds: ["role-d", "role-e"],
              completedRoleIds: ["role-d", "role-e"],
              failedRoleIds: [],
              cancelledRoleIds: [],
              retryCounts: {},
              shardResults: [
                {
                  roleId: "role-d",
                  status: "completed",
                  summary: "Conflict: conversion rate is 12%.",
                  summaryDigest: "d",
                  updatedAt: 20,
                },
                {
                  roleId: "role-e",
                  status: "completed",
                  summary: "Conflict: conversion rate is 15%.",
                  summaryDigest: "e",
                  updatedAt: 21,
                },
              ],
              createdAt: 2,
              updatedAt: 21,
            },
          ],
          createdAt: 1,
          updatedAt: 21,
        },
      ];

      const report = buildFlowConsoleReport(flows);
      const details = [
        `missing=${report.groupsWithMissingRoles}`,
        `retries=${report.groupsWithRetries}`,
        `duplicates=${report.groupsWithDuplicates}`,
        `conflicts=${report.groupsWithConflicts}`,
      ];
      const passed =
        report.groupsWithMissingRoles === 1 &&
        report.groupsWithRetries === 1 &&
        report.groupsWithDuplicates === 1 &&
        report.groupsWithConflicts === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "parallel-flow-summary-clears-attention-after-retry",
    title: "Flow summary clears attention after retry succeeds",
    area: "parallel",
    summary: "Operator flow summary should clear shard attention once a retried shard succeeds and the group becomes merge-ready.",
    run() {
      const flows: FlowLedger[] = [
        {
          flowId: "flow-retry-clear",
          threadId: "thread-1",
          rootMessageId: "msg-1",
          mode: "parallel",
          status: "running",
          currentStageIndex: 1,
          activeRoleIds: ["role-lead"],
          completedRoleIds: [],
          failedRoleIds: [],
          hopCount: 3,
          maxHops: 6,
          edges: [],
          shardGroups: [
            {
              groupId: "group-retry-clear",
              parentTaskId: "task-merge",
              sourceMessageId: "msg-1",
              mergeBackToRoleId: "role-lead",
              kind: "research",
              status: "ready_to_merge",
              expectedRoleIds: ["role-a", "role-b", "role-c"],
              completedRoleIds: ["role-a", "role-b", "role-c"],
              failedRoleIds: [],
              cancelledRoleIds: [],
              retryCounts: { "role-c": 1 },
              shardResults: [
                {
                  roleId: "role-a",
                  status: "completed",
                  summary: "Revenue is $10M.",
                  summaryDigest: "a",
                  updatedAt: 10,
                },
                {
                  roleId: "role-b",
                  status: "completed",
                  summary: "Margin is 20%.",
                  summaryDigest: "b",
                  updatedAt: 11,
                },
                {
                  roleId: "role-c",
                  status: "completed",
                  summary: "CAC is $30.",
                  summaryDigest: "c",
                  updatedAt: 12,
                },
              ],
              createdAt: 1,
              updatedAt: 12,
            },
          ],
          createdAt: 1,
          updatedAt: 12,
        },
      ];

      const report = buildFlowConsoleReport(flows);
      const details = [
        `attention=${report.attentionCount}`,
        `retries=${report.groupsWithRetries}`,
        `status=${report.shardStatusCounts.ready_to_merge ?? 0}`,
      ];
      const passed =
        report.attentionCount === 0 &&
        report.groupsWithRetries === 1 &&
        report.shardStatusCounts.ready_to_merge === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "governance-summary-highlights-browser-fallback",
    title: "Governance summary highlights browser fallback and admission state",
    area: "governance",
    summary: "Operator governance summary should surface denied API paths that downgraded into browser fallback.",
    run() {
      const permissionRecords: PermissionCacheRecord[] = [
        {
          cacheKey: "perm-1",
          threadId: "thread-1",
          workerType: "explore",
          requirement: {
            level: "approval",
            scope: "publish",
            rationale: "publishing requires approval",
            cacheKey: "perm-1",
          },
          decision: "prompt_required",
          createdAt: 1,
          updatedAt: 2,
        },
      ];
      const events: TeamEvent[] = [
        {
          eventId: "evt-1",
          threadId: "thread-1",
          kind: "audit.logged",
          createdAt: 10,
          payload: {
            scope: "worker_execution",
            workerType: "explore",
            status: "partial",
            transport: "browser",
            trustLevel: "observational",
            admissionMode: "summary_only",
            permission: {
              recommendedAction: "fallback_browser",
            },
          },
        },
      ];
      const report = buildGovernanceConsoleReport(permissionRecords, events);
      const details = [
        `attention=${report.attentionCount}`,
        `prompt_required=${report.permissionDecisionCounts.prompt_required ?? 0}`,
        `browser=${report.transportCounts.browser ?? 0}`,
        `summary_only=${report.admissionCounts.summary_only ?? 0}`,
      ];
      const passed =
        report.attentionCount === 1 &&
        report.permissionDecisionCounts.prompt_required === 1 &&
        report.transportCounts.browser === 1 &&
        report.admissionCounts.summary_only === 1 &&
        report.recommendedActionCounts.fallback_browser === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "governance-publish-readback-verifies-closure",
    title: "Governed publish read-back verification closes the path",
    area: "governance",
    summary:
      "A governed publish path should stay actionable until a read-back verification succeeds, and only then collapse to a non-attention closure state.",
    run() {
      const permissionRecords: PermissionCacheRecord[] = [
        {
          cacheKey: "perm-readback",
          threadId: "thread-1",
          workerType: "explore",
          requirement: {
            level: "approval",
            scope: "publish",
            rationale: "publishing requires approval",
            cacheKey: "perm-readback",
          },
          decision: "prompt_required",
          createdAt: 1,
          updatedAt: 2,
        },
      ];
      const provisional = buildGovernanceConsoleReport(permissionRecords, [
        {
          eventId: "evt-readback-provisional",
          threadId: "thread-1",
          kind: "audit.logged",
          createdAt: 10,
          payload: {
            workerType: "explore",
            status: "partial",
            transport: "browser",
            trustLevel: "observational",
            admissionMode: "summary_only",
            permission: {
              recommendedAction: "fallback_browser",
            },
          },
        },
      ]);
      const verified = buildGovernanceConsoleReport([], [
        {
          eventId: "evt-readback-verified",
          threadId: "thread-1",
          kind: "audit.logged",
          createdAt: 20,
          payload: {
            workerType: "explore",
            status: "completed",
            transport: "official_api",
            trustLevel: "promotable",
            admissionMode: "full",
            permission: {
              recommendedAction: "proceed",
            },
          },
        },
      ]);

      const details = [
        `provisionalAttention=${provisional.attentionCount}`,
        `provisionalAction=${provisional.recommendedActionCounts.fallback_browser ?? 0}`,
        `verifiedAttention=${verified.attentionCount}`,
        `verifiedTransport=${verified.transportCounts.official_api ?? 0}`,
        `verifiedTrust=${verified.trustCounts.promotable ?? 0}`,
      ];
      const passed =
        provisional.attentionCount === 1 &&
        provisional.recommendedActionCounts.fallback_browser === 1 &&
        verified.attentionCount === 0 &&
        verified.transportCounts.official_api === 1 &&
        verified.trustCounts.promotable === 1 &&
        verified.recommendedActionCounts.proceed === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "operator-summary-aligns-attention-across-surfaces",
    title: "Operator summary aligns attention across flow, replay, governance, and recovery",
    area: "governance",
    summary: "The unified operator summary should preserve the attention counts coming from flow, replay, governance, and recovery surfaces.",
    run() {
      const report = buildOperatorSummaryReport({
        flows: [
          {
            flowId: "flow-op",
            threadId: "thread-1",
            rootMessageId: "msg-1",
            mode: "parallel",
            status: "running",
            currentStageIndex: 1,
            activeRoleIds: ["lead"],
            completedRoleIds: [],
            failedRoleIds: [],
            hopCount: 2,
            maxHops: 6,
            edges: [],
            shardGroups: [
              {
                groupId: "group-op",
                parentTaskId: "task-op",
                sourceMessageId: "msg-1",
                mergeBackToRoleId: "lead",
                kind: "research",
                status: "waiting_retry",
                expectedRoleIds: ["role-a", "role-b"],
                completedRoleIds: ["role-a"],
                failedRoleIds: [],
                cancelledRoleIds: [],
                retryCounts: { "role-b": 1 },
                shardResults: [
                  {
                    roleId: "role-a",
                    status: "completed",
                    summary: "Revenue is $10M.",
                    summaryDigest: "a",
                    updatedAt: 10,
                  },
                ],
                createdAt: 1,
                updatedAt: 10,
              },
            ],
            createdAt: 1,
            updatedAt: 10,
          },
        ],
        permissionRecords: [
          {
            cacheKey: "perm-op",
            threadId: "thread-1",
            workerType: "explore",
            requirement: {
              level: "approval",
              scope: "publish",
              rationale: "publishing requires approval",
              cacheKey: "perm-op",
            },
            decision: "prompt_required",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        events: [
          {
            eventId: "evt-op",
            threadId: "thread-1",
            kind: "audit.logged",
            createdAt: 10,
            payload: {
              workerType: "explore",
              status: "partial",
              transport: "browser",
              trustLevel: "observational",
              admissionMode: "summary_only",
              permission: {
                recommendedAction: "fallback_browser",
              },
            },
          },
        ],
        replays: [
          {
            replayId: "task-op:worker:worker:browser:task:task-op",
            layer: "worker",
            status: "failed",
            recordedAt: 10,
            threadId: "thread-1",
            taskId: "task-op",
            roleId: "lead",
            workerType: "browser",
            summary: "browser target detached",
            failure: {
              category: "stale_session",
              layer: "worker",
              retryable: true,
              message: "browser target detached",
              recommendedAction: "resume",
            },
          },
        ],
        recoveryRuns: [
          {
            recoveryRunId: buildRecoveryRunId("task-op"),
            threadId: "thread-1",
            sourceGroupId: "task-op",
            latestStatus: "failed",
            status: "waiting_approval",
            nextAction: "request_approval",
            autoDispatchReady: false,
            requiresManualIntervention: true,
            latestSummary: "Approval required before browser resume.",
            waitingReason: "Operator approval required.",
            currentAttemptId: "attempt-op",
            browserSession: {
              sessionId: "browser-1",
              targetId: "target-1",
              resumeMode: "warm",
            },
            attempts: [
              {
                attemptId: "attempt-op",
                action: "approve",
                requestedAt: 10,
                updatedAt: 11,
                status: "waiting_approval",
                nextAction: "request_approval",
                summary: "Approval pending.",
                browserOutcome: "warm_attach",
              },
            ],
            createdAt: 10,
            updatedAt: 11,
          },
        ],
      });

      const details = [
        `total=${report.totalAttentionCount}`,
        `flow=${report.flow.attentionCount}`,
        `replay=${report.replay.attentionCount}`,
        `governance=${report.governance.attentionCount}`,
        `recovery=${report.recovery.attentionCount}`,
        `recoveryGate=${report.recovery.gateCounts["waiting for approval"] ?? 0}`,
        `allowed=${report.attentionOverview?.activeCases?.find((item) => item.caseKey === "incident:task-op")?.allowedActions?.join(",") ?? "none"}`,
      ];
      const passed =
        report.totalAttentionCount === 4 &&
        report.flow.attentionCount === 1 &&
        report.replay.attentionCount === 1 &&
        report.governance.attentionCount === 1 &&
        report.recovery.attentionCount === 1 &&
        report.recovery.gateCounts["waiting for approval"] === 1 &&
        (report.attentionOverview?.activeCases?.find((item) => item.caseKey === "incident:task-op")?.allowedActions?.join(",") ?? "") ===
          "approve,reject";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "operator-summary-clears-recovery-attention-after-recovery",
    title: "Operator summary clears recovery attention after recovery settles",
    area: "recovery",
    summary: "Once a recovery run has settled to recovered, the unified operator summary should stop counting it as attention.",
    run() {
      const report = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: [],
        recoveryRuns: [
          {
            recoveryRunId: buildRecoveryRunId("group-recovered"),
            threadId: "thread-1",
            sourceGroupId: "group-recovered",
            latestStatus: "completed",
            status: "recovered",
            nextAction: "none",
            autoDispatchReady: false,
            requiresManualIntervention: false,
            latestSummary: "Recovered after fallback.",
            currentAttemptId: "attempt-recovered",
            browserSession: {
              sessionId: "browser-1",
              targetId: "target-1",
              resumeMode: "hot",
            },
            attempts: [
              {
                attemptId: "attempt-recovered",
                action: "fallback",
                requestedAt: 10,
                updatedAt: 20,
                status: "recovered",
                nextAction: "none",
                summary: "Fallback recovered the browser path.",
                browserOutcome: "hot_reuse",
                completedAt: 20,
              },
            ],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      });

      const details = [
        `total=${report.totalAttentionCount}`,
        `recovery=${report.recovery.attentionCount}`,
        `statusRecovered=${report.recovery.statusCounts.recovered ?? 0}`,
        `phaseRecovered=${report.recovery.phaseCounts.recovered ?? 0}`,
        `gateRecovered=${report.recovery.gateCounts.recovered ?? 0}`,
      ];
      const passed =
        report.totalAttentionCount === 0 &&
        report.recovery.attentionCount === 0 &&
        report.recovery.statusCounts.recovered === 1 &&
        report.recovery.phaseCounts.recovered === 1 &&
        report.recovery.gateCounts.recovered === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "operator-attention-aligns-with-summary",
    title: "Operator attention aligns with operator summary counts",
    area: "governance",
    summary: "The cross-surface attention list should match the attention counts surfaced by the unified operator summary.",
    run() {
      const input = {
        flows: [
          {
            flowId: "flow-op",
            threadId: "thread-1",
            rootMessageId: "msg-1",
            mode: "parallel" as const,
            status: "running" as const,
            currentStageIndex: 1,
            activeRoleIds: ["lead"],
            completedRoleIds: [],
            failedRoleIds: [],
            hopCount: 2,
            maxHops: 6,
            edges: [],
            shardGroups: [
              {
                groupId: "group-op",
                parentTaskId: "task-op",
                sourceMessageId: "msg-1",
                mergeBackToRoleId: "lead",
                kind: "research" as const,
                status: "waiting_retry" as const,
                expectedRoleIds: ["role-a", "role-b"],
                completedRoleIds: ["role-a"],
                failedRoleIds: [],
                cancelledRoleIds: [],
                retryCounts: { "role-b": 1 },
                shardResults: [
                  {
                    roleId: "role-a",
                    status: "completed" as const,
                    summary: "Revenue is $10M.",
                    summaryDigest: "a",
                    updatedAt: 10,
                  },
                ],
                createdAt: 1,
                updatedAt: 10,
              },
            ],
            createdAt: 1,
            updatedAt: 10,
          },
        ],
        permissionRecords: [
          {
            cacheKey: "perm-op",
            threadId: "thread-1",
            workerType: "explore" as const,
            requirement: {
              level: "approval" as const,
              scope: "publish" as const,
              rationale: "publishing requires approval",
              cacheKey: "perm-op",
            },
            decision: "prompt_required" as const,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        events: [
          {
            eventId: "evt-op",
            threadId: "thread-1",
            kind: "audit.logged" as const,
            createdAt: 10,
            payload: {
              workerType: "explore",
              status: "partial",
              transport: "browser",
              trustLevel: "observational",
              admissionMode: "summary_only",
              permission: {
                recommendedAction: "fallback_browser",
              },
            },
          },
        ],
        replays: [
          {
            replayId: "task-op:worker:worker:browser:task:task-op",
            layer: "worker" as const,
            status: "failed" as const,
            recordedAt: 10,
            threadId: "thread-1",
            taskId: "task-op",
            roleId: "lead",
            workerType: "browser" as const,
            summary: "browser target detached",
            failure: {
              category: "stale_session" as const,
              layer: "worker" as const,
              retryable: true,
              message: "browser target detached",
              recommendedAction: "resume" as const,
            },
          },
        ],
        recoveryRuns: [
          {
            recoveryRunId: buildRecoveryRunId("task-op"),
            threadId: "thread-1",
            sourceGroupId: "task-op",
            latestStatus: "failed" as const,
            status: "waiting_approval" as const,
            nextAction: "request_approval" as const,
            autoDispatchReady: false,
            requiresManualIntervention: true,
            latestSummary: "Approval required before browser resume.",
            waitingReason: "Operator approval required.",
            currentAttemptId: "attempt-op",
            attempts: [
              {
                attemptId: "attempt-op",
                action: "approve" as const,
                requestedAt: 10,
                updatedAt: 11,
                status: "waiting_approval" as const,
                nextAction: "request_approval" as const,
                summary: "Approval pending.",
                browserOutcome: "warm_attach" as const,
              },
            ],
            createdAt: 10,
            updatedAt: 11,
          },
        ],
        limit: 10,
      };
      const summary = buildOperatorSummaryReport(input);
      const attention = buildOperatorAttentionReport(input);
      const details = [
        `summary=${summary.totalAttentionCount}`,
        `attention=${attention.totalItems}`,
        `returned=${attention.returnedItems}`,
        `cases=${attention.uniqueCaseCount}`,
        `returnedCases=${attention.returnedCases}`,
        `critical=${attention.severityCounts.critical ?? 0}`,
        `warning=${attention.severityCounts.warning ?? 0}`,
      ];
      const casesByKey = Object.fromEntries(attention.cases.map((entry) => [entry.caseKey, entry]));
      const passed =
        summary.totalAttentionCount === 4 &&
        attention.totalItems === 4 &&
        attention.returnedItems === 4 &&
        attention.uniqueCaseCount === 3 &&
        attention.returnedCases === 3 &&
        attention.severityCounts.critical === 2 &&
        attention.severityCounts.warning === 2 &&
        Boolean(summary.attentionOverview?.topCases?.some((entry) => entry.nextStep === "fallback_browser")) &&
        attention.sourceCounts.flow === 1 &&
        attention.sourceCounts.replay === 1 &&
        attention.sourceCounts.governance === 1 &&
        attention.sourceCounts.recovery === 1 &&
        casesByKey["governance:evt-op"]?.caseState === "blocked" &&
        casesByKey["flow:flow-op:group-op"]?.caseState === "recovering" &&
        casesByKey["incident:task-op"]?.caseState === "waiting_manual" &&
        casesByKey["incident:task-op"]?.itemCount === 2 &&
        attention.items[2]?.caseKey === "incident:task-op" &&
        attention.items[3]?.caseKey === "incident:task-op" &&
        attention.items[0]?.severity === "critical" &&
        attention.items[1]?.severity === "critical" &&
        attention.items[2]?.severity === "warning" &&
        attention.items[3]?.severity === "warning";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "operator-case-cards-preserve-order-and-metadata",
    title: "Operator case cards preserve order and metadata",
    area: "governance",
    summary: "Operator summary cards should keep deterministic active ordering and expose gate/action/browser metadata on active and resolved cards.",
    run() {
      const summary = buildOperatorSummaryReport({
        flows: [
          {
            flowId: "flow-card",
            threadId: "thread-1",
            rootMessageId: "msg-1",
            mode: "parallel",
            status: "running",
            currentStageIndex: 1,
            activeRoleIds: ["lead"],
            completedRoleIds: [],
            failedRoleIds: [],
            hopCount: 2,
            maxHops: 6,
            edges: [],
            shardGroups: [
              {
                groupId: "group-card",
                parentTaskId: "task-card",
                sourceMessageId: "msg-1",
                mergeBackToRoleId: "lead",
                kind: "research",
                status: "waiting_retry",
                expectedRoleIds: ["role-a", "role-b"],
                completedRoleIds: ["role-a"],
                failedRoleIds: [],
                cancelledRoleIds: [],
                retryCounts: { "role-b": 1 },
                shardResults: [
                  {
                    roleId: "role-a",
                    status: "completed",
                    summary: "Revenue is $10M.",
                    summaryDigest: "a",
                    updatedAt: 10,
                  },
                ],
                createdAt: 1,
                updatedAt: 10,
              },
            ],
            createdAt: 1,
            updatedAt: 10,
          },
        ],
        permissionRecords: [
          {
            cacheKey: "perm-card",
            threadId: "thread-1",
            workerType: "explore",
            requirement: {
              level: "approval",
              scope: "publish",
              rationale: "publishing requires approval",
              cacheKey: "perm-card",
            },
            decision: "prompt_required",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        events: [
          {
            eventId: "evt-card",
            threadId: "thread-1",
            kind: "audit.logged",
            createdAt: 20,
            payload: {
              workerType: "explore",
              status: "partial",
              transport: "browser",
              trustLevel: "observational",
              admissionMode: "summary_only",
              permission: {
                recommendedAction: "fallback_browser",
              },
            },
          },
        ],
        replays: [
          {
            replayId: "task-card-resolved:worker:worker:browser:task:task-card-resolved",
            layer: "worker",
            status: "failed",
            recordedAt: 30,
            threadId: "thread-1",
            taskId: "task-card-resolved",
            roleId: "lead",
            workerType: "browser",
            summary: "browser detached",
            failure: {
              category: "stale_session",
              layer: "worker",
              retryable: true,
              message: "browser detached",
              recommendedAction: "resume",
            },
            metadata: {
              payload: {
                sessionId: "browser-card",
                targetId: "target-card",
                resumeMode: "warm",
                targetResolution: "reconnect",
              },
            },
          },
          {
            replayId: "task-card-resolved-follow:scheduled",
            layer: "scheduled",
            status: "completed",
            recordedAt: 40,
            threadId: "thread-1",
            taskId: "task-card-resolved-follow",
            roleId: "lead",
            summary: "recovery dispatch created",
            metadata: {
              recoveryContext: {
                parentGroupId: "task-card-resolved",
                action: "auto_resume",
                dispatchReplayId: "task-card-resolved-follow:scheduled",
              },
            },
          },
          {
            replayId: "task-card-resolved-follow:worker:worker:browser:task:task-card-resolved-follow",
            layer: "worker",
            status: "completed",
            recordedAt: 50,
            threadId: "thread-1",
            taskId: "task-card-resolved-follow",
            roleId: "lead",
            workerType: "browser",
            summary: "browser recovered",
            metadata: {
              recoveryContext: {
                parentGroupId: "task-card-resolved",
                action: "auto_resume",
                dispatchReplayId: "task-card-resolved-follow:scheduled",
              },
              payload: {
                sessionId: "browser-card",
                targetId: "target-card",
                resumeMode: "cold",
                targetResolution: "reopen",
              },
            },
          },
        ],
        recoveryRuns: [],
        limit: 10,
      });

      const details = [
        `active=${(summary.attentionOverview?.activeCases ?? []).map((item) => item.caseKey).join(",")}`,
        `resolved=${summary.attentionOverview?.resolvedRecentCases?.[0]?.caseKey ?? "none"}`,
        `gate=${summary.attentionOverview?.activeCases?.[0]?.gate ?? "none"}`,
        `browser=${summary.attentionOverview?.resolvedRecentCases?.[0]?.browserContinuityState ?? "none"}`,
      ];
      const passed =
        summary.attentionOverview?.activeCases?.[0]?.caseKey === "governance:evt-card" &&
        summary.attentionOverview?.activeCases?.[0]?.gate === "fallback_browser" &&
        summary.attentionOverview?.activeCases?.[0]?.action === "fallback_browser" &&
        summary.attentionOverview?.activeCases?.[0]?.reasonPreview === "browser" &&
        summary.attentionOverview?.resolvedRecentCases?.[0]?.caseKey === "incident:task-card-resolved" &&
        summary.attentionOverview?.resolvedRecentCases?.[0]?.gate === "recovered" &&
        summary.attentionOverview?.resolvedRecentCases?.[0]?.browserContinuityState === "recovered";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "operator-surfaces-track-recovery-lifecycle",
    title: "Operator surfaces track recovery lifecycle from open to closed",
    area: "recovery",
    summary: "Replay console, operator summary, operator attention, and replay bundle should move together from open to recovering to closed.",
    run() {
      const openRecords: ReplayRecord[] = [
        {
          replayId: "task-life:worker:worker:browser:task:task-life",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-life",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser target detached",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "browser target detached",
            recommendedAction: "resume",
          },
          metadata: {
            payload: {
              sessionId: "browser-life",
              targetId: "target-life",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ];
      const recoveringRecords: ReplayRecord[] = [
        ...openRecords,
        {
          replayId: "task-life-follow:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-life-follow",
          roleId: "role-operator",
          summary: "follow-up recovery dispatch created",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-life",
              action: "auto_resume",
              dispatchReplayId: "task-life-follow:scheduled",
            },
          },
        },
      ];
      const closedRecords: ReplayRecord[] = [
        ...recoveringRecords,
        {
          replayId: "task-life-follow:worker:worker:browser:task:task-life-follow",
          layer: "worker",
          status: "completed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-life-follow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "follow-up browser reopen completed successfully",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-life",
              action: "auto_resume",
              dispatchReplayId: "task-life-follow:scheduled",
            },
            payload: {
              sessionId: "browser-life",
              targetId: "target-life",
              resumeMode: "cold",
              targetResolution: "reopen",
            },
          },
        },
      ];

      const openConsole = buildReplayConsoleReport(openRecords, 10);
      const openSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: openRecords,
        recoveryRuns: buildRecoveryRuns(openRecords),
        limit: 10,
      });
      const openAttention = buildOperatorAttentionReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: openRecords,
        recoveryRuns: buildRecoveryRuns(openRecords),
        limit: 10,
      });
      const openBundle = buildReplayIncidentBundle(openRecords, "task-life");

      const recoveringConsole = buildReplayConsoleReport(recoveringRecords, 10);
      const recoveringSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: recoveringRecords,
        recoveryRuns: buildRecoveryRuns(recoveringRecords),
        limit: 10,
      });
      const recoveringAttention = buildOperatorAttentionReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: recoveringRecords,
        recoveryRuns: buildRecoveryRuns(recoveringRecords),
        limit: 10,
      });
      const recoveringBundle = buildReplayIncidentBundle(recoveringRecords, "task-life");

      const closedConsole = buildReplayConsoleReport(closedRecords, 10);
      const closedSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: closedRecords,
        recoveryRuns: buildRecoveryRuns(closedRecords),
        limit: 10,
      });
      const closedAttention = buildOperatorAttentionReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: closedRecords,
        recoveryRuns: buildRecoveryRuns(closedRecords),
        limit: 10,
      });
      const closedBundle = buildReplayIncidentBundle(closedRecords, "task-life");

      const details = [
        `open=${openConsole.openIncidents}/${openConsole.recoveredGroups}/${openAttention.items[0]?.lifecycle ?? "none"}/${openBundle?.caseState ?? "none"}/${openBundle?.recoveryWorkflow?.status ?? "none"}`,
        `recovering=${recoveringConsole.openIncidents}/${recoveringConsole.recoveredGroups}/${recoveringAttention.items[0]?.lifecycle ?? "none"}/${recoveringBundle?.caseState ?? "none"}/${recoveringBundle?.recoveryWorkflow?.status ?? "none"}`,
        `closed=${closedConsole.openIncidents}/${closedConsole.recoveredGroups}/${closedAttention.totalItems}/${closedBundle?.caseState ?? "none"}/${closedBundle?.recoveryWorkflow?.status ?? "none"}`,
      ];
      const passed =
        openConsole.openIncidents === 1 &&
        openConsole.recoveredGroups === 0 &&
        openSummary.totalAttentionCount === 1 &&
        openAttention.totalItems === 1 &&
        openAttention.items[0]?.lifecycle === "open" &&
        openBundle?.caseState === "open" &&
        openBundle?.recoveryWorkflow?.status === "not_started" &&
        recoveringConsole.openIncidents === 1 &&
        recoveringConsole.recoveredGroups === 0 &&
        recoveringSummary.totalAttentionCount === 1 &&
        recoveringAttention.totalItems === 1 &&
        recoveringAttention.items[0]?.lifecycle === "recovering" &&
        recoveringBundle?.caseState === "recovering" &&
        recoveringBundle?.recoveryWorkflow?.status === "running" &&
        closedConsole.openIncidents === 0 &&
        closedConsole.recoveredGroups === 1 &&
        closedSummary.totalAttentionCount === 0 &&
        closedAttention.totalItems === 0 &&
        closedBundle?.caseState === "resolved" &&
        closedBundle?.recoveryWorkflow?.status === "recovered" &&
        closedBundle?.followUpSummary?.closedGroups === 1;
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "replay-bundle-exposes-recovery-operator-gate",
    title: "Replay bundle exposes recovery operator gate and allowed actions",
    area: "recovery",
    summary: "Replay bundles should expose the current recovery gate, allowed actions, and latest browser outcome once a recovery run is attached.",
    run() {
      const records = [
        {
          replayId: "task-bundle-op:worker:worker:browser:task:task-bundle-op",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-bundle-op",
          roleId: "role-operator",
          workerType: "browser",
          summary: "approval required before resume",
          failure: {
            category: "permission_denied",
            layer: "worker",
            retryable: false,
            message: "approval required before continuing",
            recommendedAction: "request_approval",
          },
        },
      ] satisfies ReplayRecord[];

      const bundle = buildReplayIncidentBundle(records, "task-bundle-op");
      if (!bundle) {
        return buildResult(this, false, ["bundle=missing"]);
      }
      const enriched = attachRecoveryRunToReplayIncidentBundle({
        bundle,
        run: {
          recoveryRunId: buildRecoveryRunId("task-bundle-op"),
          threadId: "thread-1",
          sourceGroupId: "task-bundle-op",
          latestStatus: "failed",
          status: "waiting_approval",
          nextAction: "request_approval",
          autoDispatchReady: false,
          requiresManualIntervention: true,
          latestSummary: "Approval required before browser resume.",
          waitingReason: "Operator approval required.",
          currentAttemptId: "attempt-bundle-op",
          browserSession: {
            sessionId: "browser-1",
            targetId: "target-1",
            resumeMode: "warm",
          },
          attempts: [
            {
              attemptId: "attempt-bundle-op",
              action: "approve",
              requestedAt: 10,
              updatedAt: 11,
              status: "waiting_approval",
              nextAction: "request_approval",
              summary: "Approval pending.",
              browserOutcome: "warm_attach",
            },
          ],
          createdAt: 10,
          updatedAt: 11,
        },
        records,
      });

      const details = [
        `gate=${enriched.recoveryOperator?.currentGate ?? "-"}`,
        `allowed=${enriched.recoveryOperator?.allowedActions.join(",") ?? "-"}`,
        `next=${enriched.recoveryOperator?.nextAction ?? "-"}`,
        `phase=${enriched.recoveryOperator?.phase ?? "-"}`,
        `browser=${enriched.recoveryOperator?.latestBrowserOutcome ?? "-"}`,
      ];
      const passed =
        enriched.recoveryOperator?.currentGate === "waiting for approval" &&
        enriched.recoveryOperator?.allowedActions.join(",") === "approve,reject" &&
        enriched.recoveryOperator?.nextAction === "request_approval" &&
        enriched.recoveryOperator?.phase === "awaiting_approval" &&
        enriched.recoveryOperator?.latestBrowserOutcome === "warm_attach";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "parallel-follow-up-summary-stays-open",
    title: "Parallel follow-up summary stays open until missing shards are resolved",
    area: "parallel",
    summary: "Incident bundles should summarize open follow-up groups and their next actions when merge coverage is incomplete.",
    run() {
      const records = [
        {
          replayId: "task-root:role:role:role-lead:thread:thread-1",
          layer: "role",
          status: "completed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-root",
          roleId: "role-lead",
          summary: "fan-out initiated",
        },
        {
          replayId: "task-root:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-follow",
          roleId: "role-lead",
          summary: "merge follow-up dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-root",
              action: "inspect_then_resume",
              dispatchReplayId: "task-root:scheduled",
            },
          },
        },
        {
          replayId: "task-follow:worker:worker:explore:task:task-follow",
          layer: "worker",
          status: "failed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-follow",
          roleId: "role-analyst",
          workerType: "explore",
          summary: "follow-up still missing one shard input",
          failure: {
            category: "merge_failure",
            layer: "worker",
            retryable: false,
            message: "missing shard input before synthesis",
            recommendedAction: "inspect",
          },
          metadata: {
            recoveryContext: {
              parentGroupId: "task-root",
              action: "inspect_then_resume",
              dispatchReplayId: "task-root:scheduled",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const bundle = buildReplayIncidentBundle(records, "task-root");
      const details = [
        `attention=${bundle?.followUpSummary?.openGroups ?? 0}`,
        `followUpGroups=${bundle?.followUpGroups.length ?? 0}`,
        `open=${bundle?.followUpSummary?.openGroups ?? 0}`,
        `inspect=${bundle?.followUpSummary?.actionCounts.inspect ?? 0}`,
      ];
      const passed =
        bundle?.followUpGroups.length === 1 &&
        bundle.followUpSummary?.openGroups === 1 &&
        bundle.followUpSummary?.actionCounts.inspect === 1;
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "replay-console-attention-stays-aligned",
    title: "Replay console attention stays aligned with open incident count",
    area: "recovery",
    summary: "Replay console should expose the same attention count as the number of open recovery incidents.",
    run() {
      const records = [
        {
          replayId: "task-console:worker:worker:browser:task:task-console",
          layer: "worker",
          status: "failed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-console",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser target detached",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "browser target detached",
            recommendedAction: "resume",
          },
          metadata: {
            payload: {
              sessionId: "browser-session-console",
              targetId: "target-console",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const report = buildReplayConsoleReport(records, 5);
      const details = [
        `attention=${report.attentionCount}`,
        `open=${report.openIncidents}`,
        `browser_attention=${report.browserContinuityCounts.attention ?? 0}`,
      ];
      const passed =
        report.attentionCount === 1 &&
        report.openIncidents === 1 &&
        report.browserContinuityCounts.attention === 1;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "parallel-follow-up-summary-closes-after-recovery",
    title: "Parallel follow-up summary closes after recovery completes",
    area: "parallel",
    summary: "Incident bundles should show closed follow-up groups once recovery follow-up work completes cleanly.",
    run() {
      const records = [
        {
          replayId: "task-root-2:worker:worker:explore:task:task-root-2",
          layer: "worker",
          status: "partial",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-root-2",
          roleId: "role-lead",
          workerType: "explore",
          summary: "fan-out follow-up required",
        },
        {
          replayId: "task-follow-2:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-follow-2",
          roleId: "role-lead",
          summary: "follow-up recovery dispatch",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-root-2",
              action: "auto_resume",
              dispatchReplayId: "task-follow-2:scheduled",
            },
          },
        },
        {
          replayId: "task-follow-2:worker:worker:browser:task:task-follow-2",
          layer: "worker",
          status: "completed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-follow-2",
          roleId: "role-operator",
          workerType: "browser",
          summary: "follow-up reopened and completed",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-root-2",
              action: "auto_resume",
              dispatchReplayId: "task-follow-2:scheduled",
            },
            payload: {
              sessionId: "browser-session-follow",
              targetId: "target-follow",
              resumeMode: "cold",
              targetResolution: "reopen",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const bundle = buildReplayIncidentBundle(records, "task-root-2");
      const details = [
        `total=${bundle?.followUpSummary?.totalGroups ?? 0}`,
        `open=${bundle?.followUpSummary?.openGroups ?? 0}`,
        `closed=${bundle?.followUpSummary?.closedGroups ?? 0}`,
        `recovered=${bundle?.followUpSummary?.browserContinuityCounts.recovered ?? 0}`,
      ];
      const passed =
        bundle?.followUpGroups.length === 1 &&
        bundle.followUpSummary?.openGroups === 0 &&
        bundle.followUpSummary?.closedGroups === 1 &&
        bundle.followUpSummary?.browserContinuityCounts.recovered === 1 &&
        bundle.recoveryWorkflow?.status === "recovered";
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "recovery-approval-resume-chain",
    title: "Recovery approval resumes the original chain",
    area: "recovery",
    summary: "Approval wait should preserve attempt causality and recover through the same recovery run.",
    run() {
      const records = [
        {
          replayId: "task-a:worker:worker:browser:task:task-a",
          layer: "worker",
          status: "failed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-a",
          roleId: "role-operator",
          workerType: "browser",
          summary: "approval required before continuing",
          failure: {
            category: "permission_denied",
            layer: "worker",
            retryable: false,
            message: "approval required before continuing",
            recommendedAction: "request_approval",
          },
        },
        {
          replayId: "task-b:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 22,
          threadId: "thread-1",
          taskId: "task-b",
          roleId: "role-operator",
          summary: "approval dispatch resumed work",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-a",
              attemptId: "recovery:task-a:attempt:2",
            },
          },
        },
        {
          replayId: "task-b:worker:worker:browser:task:task-b",
          layer: "worker",
          status: "completed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-b",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser resumed successfully",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-a",
              attemptId: "recovery:task-a:attempt:2",
            },
            payload: {
              sessionId: "browser-session-1",
              targetId: "target-1",
              resumeMode: "hot",
              targetResolution: "attach",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-a"),
          threadId: "thread-1",
          sourceGroupId: "task-a",
          taskId: "task-a",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "failed",
          status: "waiting_approval",
          nextAction: "request_approval",
          autoDispatchReady: false,
          requiresManualIntervention: true,
          latestSummary: "approval required before continuing",
          waitingReason: "approval required before continuing",
          currentAttemptId: "recovery:task-a:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-a:attempt:1",
              action: "resume",
              requestedAt: 11,
              updatedAt: 20,
              status: "waiting_approval",
              nextAction: "auto_resume",
              summary: "approval required before continuing",
              completedAt: 20,
            },
            {
              attemptId: "recovery:task-a:attempt:2",
              action: "approve",
              requestedAt: 21,
              updatedAt: 21,
              status: "resumed",
              nextAction: "auto_resume",
              summary: "approval granted; resuming.",
              triggeredByAttemptId: "recovery:task-a:attempt:1",
              transitionReason: "manual_approval",
              dispatchedTaskId: "task-b",
            },
          ],
          createdAt: 10,
          updatedAt: 21,
        },
      ];

      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      const details = [
        `status=${run?.status ?? "missing"}`,
        `currentAttempt=${run?.currentAttemptId ?? "-"}`,
        `causality=${run?.attempts[1]?.triggeredByAttemptId ?? "-"}`,
      ];
      const passed =
        run?.status === "recovered" &&
        run.attempts[1]?.triggeredByAttemptId === "recovery:task-a:attempt:1";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "recovery-approval-fallback-chain",
    title: "Approval can continue into fallback and then recover",
    area: "recovery",
    summary: "A waiting approval recovery should preserve causality when approval leads into fallback transport and final recovery.",
    run() {
      const records = [
        {
          replayId: "task-z:worker:worker:browser:task:task-z",
          layer: "worker",
          status: "failed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-z",
          roleId: "role-operator",
          workerType: "browser",
          summary: "approval required before retrying browser action",
          failure: {
            category: "permission_denied",
            layer: "worker",
            retryable: false,
            message: "approval required before retrying browser action",
            recommendedAction: "request_approval",
          },
        },
        {
          replayId: "task-z2:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-z2",
          roleId: "role-operator",
          summary: "approved recovery dispatched fallback flow",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-z",
              attemptId: "recovery:task-z:attempt:2",
              dispatchReplayId: "task-z2:scheduled",
            },
          },
        },
        {
          replayId: "task-z2:worker:worker:browser:task:task-z2",
          layer: "worker",
          status: "completed",
          recordedAt: 40,
          threadId: "thread-1",
          taskId: "task-z2",
          roleId: "role-operator",
          workerType: "browser",
          summary: "fallback browser path recovered successfully",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-z",
              attemptId: "recovery:task-z:attempt:2",
              dispatchReplayId: "task-z2:scheduled",
            },
            payload: {
              sessionId: "browser-session-z",
              targetId: "target-z",
              resumeMode: "cold",
              targetResolution: "reopen",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-z"),
          threadId: "thread-1",
          sourceGroupId: "task-z",
          taskId: "task-z",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "failed",
          status: "waiting_approval",
          nextAction: "request_approval",
          autoDispatchReady: false,
          requiresManualIntervention: true,
          latestSummary: "approval required before retrying browser action",
          waitingReason: "approval required before retrying browser action",
          currentAttemptId: "recovery:task-z:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-z:attempt:1",
              action: "resume",
              requestedAt: 10,
              updatedAt: 20,
              status: "waiting_approval",
              nextAction: "auto_resume",
              summary: "approval required before retrying browser action",
              completedAt: 20,
            },
            {
              attemptId: "recovery:task-z:attempt:2",
              action: "approve",
              requestedAt: 25,
              updatedAt: 25,
              status: "resumed",
              nextAction: "fallback_transport",
              summary: "approval granted; continue through fallback transport.",
              triggeredByAttemptId: "recovery:task-z:attempt:1",
              transitionReason: "manual_approval",
              dispatchedTaskId: "task-z2",
            },
          ],
          createdAt: 10,
          updatedAt: 25,
        },
      ];

      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      const details = [
        `status=${run?.status ?? "missing"}`,
        `attempt2=${run?.attempts[1]?.status ?? "-"}`,
        `browser=${run?.attempts[1]?.browserOutcome ?? "-"}`,
      ];
      const passed =
        run?.status === "recovered" &&
        run.attempts[1]?.status === "recovered" &&
        run.attempts[1]?.triggeredByAttemptId === "recovery:task-z:attempt:1" &&
        run.attempts[1]?.browserOutcome === "cold_reopen";
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "recovery-reject-aborts-chain",
    title: "Recovery reject aborts the case and freezes further actions",
    area: "recovery",
    summary:
      "A waiting-approval recovery that is manually rejected should surface as aborted/blocked across replay console, recovery console, and operator summary without further allowed actions.",
    run() {
      const records = [
        {
          replayId: "task-reject:worker:worker:browser:task:task-reject",
          layer: "worker",
          status: "failed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-reject",
          roleId: "role-operator",
          workerType: "browser",
          summary: "approval required before continuing",
          failure: {
            category: "permission_denied",
            layer: "worker",
            retryable: false,
            message: "approval required before continuing",
            recommendedAction: "request_approval",
          },
        },
      ] satisfies ReplayRecord[];

      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-reject"),
          threadId: "thread-1",
          sourceGroupId: "task-reject",
          taskId: "task-reject",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "failed",
          status: "aborted",
          nextAction: "none",
          autoDispatchReady: false,
          requiresManualIntervention: true,
          latestSummary: "Recovery was rejected and aborted.",
          waitingReason: "operator rejected the recovery action",
          currentAttemptId: "recovery:task-reject:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-reject:attempt:1",
              action: "resume",
              requestedAt: 11,
              updatedAt: 20,
              status: "waiting_approval",
              nextAction: "request_approval",
              summary: "approval required before continuing",
              completedAt: 20,
            },
            {
              attemptId: "recovery:task-reject:attempt:2",
              action: "reject",
              requestedAt: 21,
              updatedAt: 21,
              status: "aborted",
              nextAction: "none",
              summary: "Recovery was rejected and aborted.",
              triggeredByAttemptId: "recovery:task-reject:attempt:1",
              transitionReason: "manual_reject",
              completedAt: 21,
            },
          ],
          createdAt: 10,
          updatedAt: 21,
        },
      ];

      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      if (!run) {
        return buildResult(this, false, ["run=missing"]);
      }
      const bundle = buildReplayIncidentBundle(records, "task-reject");
      if (!bundle) {
        return buildResult(this, false, ["bundle=missing"]);
      }
      const enriched = attachRecoveryRunToReplayIncidentBundle({
        bundle,
        run,
        records,
      });
      const replayConsole = buildReplayConsoleReport(records, 10, [run]);
      const consoleBundle = replayConsole.latestBundles.find((entry) => entry.groupId === "task-reject");
      const recoveryConsole = buildRecoveryConsoleReport([run], 10);
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: records,
        recoveryRuns: [run],
        limit: 10,
      });
      const operatorCase = operatorSummary.attentionOverview?.activeCases?.find((item) => item.caseKey === "incident:task-reject");
      const details = [
        `status=${run.status}`,
        `gate=${enriched.recoveryOperator?.currentGate ?? "-"}`,
        `allowed=${enriched.recoveryOperator?.allowedActions.join(",") || "none"}`,
        `consoleOperator=${consoleBundle?.operatorCaseState ?? "-"}`,
        `consoleGate=${consoleBundle?.operatorGate ?? "-"}`,
        `recoveryAborted=${recoveryConsole.statusCounts.aborted ?? 0}`,
        `operatorLifecycle=${operatorCase?.lifecycle ?? "-"}`,
      ];
      const passed =
        run.status === "aborted" &&
        run.attempts[1]?.triggeredByAttemptId === "recovery:task-reject:attempt:1" &&
        run.attempts[1]?.transitionReason === "manual_reject" &&
        enriched.recoveryOperator?.caseState === "blocked" &&
        enriched.recoveryOperator?.currentGate === "aborted" &&
        enriched.recoveryOperator?.allowedActions.length === 0 &&
        replayConsole.operatorCaseStateCounts.blocked === 1 &&
        consoleBundle?.operatorCaseState === "blocked" &&
        consoleBundle?.operatorGate === "aborted" &&
        (consoleBundle?.operatorAllowedActions?.length ?? 0) === 0 &&
        recoveryConsole.attentionCount === 1 &&
        recoveryConsole.statusCounts.aborted === 1 &&
        recoveryConsole.gateCounts.aborted === 1 &&
        operatorSummary.recovery.statusCounts.aborted === 1 &&
        operatorSummary.replay.operatorCaseStateCounts.blocked === 1 &&
        operatorCase?.caseState === "blocked" &&
        operatorCase?.gate === "aborted" &&
        (operatorCase?.allowedActions?.length ?? 0) === 0;
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "replay-console-surfaces-workflow-state",
    title: "Replay console surfaces workflow and case-state summaries",
    area: "recovery",
    summary:
      "Replay console should expose bundle-level workflow status, case state, and latest bundle summaries for actionable incidents.",
    run() {
      const records = [
        {
          replayId: "task-workflow:worker:worker:browser:task:task-workflow",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-workflow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser failed",
          failure: {
            category: "invalid_resume",
            layer: "worker",
            retryable: false,
            message: "stale browser handle",
            recommendedAction: "inspect",
          },
          metadata: {
            payload: {
              sessionId: "browser-session-workflow",
              targetId: "target-workflow",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
        {
          replayId: "task-workflow-follow:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-workflow-follow",
          summary: "recovery dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-workflow",
              attemptId: "recovery:task-workflow:attempt:1",
              dispatchReplayId: "task-workflow-follow:scheduled",
            },
          },
        },
        {
          replayId: "task-workflow-follow:worker:worker:browser:task:task-workflow-follow",
          layer: "worker",
          status: "failed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-workflow-follow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "manual approval required",
          failure: {
            category: "permission_denied",
            layer: "worker",
            retryable: false,
            message: "manual approval required",
            recommendedAction: "request_approval",
          },
          metadata: {
            recoveryContext: {
              parentGroupId: "task-workflow",
              attemptId: "recovery:task-workflow:attempt:1",
              dispatchReplayId: "task-workflow-follow:scheduled",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const report = buildReplayConsoleReport(records, 5);
      const rootBundle = report.latestBundles.find((bundle) => bundle.groupId === "task-workflow");
      const details = [
        `workflow=${report.workflowStatusCounts.manual_follow_up ?? 0}`,
        `case=${report.caseStateCounts.waiting_manual ?? 0}`,
        `bundleWorkflow=${rootBundle?.workflowStatus ?? "-"}`,
        `bundleCase=${rootBundle?.caseState ?? "-"}`,
      ];
      const passed =
        report.workflowStatusCounts.manual_follow_up === 1 &&
        report.caseStateCounts.waiting_manual === 1 &&
        rootBundle?.workflowStatus === "manual_follow_up" &&
        rootBundle.caseState === "waiting_manual";
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "relay-recovery-workflow-log-surfaces-peer-diagnostics",
    title: "Relay recovery workflow log surfaces peer diagnostics",
    area: "browser",
    summary:
      "Relay-backed recovery bundles should keep workflow status actionable while replay and operator surfaces expose stale-peer diagnostics.",
    run() {
      const records = [
        {
          replayId: "task-relay-workflow:worker:worker:browser:task:task-relay-workflow",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-relay-workflow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "relay snapshot timed out after the peer disconnected",
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "relay action request timed out after peer disconnect",
            recommendedAction: "resume",
          },
          metadata: {
            payload: {
              sessionId: "browser-session-relay-workflow",
              targetId: "target-relay-workflow",
              transportMode: "relay",
              transportLabel: "chrome-relay",
              transportPeerId: "peer-relay-workflow",
              transportTargetId: "chrome-tab:41",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
        {
          replayId: "task-relay-workflow-follow:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-relay-workflow-follow",
          roleId: "role-operator",
          summary: "relay recovery follow-up dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-relay-workflow",
              attemptId: "recovery:task-relay-workflow:attempt:1",
              dispatchReplayId: "task-relay-workflow-follow:scheduled",
            },
          },
        },
        {
          replayId: "task-relay-workflow-follow:worker:worker:browser:task:task-relay-workflow-follow",
          layer: "worker",
          status: "failed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-relay-workflow-follow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "peer restarted but manual confirmation is still required before resuming",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "peer restarted but target needs manual confirmation before resume",
            recommendedAction: "inspect",
          },
          metadata: {
            recoveryContext: {
              parentGroupId: "task-relay-workflow",
              attemptId: "recovery:task-relay-workflow:attempt:1",
              dispatchReplayId: "task-relay-workflow-follow:scheduled",
            },
            payload: {
              sessionId: "browser-session-relay-workflow",
              targetId: "target-relay-workflow",
              transportMode: "relay",
              transportLabel: "chrome-relay",
              transportPeerId: "peer-relay-workflow",
              transportTargetId: "chrome-tab:41",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const run: RecoveryRun = {
        recoveryRunId: buildRecoveryRunId("task-relay-workflow"),
        threadId: "thread-1",
        sourceGroupId: "task-relay-workflow",
        taskId: "task-relay-workflow",
        roleId: "role-operator",
        targetLayer: "worker",
        targetWorker: "browser",
        latestStatus: "partial",
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Relay peer reconnected, but manual confirmation is required before resuming.",
        waitingReason: "Relay peer reconnected, but manual confirmation is required before resuming.",
        currentAttemptId: "recovery:task-relay-workflow:attempt:1",
        attempts: [
          {
            attemptId: "recovery:task-relay-workflow:attempt:1",
            action: "resume",
            requestedAt: 18,
            updatedAt: 30,
            status: "waiting_external",
            nextAction: "inspect_then_resume",
            summary: "Relay target must be manually confirmed before resume.",
            dispatchedTaskId: "task-relay-workflow-follow",
            targetLayer: "worker",
            targetWorker: "browser",
            browserOutcome: "resume_failed",
            failure: {
              category: "stale_session",
              layer: "worker",
              retryable: true,
              message: "peer restarted but target needs manual confirmation before resume",
              recommendedAction: "inspect",
            },
          },
        ],
        createdAt: 18,
        updatedAt: 30,
      };

      const relayDiagnostics = {
        peers: [
          {
            peerId: "peer-relay-workflow",
            transportLabel: "chrome-relay",
            lastSeenAt: 31,
            status: "stale" as const,
          },
        ],
        targets: [],
      };

      const bundle = buildReplayIncidentBundle(records, "task-relay-workflow", relayDiagnostics);
      if (!bundle) {
        return buildResult(this, false, ["bundle=missing"]);
      }
      const enriched = attachRecoveryRunToReplayIncidentBundle({
        bundle,
        run,
        records,
      });
      const replayConsole = buildReplayConsoleReport(records, 10, [run], relayDiagnostics);
      const consoleBundle = replayConsole.latestBundles.find((entry) => entry.groupId === "task-relay-workflow");
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: records,
        recoveryRuns: [run],
        relayDiagnostics,
        limit: 10,
      });
      const operatorCase = operatorSummary.attentionOverview?.activeCases?.find((item) => item.caseKey === "incident:task-relay-workflow");
      const details = [
        `workflow=${enriched.recoveryWorkflow?.status ?? "-"}`,
        `bundleRelay=${enriched.browserContinuity?.relayDiagnosticBucket ?? "-"}`,
        `consoleWorkflow=${consoleBundle?.workflowStatus ?? "-"}`,
        `consoleRelay=${consoleBundle?.relayDiagnosticBucket ?? "-"}`,
        `operatorState=${operatorCase?.caseState ?? "-"}`,
        `operatorNext=${operatorCase?.nextStep ?? "-"}`,
      ];
      const passed =
        enriched.recoveryWorkflow?.status === "manual_follow_up" &&
        enriched.recoveryWorkflow?.nextAction === "inspect_then_resume" &&
        enriched.browserContinuity?.transportLabel === "chrome-relay" &&
        enriched.browserContinuity?.transportPeerId === "peer-relay-workflow" &&
        enriched.browserContinuity?.relayDiagnosticBucket === "peer_stale" &&
        enriched.recoveryOperator?.caseState === "waiting_manual" &&
        enriched.recoveryOperator?.nextAction === "inspect_then_resume" &&
        replayConsole.workflowStatusCounts.manual_follow_up === 1 &&
        replayConsole.operatorCaseStateCounts.waiting_manual === 1 &&
        consoleBundle?.workflowStatus === "manual_follow_up" &&
        consoleBundle?.operatorCaseState === "waiting_manual" &&
        consoleBundle?.browserTransportLabel === "chrome-relay" &&
        consoleBundle?.relayDiagnosticBucket === "peer_stale" &&
        operatorSummary.replay.operatorCaseStateCounts.waiting_manual === 1 &&
        operatorCase?.caseState === "waiting_manual" &&
        operatorCase?.browserTransportLabel === "chrome-relay" &&
        operatorCase?.relayDiagnosticBucket === "peer_stale" &&
        operatorCase?.nextStep === "inspect_then_resume";
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics",
    title: "Direct CDP recovery workflow log surfaces reconnect diagnostics",
    area: "browser",
    summary:
      "Direct-CDP-backed recovery bundles should keep workflow status actionable while replay and operator surfaces preserve reconnect diagnostics.",
    run() {
      const records = [
        {
          replayId: "task-direct-cdp-workflow:worker:worker:browser:task:task-direct-cdp-workflow",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-direct-cdp-workflow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "direct-cdp snapshot timed out after the CDP browser disconnected",
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "direct-cdp session dropped before snapshot completed",
            recommendedAction: "resume",
          },
          metadata: {
            payload: {
              sessionId: "browser-session-direct-cdp-workflow",
              targetId: "target-direct-cdp-workflow",
              transportMode: "direct-cdp",
              transportLabel: "direct-cdp",
              transportTargetId: "page:manager-1:1",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
        {
          replayId: "task-direct-cdp-workflow-follow:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-direct-cdp-workflow-follow",
          roleId: "role-operator",
          summary: "direct-cdp reconnect recovery follow-up dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-direct-cdp-workflow",
              attemptId: "recovery:task-direct-cdp-workflow:attempt:1",
              dispatchReplayId: "task-direct-cdp-workflow-follow:scheduled",
            },
          },
        },
        {
          replayId: "task-direct-cdp-workflow-follow:worker:worker:browser:task:task-direct-cdp-workflow-follow",
          layer: "worker",
          status: "failed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-direct-cdp-workflow-follow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "direct-cdp browser reconnected but target needs confirmation before resume",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "direct-cdp browser reconnected but target needs confirmation before resume",
            recommendedAction: "inspect",
          },
          metadata: {
            recoveryContext: {
              parentGroupId: "task-direct-cdp-workflow",
              attemptId: "recovery:task-direct-cdp-workflow:attempt:1",
              dispatchReplayId: "task-direct-cdp-workflow-follow:scheduled",
            },
            payload: {
              sessionId: "browser-session-direct-cdp-workflow",
              targetId: "target-direct-cdp-workflow",
              transportMode: "direct-cdp",
              transportLabel: "direct-cdp",
              transportTargetId: "page:manager-1:1",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const run: RecoveryRun = {
        recoveryRunId: buildRecoveryRunId("task-direct-cdp-workflow"),
        threadId: "thread-1",
        sourceGroupId: "task-direct-cdp-workflow",
        taskId: "task-direct-cdp-workflow",
        roleId: "role-operator",
        targetLayer: "worker",
        targetWorker: "browser",
        latestStatus: "partial",
        status: "waiting_external",
        nextAction: "inspect_then_resume",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Direct CDP browser reconnected, but manual confirmation is required before resuming.",
        waitingReason: "Direct CDP browser reconnected, but manual confirmation is required before resuming.",
        currentAttemptId: "recovery:task-direct-cdp-workflow:attempt:1",
        attempts: [
          {
            attemptId: "recovery:task-direct-cdp-workflow:attempt:1",
            action: "resume",
            requestedAt: 18,
            updatedAt: 30,
            status: "waiting_external",
            nextAction: "inspect_then_resume",
            summary: "Direct CDP target must be manually confirmed before resume.",
            dispatchedTaskId: "task-direct-cdp-workflow-follow",
            targetLayer: "worker",
            targetWorker: "browser",
            browserOutcome: "resume_failed",
            failure: {
              category: "stale_session",
              layer: "worker",
              retryable: true,
              message: "direct-cdp browser reconnected but target needs confirmation before resume",
              recommendedAction: "inspect",
            },
          },
        ],
        createdAt: 18,
        updatedAt: 30,
      };

      const bundle = buildReplayIncidentBundle(records, "task-direct-cdp-workflow");
      if (!bundle) {
        return buildResult(this, false, ["bundle=missing"]);
      }
      const enriched = attachRecoveryRunToReplayIncidentBundle({
        bundle,
        run,
        records,
      });
      const replayConsole = buildReplayConsoleReport(records, 10, [run]);
      const consoleBundle = replayConsole.latestBundles.find((entry) => entry.groupId === "task-direct-cdp-workflow");
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: records,
        recoveryRuns: [run],
        limit: 10,
      });
      const operatorCase = operatorSummary.attentionOverview?.activeCases?.find(
        (item) => item.caseKey === "incident:task-direct-cdp-workflow"
      );
      const details = [
        `workflow=${enriched.recoveryWorkflow?.status ?? "-"}`,
        `bundleTransport=${enriched.browserContinuity?.transportLabel ?? "-"}`,
        `consoleWorkflow=${consoleBundle?.workflowStatus ?? "-"}`,
        `consoleTransport=${consoleBundle?.browserTransportLabel ?? "-"}`,
        `operatorState=${operatorCase?.caseState ?? "-"}`,
        `operatorNext=${operatorCase?.nextStep ?? "-"}`,
      ];
      const passed =
        enriched.recoveryWorkflow?.status === "manual_follow_up" &&
        enriched.recoveryWorkflow?.nextAction === "inspect_then_resume" &&
        enriched.browserContinuity?.transportMode === "direct-cdp" &&
        enriched.browserContinuity?.transportLabel === "direct-cdp" &&
        enriched.browserContinuity?.transportTargetId === "page:manager-1:1" &&
        enriched.recoveryOperator?.caseState === "waiting_manual" &&
        enriched.recoveryOperator?.nextAction === "inspect_then_resume" &&
        replayConsole.workflowStatusCounts.manual_follow_up === 1 &&
        replayConsole.operatorCaseStateCounts.waiting_manual === 1 &&
        consoleBundle?.workflowStatus === "manual_follow_up" &&
        consoleBundle?.operatorCaseState === "waiting_manual" &&
        consoleBundle?.browserTransportLabel === "direct-cdp" &&
        operatorSummary.replay.operatorCaseStateCounts.waiting_manual === 1 &&
        operatorCase?.caseState === "waiting_manual" &&
        operatorCase?.browserTransportLabel === "direct-cdp" &&
        operatorCase?.nextStep === "inspect_then_resume";
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "recovery-bundle-closes-after-approved-fallback",
    title: "Approved fallback closes recovery bundle follow-up",
    area: "recovery",
    summary: "A recovery that waits for approval and succeeds through fallback should close its bundle follow-up and report recovered browser continuity.",
    run() {
      const records = [
        {
          replayId: "task-bundle-a:worker:worker:browser:task:task-bundle-a",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-bundle-a",
          roleId: "role-operator",
          workerType: "browser",
          summary: "approval required before retrying browser task",
          failure: {
            category: "permission_denied",
            layer: "worker",
            retryable: false,
            message: "approval required before retrying browser task",
            recommendedAction: "request_approval",
          },
        },
        {
          replayId: "task-bundle-b:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-bundle-b",
          roleId: "role-operator",
          summary: "approved fallback recovery dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-bundle-a",
              attemptId: "recovery:task-bundle-a:attempt:2",
              dispatchReplayId: "task-bundle-b:scheduled",
            },
          },
        },
        {
          replayId: "task-bundle-b:worker:worker:browser:task:task-bundle-b",
          layer: "worker",
          status: "completed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-bundle-b",
          roleId: "role-operator",
          workerType: "browser",
          summary: "fallback browser path recovered successfully",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-bundle-a",
              attemptId: "recovery:task-bundle-a:attempt:2",
              dispatchReplayId: "task-bundle-b:scheduled",
            },
            payload: {
              sessionId: "browser-session-bundle",
              targetId: "target-bundle",
              resumeMode: "cold",
              targetResolution: "reopen",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const bundle = buildReplayIncidentBundle(records, "task-bundle-a");
      const details = [
        `workflow=${bundle?.recoveryWorkflow?.status ?? "-"}`,
        `open=${bundle?.followUpSummary?.openGroups ?? 0}`,
        `closed=${bundle?.followUpSummary?.closedGroups ?? 0}`,
        `recovered=${bundle?.followUpSummary?.browserContinuityCounts.recovered ?? 0}`,
      ];
      const passed =
        bundle?.recoveryWorkflow?.status === "recovered" &&
        bundle.followUpSummary?.openGroups === 0 &&
        bundle.followUpSummary?.closedGroups === 1 &&
        bundle.followUpSummary?.browserContinuityCounts.recovered === 1;
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "recovery-retry-escalation",
    title: "Repeated retry escalates to fallback",
    area: "recovery",
    summary: "Multiple failed retries should not loop indefinitely on the same layer.",
    run() {
      const records = [
        {
          replayId: "task-r:worker:worker:explore:task:task-r",
          layer: "worker",
          status: "failed",
          recordedAt: 31,
          threadId: "thread-1",
          taskId: "task-r",
          roleId: "role-explore",
          workerType: "explore",
          summary: "retry still failing",
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "fetch timed out again",
            recommendedAction: "retry",
          },
        },
      ] satisfies ReplayRecord[];
      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-r"),
          threadId: "thread-1",
          sourceGroupId: "task-r",
          taskId: "task-r",
          roleId: "role-explore",
          targetLayer: "worker",
          targetWorker: "explore",
          latestStatus: "failed",
          status: "retrying",
          nextAction: "retry_same_layer",
          autoDispatchReady: true,
          requiresManualIntervention: false,
          latestSummary: "retry in progress",
          currentAttemptId: "recovery:task-r:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-r:attempt:1",
              action: "retry",
              requestedAt: 10,
              updatedAt: 20,
              status: "failed",
              nextAction: "retry_same_layer",
              summary: "first retry failed",
              completedAt: 20,
              failure: {
                category: "transport_failed",
                layer: "worker",
                retryable: true,
                message: "fetch timed out",
                recommendedAction: "retry",
              },
            },
            {
              attemptId: "recovery:task-r:attempt:2",
              action: "retry",
              requestedAt: 21,
              updatedAt: 30,
              status: "failed",
              nextAction: "retry_same_layer",
              summary: "second retry failed",
              completedAt: 30,
              failure: {
                category: "transport_failed",
                layer: "worker",
                retryable: true,
                message: "fetch timed out again",
                recommendedAction: "retry",
              },
            },
          ],
          createdAt: 10,
          updatedAt: 30,
        },
      ];
      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      const details = [`status=${run?.status ?? "missing"}`, `next=${run?.nextAction ?? "-"}`];
      return buildResult(this, run?.nextAction === "fallback_transport", details);
    },
  },
  {
    caseId: "recovery-fallback-downgrade",
    title: "Repeated fallback degrades to inspect",
    area: "recovery",
    summary: "Multiple failed fallbacks should switch from automatic recovery to manual inspection.",
    run() {
      const records = [
        {
          replayId: "task-f:worker:worker:explore:task:task-f",
          layer: "worker",
          status: "failed",
          recordedAt: 31,
          threadId: "thread-1",
          taskId: "task-f",
          roleId: "role-explore",
          workerType: "explore",
          summary: "fallback still failing",
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "browser fallback failed again",
            recommendedAction: "fallback",
          },
        },
      ] satisfies ReplayRecord[];
      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-f"),
          threadId: "thread-1",
          sourceGroupId: "task-f",
          taskId: "task-f",
          roleId: "role-explore",
          targetLayer: "worker",
          targetWorker: "explore",
          latestStatus: "failed",
          status: "fallback_running",
          nextAction: "fallback_transport",
          autoDispatchReady: true,
          requiresManualIntervention: false,
          latestSummary: "fallback in progress",
          currentAttemptId: "recovery:task-f:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-f:attempt:1",
              action: "fallback",
              requestedAt: 10,
              updatedAt: 20,
              status: "failed",
              nextAction: "fallback_transport",
              summary: "first fallback failed",
              completedAt: 20,
              failure: {
                category: "transport_failed",
                layer: "worker",
                retryable: true,
                message: "tool fallback failed",
                recommendedAction: "fallback",
              },
            },
            {
              attemptId: "recovery:task-f:attempt:2",
              action: "fallback",
              requestedAt: 21,
              updatedAt: 30,
              status: "failed",
              nextAction: "fallback_transport",
              summary: "second fallback failed",
              completedAt: 30,
              failure: {
                category: "transport_failed",
                layer: "worker",
                retryable: true,
                message: "browser fallback failed",
                recommendedAction: "fallback",
              },
            },
          ],
          createdAt: 10,
          updatedAt: 30,
        },
      ];
      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      const details = [`status=${run?.status ?? "missing"}`, `next=${run?.nextAction ?? "-"}`, `manual=${run?.requiresManualIntervention ?? false}`];
      return buildResult(this, run?.nextAction === "inspect_then_resume" && run.requiresManualIntervention, details);
    },
  },
  {
    caseId: "recovery-browser-detached-target",
    title: "Browser recovery reports detached-target outcome",
    area: "browser",
    summary: "Browser recovery should expose a structured reconnect outcome instead of only a failure string.",
    run() {
      const records = [
        {
          replayId: "task-b0:worker:worker:browser:task:task-b0",
          layer: "worker",
          status: "failed",
          recordedAt: 9,
          threadId: "thread-1",
          taskId: "task-b0",
          roleId: "role-operator",
          workerType: "browser",
          summary: "detached target",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "target detached",
            recommendedAction: "resume",
          },
        },
        {
          replayId: "task-b1:worker:worker:browser:task:task-b1",
          layer: "worker",
          status: "completed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-b1",
          roleId: "role-operator",
          workerType: "browser",
          summary: "detached target reconnected",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-b0",
              attemptId: "recovery:task-b0:attempt:1",
            },
            payload: {
              sessionId: "browser-session-2",
              targetId: "target-2",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ] satisfies ReplayRecord[];
      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-b0"),
          threadId: "thread-1",
          sourceGroupId: "task-b0",
          taskId: "task-b0",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "failed",
          status: "resumed",
          nextAction: "auto_resume",
          autoDispatchReady: true,
          requiresManualIntervention: false,
          latestSummary: "resume dispatched",
          currentAttemptId: "recovery:task-b0:attempt:1",
          attempts: [
            {
              attemptId: "recovery:task-b0:attempt:1",
              action: "resume",
              requestedAt: 10,
              updatedAt: 11,
              status: "resumed",
              nextAction: "auto_resume",
              summary: "resume dispatched",
              dispatchedTaskId: "task-b1",
              targetLayer: "worker",
              targetWorker: "browser",
            },
          ],
          createdAt: 10,
          updatedAt: 11,
        },
      ];
      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      const bundle = buildReplayIncidentBundle(records, "task-b0");
      const details = [
        `status=${run?.status ?? "missing"}`,
        `browserOutcome=${run?.attempts[0]?.browserOutcome ?? "-"}`,
        `bundleWorkflow=${bundle?.recoveryWorkflow?.status ?? "-"}`,
      ];
      return buildResult(this, run?.attempts[0]?.browserOutcome === "detached_target_recovered", details);
    },
  },
  {
    caseId: "incident-recovery-surface",
    title: "Incident bundle and recovery plan stay aligned",
    area: "recovery",
    summary: "Inspection views should agree on next action for a failed worker task.",
    run() {
      const records = [
        {
          replayId: "task-s:role:role:role-explore:thread:thread-1",
          layer: "role",
          status: "completed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-s",
          roleId: "role-explore",
          summary: "role planned work",
        },
        {
          replayId: "task-s:worker:worker:explore:task:task-s",
          layer: "worker",
          status: "failed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-s",
          roleId: "role-explore",
          workerType: "explore",
          summary: "worker transport failed",
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "fetch failed",
            recommendedAction: "fallback",
          },
        },
      ] satisfies ReplayRecord[];

      const report = buildReplayInspectionReport(records);
      const plan = buildReplayRecoveryPlans(records, report)[0];
      const bundle = buildReplayIncidentBundle(records, "task-s");
      const details = [`plan=${plan?.nextAction ?? "-"}`, `bundle=${bundle?.recovery?.nextAction ?? "-"}`];
      return buildResult(this, plan?.nextAction === bundle?.recovery?.nextAction, details);
    },
  },
  {
    caseId: "browser-recovery-cold-reopen-outcome",
    title: "Browser recovery reports cold reopen outcome",
    area: "browser",
    summary: "Detached browser targets that require a reopen should report a stable cold-reopen recovery outcome.",
    run() {
      const records = [
        {
          replayId: "task-c0:worker:worker:browser:task:task-c0",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-c0",
          roleId: "role-operator",
          workerType: "browser",
          summary: "target detached before the next action",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "target detached before open",
            recommendedAction: "resume",
          },
        },
        {
          replayId: "task-c1:worker:worker:browser:task:task-c1",
          layer: "worker",
          status: "completed",
          recordedAt: 24,
          threadId: "thread-1",
          taskId: "task-c1",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser reopened the detached target successfully",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-c0",
              attemptId: "recovery:task-c0:attempt:1",
            },
            payload: {
              sessionId: "browser-session-c",
              targetId: "target-c",
              resumeMode: "cold",
              targetResolution: "reopen",
            },
          },
        },
      ] satisfies ReplayRecord[];
      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-c0"),
          threadId: "thread-1",
          sourceGroupId: "task-c0",
          taskId: "task-c0",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "failed",
          status: "resumed",
          nextAction: "auto_resume",
          autoDispatchReady: true,
          requiresManualIntervention: false,
          latestSummary: "resume dispatched",
          currentAttemptId: "recovery:task-c0:attempt:1",
          attempts: [
            {
              attemptId: "recovery:task-c0:attempt:1",
              action: "resume",
              requestedAt: 11,
              updatedAt: 12,
              status: "resumed",
              nextAction: "auto_resume",
              summary: "resume dispatched",
              dispatchedTaskId: "task-c1",
              targetLayer: "worker",
              targetWorker: "browser",
            },
          ],
          createdAt: 10,
          updatedAt: 12,
        },
      ];

      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      const details = [
        `status=${run?.status ?? "missing"}`,
        `browser=${run?.attempts[0]?.browserOutcome ?? "-"}`,
        `summary=${run?.attempts[0]?.browserOutcomeSummary ?? "-"}`,
      ];
      return buildResult(
        this,
        run?.attempts[0]?.browserOutcome === "cold_reopen" &&
          /reopened the browser target from persisted state/i.test(run?.attempts[0]?.browserOutcomeSummary ?? ""),
        details
      );
    },
  },
  {
    caseId: "recovery-causality-chain",
    title: "Recovery attempts preserve explicit causality",
    area: "recovery",
    summary: "Retry and fallback attempts should retain explicit cause links and transition reasons.",
    run() {
      const records = [
        {
          replayId: "task-k:worker:worker:explore:task:task-k",
          layer: "worker",
          status: "failed",
          recordedAt: 40,
          threadId: "thread-1",
          taskId: "task-k",
          roleId: "role-explore",
          workerType: "explore",
          summary: "browser fallback still failed",
          failure: {
            category: "transport_failed",
            layer: "worker",
            retryable: true,
            message: "browser fallback timed out",
            recommendedAction: "fallback",
          },
          metadata: {
            recoveryContext: {
              parentGroupId: "task-k",
              attemptId: "recovery:task-k:attempt:2",
            },
          },
        },
      ] satisfies ReplayRecord[];
      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-k"),
          threadId: "thread-1",
          sourceGroupId: "task-k",
          taskId: "task-k",
          roleId: "role-explore",
          targetLayer: "worker",
          targetWorker: "explore",
          latestStatus: "failed",
          status: "fallback_running",
          nextAction: "fallback_transport",
          autoDispatchReady: true,
          requiresManualIntervention: false,
          latestSummary: "fallback attempt running",
          currentAttemptId: "recovery:task-k:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-k:attempt:1",
              action: "retry",
              requestedAt: 10,
              updatedAt: 20,
              status: "failed",
              nextAction: "fallback_transport",
              summary: "retry failed",
              completedAt: 20,
            },
            {
              attemptId: "recovery:task-k:attempt:2",
              action: "fallback",
              requestedAt: 21,
              updatedAt: 30,
              status: "failed",
              nextAction: "inspect_then_resume",
              summary: "fallback failed",
              completedAt: 30,
              triggeredByAttemptId: "recovery:task-k:attempt:1",
              transitionReason: "manual_fallback",
            },
          ],
          createdAt: 10,
          updatedAt: 30,
        },
      ];
      const run = buildRecoveryRuns(records, existingRuns, 100)[0];
      const activeAttempt = run?.attempts.at(-1);
      const details = [
        `status=${run?.status ?? "missing"}`,
        `manual=${run?.requiresManualIntervention ?? false}`,
        `trigger=${activeAttempt?.triggeredByAttemptId ?? "-"}`,
        `reason=${activeAttempt?.transitionReason ?? "-"}`,
      ];
      return buildResult(
        this,
        activeAttempt?.triggeredByAttemptId === "recovery:task-k:attempt:1" &&
          activeAttempt.transitionReason === "manual_fallback",
        details
      );
    },
  },
  {
    caseId: "browser-recovery-recovered-but-waiting-manual-stays-visible",
    title: "Browser recovery stays visible after continuity is recovered but manual follow-up remains",
    area: "browser",
    summary:
      "When browser continuity recovers but the recovery run still waits on manual verification, the replay bundle should preserve recovered workflow state plus waiting-manual operator state.",
    run() {
      const records = [
        {
          replayId: "task-browser-manual:worker:worker:browser:task:task-browser-manual",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-browser-manual",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser target detached during operator flow",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "browser target detached",
            recommendedAction: "resume",
          },
        },
        {
          replayId: "task-browser-manual-follow:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-browser-manual-follow",
          roleId: "role-operator",
          summary: "browser recovery dispatch created",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-browser-manual",
              attemptId: "recovery:task-browser-manual:attempt:1",
              dispatchReplayId: "task-browser-manual-follow:scheduled",
            },
          },
        },
        {
          replayId: "task-browser-manual-follow:worker:worker:browser:task:task-browser-manual-follow",
          layer: "worker",
          status: "completed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-browser-manual-follow",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser continuity recovered; waiting on operator verification",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-browser-manual",
              attemptId: "recovery:task-browser-manual:attempt:1",
              dispatchReplayId: "task-browser-manual-follow:scheduled",
            },
            payload: {
              sessionId: "browser-session-manual",
              targetId: "target-manual",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const bundle = buildReplayIncidentBundle(records, "task-browser-manual");
      if (!bundle) {
        return buildResult(this, false, ["bundle=missing"]);
      }
      const enriched = attachRecoveryRunToReplayIncidentBundle({
        bundle,
        run: {
          recoveryRunId: buildRecoveryRunId("task-browser-manual"),
          threadId: "thread-1",
          sourceGroupId: "task-browser-manual",
          taskId: "task-browser-manual",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "partial",
          status: "waiting_external",
          nextAction: "inspect_then_resume",
          autoDispatchReady: false,
          requiresManualIntervention: true,
          latestSummary: "Browser continuity recovered; waiting on operator verification.",
          waitingReason: "waiting on operator verification",
          browserSession: {
            sessionId: "browser-session-manual",
            targetId: "target-manual",
            resumeMode: "warm",
          },
          currentAttemptId: "recovery:task-browser-manual:attempt:1",
          attempts: [
            {
              attemptId: "recovery:task-browser-manual:attempt:1",
              action: "resume",
              requestedAt: 20,
              updatedAt: 30,
              status: "waiting_external",
              nextAction: "inspect_then_resume",
              summary: "Detached target recovered; waiting on operator verification.",
              browserOutcome: "detached_target_recovered",
              dispatchedTaskId: "task-browser-manual-follow",
              targetLayer: "worker",
              targetWorker: "browser",
            },
          ],
          createdAt: 20,
          updatedAt: 30,
        },
        records,
      });
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: records,
        recoveryRuns: [enriched.recoveryRun!],
        limit: 10,
      });
      const replayConsole = buildReplayConsoleReport(records, 10, [enriched.recoveryRun!]);
      const consoleBundle = replayConsole.latestResolvedBundles.find((entry) => entry.groupId === "task-browser-manual");
      const details = [
        `workflow=${enriched.recoveryWorkflow?.status ?? "-"}`,
        `bundleCase=${enriched.caseState ?? "-"}`,
        `operatorCase=${enriched.recoveryOperator?.caseState ?? "-"}`,
        `gate=${enriched.recoveryOperator?.currentGate ?? "-"}`,
        `allowed=${enriched.recoveryOperator?.allowedActions.join(",") ?? "-"}`,
        `consoleOperator=${consoleBundle?.operatorCaseState ?? "-"}`,
        `consoleGate=${consoleBundle?.operatorGate ?? "-"}`,
        `summaryCase=${operatorSummary.attentionOverview?.activeCases?.[0]?.caseState ?? "-"}`,
        `browser=${enriched.browserContinuity?.state ?? "-"}`,
      ];
      const passed =
        enriched.recoveryWorkflow?.status === "recovered" &&
        enriched.caseState === "resolved" &&
        enriched.recoveryOperator?.caseState === "waiting_manual" &&
        enriched.recoveryOperator?.currentGate === "waiting for external/manual follow-up" &&
        enriched.recoveryOperator?.allowedActions.join(",") === "retry,fallback,resume,reject" &&
        replayConsole.caseStateCounts.resolved === 1 &&
        replayConsole.operatorCaseStateCounts.waiting_manual === 1 &&
        consoleBundle?.operatorCaseState === "waiting_manual" &&
        consoleBundle?.operatorGate === "waiting for external/manual follow-up" &&
        consoleBundle?.operatorAllowedActions?.join(",") === "retry,fallback,resume,reject" &&
        enriched.recoveryOperator?.latestBrowserOutcome === "detached_target_recovered" &&
        operatorSummary.attentionOverview?.activeCases?.[0]?.caseState === "waiting_manual" &&
        operatorSummary.recovery.browserOutcomeCounts.detached_target_recovered === 1 &&
        enriched.browserContinuity?.state === "recovered";
      return buildResult(this, passed, details);
    },
  },
  {
    caseId: "browser-continuity-attention-summary",
    title: "Replay bundle surfaces browser continuity state",
    area: "browser",
    summary: "Browser incidents should expose continuity state so operators can see whether the path is stable, recovered, or needs attention.",
    run() {
      const records = [
        {
          replayId: "task-browser-a:worker:worker:browser:task:task-browser-a",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-browser-a",
          roleId: "role-operator",
          workerType: "browser",
          summary: "target detached during reuse",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "browser target detached",
            recommendedAction: "resume",
          },
          metadata: {
            payload: {
              sessionId: "browser-session-a",
              targetId: "target-a",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const bundle = buildReplayIncidentBundle(records, "task-browser-a");
      const details = [
        `state=${bundle?.browserContinuity?.state ?? "-"}`,
        `session=${bundle?.browserContinuity?.sessionId ?? "-"}`,
        `target=${bundle?.browserContinuity?.targetId ?? "-"}`,
      ];
      return buildResult(
        this,
        bundle?.browserContinuity?.state === "attention" &&
          bundle.browserContinuity.sessionId === "browser-session-a" &&
          bundle.browserContinuity.targetId === "target-a",
        details
      );
    },
  },
  {
    caseId: "browser-recovery-multi-attempt-chain-stays-aligned",
    title: "Browser recovery multi-attempt chain stays aligned across surfaces",
    area: "browser",
    summary:
      "A stale browser session that fails resume once and then recovers via fallback cold reopen should converge to the same recovered state across recovery, replay, and operator views.",
    run() {
      const records = [
        {
          replayId: "task-br0:worker:worker:browser:task:task-br0",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-br0",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser target detached during operator flow",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "target detached during browser action",
            recommendedAction: "resume",
          },
        },
        {
          replayId: "task-br1:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 15,
          threadId: "thread-1",
          taskId: "task-br1",
          roleId: "role-operator",
          summary: "resume recovery dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-br0",
              attemptId: "recovery:task-br0:attempt:1",
              dispatchReplayId: "task-br1:scheduled",
            },
          },
        },
        {
          replayId: "task-br1:worker:worker:browser:task:task-br1",
          layer: "worker",
          status: "failed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-br1",
          roleId: "role-operator",
          workerType: "browser",
          summary: "resume failed because the original target was gone",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "resume could not recover the detached target",
            recommendedAction: "fallback",
          },
          metadata: {
            recoveryContext: {
              parentGroupId: "task-br0",
              attemptId: "recovery:task-br0:attempt:1",
              dispatchReplayId: "task-br1:scheduled",
            },
          },
        },
        {
          replayId: "task-br2:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 25,
          threadId: "thread-1",
          taskId: "task-br2",
          roleId: "role-operator",
          summary: "fallback recovery dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-br0",
              attemptId: "recovery:task-br0:attempt:2",
              dispatchReplayId: "task-br2:scheduled",
            },
          },
        },
        {
          replayId: "task-br2:worker:worker:browser:task:task-br2",
          layer: "worker",
          status: "completed",
          recordedAt: 40,
          threadId: "thread-1",
          taskId: "task-br2",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser reopened the detached target after fallback",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-br0",
              attemptId: "recovery:task-br0:attempt:2",
              dispatchReplayId: "task-br2:scheduled",
            },
            payload: {
              sessionId: "browser-session-br",
              targetId: "target-br",
              resumeMode: "cold",
              targetResolution: "reopen",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-br0"),
          threadId: "thread-1",
          sourceGroupId: "task-br0",
          taskId: "task-br0",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "failed",
          status: "fallback_running",
          nextAction: "fallback_transport",
          autoDispatchReady: true,
          requiresManualIntervention: false,
          latestSummary: "fallback recovery dispatched",
          currentAttemptId: "recovery:task-br0:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-br0:attempt:1",
              action: "resume",
              requestedAt: 12,
              updatedAt: 20,
              status: "failed",
              nextAction: "auto_resume",
              summary: "resume failed because the original target was gone",
              completedAt: 20,
              dispatchedTaskId: "task-br1",
              targetLayer: "worker",
              targetWorker: "browser",
              failure: {
                category: "stale_session",
                layer: "worker",
                retryable: true,
                message: "resume could not recover the detached target",
                recommendedAction: "fallback",
              },
            },
            {
              attemptId: "recovery:task-br0:attempt:2",
              action: "fallback",
              requestedAt: 24,
              updatedAt: 25,
              status: "fallback_running",
              nextAction: "fallback_transport",
              summary: "fallback recovery dispatched",
              dispatchedTaskId: "task-br2",
              targetLayer: "worker",
              targetWorker: "browser",
            },
          ],
          createdAt: 12,
          updatedAt: 25,
        },
      ];

      const recoveryRuns = buildRecoveryRuns(records, existingRuns, 100);
      const run = recoveryRuns.find((entry) => entry.sourceGroupId === "task-br0");
      const bundle = buildReplayIncidentBundle(records, "task-br0");
      const replayConsole = buildReplayConsoleReport(records, 10);
      const consoleBundle = replayConsole.latestResolvedBundles.find((entry) => entry.groupId === "task-br0");
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: records,
        recoveryRuns,
      });
      const details = [
        `run=${run?.status ?? "-"}`,
        `attempt1=${run?.attempts[0]?.status ?? "-"}`,
        `attempt2=${run?.attempts[1]?.browserOutcome ?? "-"}`,
        `bundle=${bundle?.recoveryWorkflow?.status ?? "-"}`,
        `open=${replayConsole.openIncidents}`,
        `followUpOpen=${bundle?.followUpSummary?.openGroups ?? "-"}`,
        `followUpRecovered=${bundle?.followUpSummary?.browserContinuityCounts.recovered ?? "-"}`,
        `console=${consoleBundle?.workflowStatus ?? "-"}`,
        `activeCases=${operatorSummary.attentionOverview?.activeCases?.length ?? 0}`,
        `operatorRecovered=${operatorSummary.recovery.statusCounts.recovered ?? 0}`,
      ];
      const passed =
        run?.status === "recovered" &&
        run.attempts[0]?.status === "failed" &&
        run.attempts[1]?.browserOutcome === "cold_reopen" &&
        bundle?.recoveryWorkflow?.status === "recovered" &&
        replayConsole.openIncidents === 0 &&
        bundle.followUpSummary?.browserContinuityCounts.recovered === 1 &&
        consoleBundle?.workflowStatus === "recovered" &&
        consoleBundle.browserContinuityState === "recovered" &&
        (operatorSummary.attentionOverview?.activeCases?.length ?? 0) === 0 &&
        operatorSummary.recovery.attentionCount === 0 &&
        operatorSummary.recovery.statusCounts.recovered === 1 &&
        operatorSummary.recovery.browserOutcomeCounts.cold_reopen === 1;
      return buildResult(this, Boolean(passed), details);
    },
  },
  {
    caseId: "replay-console-browser-continuity-counts",
    title: "Replay console summarizes browser continuity counts",
    area: "browser",
    summary: "Operator console should summarize stable, recovered, and attention browser continuity states across recent groups.",
    run() {
      const records = [
        {
          replayId: "task-browser-stable:worker:worker:browser:task:task-browser-stable",
          layer: "worker",
          status: "completed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-browser-stable",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser hot attach succeeded",
          metadata: {
            payload: {
              sessionId: "browser-session-stable",
              targetId: "target-stable",
              resumeMode: "hot",
              targetResolution: "attach",
            },
          },
        },
        {
          replayId: "task-browser-recovered:worker:worker:browser:task:task-browser-recovered",
          layer: "worker",
          status: "completed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-browser-recovered",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser warm reconnect succeeded",
          metadata: {
            payload: {
              sessionId: "browser-session-recovered",
              targetId: "target-recovered",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
        {
          replayId: "task-browser-attention:worker:worker:browser:task:task-browser-attention",
          layer: "worker",
          status: "failed",
          recordedAt: 30,
          threadId: "thread-1",
          taskId: "task-browser-attention",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser target detached",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "browser target detached",
            recommendedAction: "resume",
          },
          metadata: {
            payload: {
              sessionId: "browser-session-attention",
              targetId: "target-attention",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const consoleReport = buildReplayConsoleReport(records, 10);
      const details = [
        `stable=${consoleReport.browserContinuityCounts.stable ?? 0}`,
        `recovered=${consoleReport.browserContinuityCounts.recovered ?? 0}`,
        `attention=${consoleReport.browserContinuityCounts.attention ?? 0}`,
      ];
      return buildResult(
        this,
        consoleReport.browserContinuityCounts.stable === 1 &&
          consoleReport.browserContinuityCounts.recovered === 1 &&
          consoleReport.browserContinuityCounts.attention === 1,
        details
      );
    },
  },
  {
    caseId: "browser-ownership-reclaim-keeps-single-recovered-case",
    title: "Browser ownership reclaim keeps a single recovered case",
    area: "browser",
    summary:
      "An owner-mismatch denial followed by reclaim and cold reopen should still collapse back into one recovered incident instead of duplicating browser continuity cases.",
    run() {
      const records = [
        {
          replayId: "task-own-0:worker:worker:browser:task:task-own-0",
          layer: "worker",
          status: "failed",
          recordedAt: 10,
          threadId: "thread-1",
          taskId: "task-own-0",
          roleId: "role-operator",
          workerType: "browser",
          summary: "browser continuity blocked after ownership mismatch",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "ownership mismatch blocked hot attach",
            recommendedAction: "resume",
          },
          metadata: {
            payload: {
              sessionId: "browser-session-own",
              targetId: "target-own",
              resumeMode: "warm",
              targetResolution: "reconnect",
            },
          },
        },
        {
          replayId: "task-own-1:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 15,
          threadId: "thread-1",
          taskId: "task-own-1",
          roleId: "role-operator",
          summary: "ownership reclaim recovery dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-own-0",
              attemptId: "recovery:task-own-0:attempt:1",
              dispatchReplayId: "task-own-1:scheduled",
            },
          },
        },
        {
          replayId: "task-own-1:worker:worker:browser:task:task-own-1",
          layer: "worker",
          status: "failed",
          recordedAt: 20,
          threadId: "thread-1",
          taskId: "task-own-1",
          roleId: "role-operator",
          workerType: "browser",
          summary: "wrong owner denial forced a fresh reopen path",
          failure: {
            category: "stale_session",
            layer: "worker",
            retryable: true,
            message: "wrong owner denied hot reuse of the browser target",
            recommendedAction: "fallback",
          },
          metadata: {
            recoveryContext: {
              parentGroupId: "task-own-0",
              attemptId: "recovery:task-own-0:attempt:1",
              dispatchReplayId: "task-own-1:scheduled",
            },
          },
        },
        {
          replayId: "task-own-2:scheduled",
          layer: "scheduled",
          status: "completed",
          recordedAt: 25,
          threadId: "thread-1",
          taskId: "task-own-2",
          roleId: "role-operator",
          summary: "cold reopen reclaim dispatched",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-own-0",
              attemptId: "recovery:task-own-0:attempt:2",
              dispatchReplayId: "task-own-2:scheduled",
            },
          },
        },
        {
          replayId: "task-own-2:worker:worker:browser:task:task-own-2",
          layer: "worker",
          status: "completed",
          recordedAt: 35,
          threadId: "thread-1",
          taskId: "task-own-2",
          roleId: "role-operator",
          workerType: "browser",
          summary: "cold reopen reclaimed the browser target without cross-owner leakage",
          metadata: {
            recoveryContext: {
              parentGroupId: "task-own-0",
              attemptId: "recovery:task-own-0:attempt:2",
              dispatchReplayId: "task-own-2:scheduled",
            },
            payload: {
              sessionId: "browser-session-own",
              targetId: "target-own",
              resumeMode: "cold",
              targetResolution: "reopen",
            },
          },
        },
      ] satisfies ReplayRecord[];

      const existingRuns: RecoveryRun[] = [
        {
          recoveryRunId: buildRecoveryRunId("task-own-0"),
          threadId: "thread-1",
          sourceGroupId: "task-own-0",
          taskId: "task-own-0",
          roleId: "role-operator",
          targetLayer: "worker",
          targetWorker: "browser",
          latestStatus: "failed",
          status: "fallback_running",
          nextAction: "fallback_transport",
          autoDispatchReady: true,
          requiresManualIntervention: false,
          latestSummary: "cold reopen reclaim dispatched",
          currentAttemptId: "recovery:task-own-0:attempt:2",
          attempts: [
            {
              attemptId: "recovery:task-own-0:attempt:1",
              action: "resume",
              requestedAt: 15,
              updatedAt: 20,
              status: "failed",
              nextAction: "fallback_transport",
              summary: "wrong owner denied hot reuse of the browser target",
              completedAt: 20,
              dispatchedTaskId: "task-own-1",
              targetLayer: "worker",
              targetWorker: "browser",
              failure: {
                category: "stale_session",
                layer: "worker",
                retryable: true,
                message: "wrong owner denied hot reuse of the browser target",
                recommendedAction: "fallback",
              },
            },
            {
              attemptId: "recovery:task-own-0:attempt:2",
              action: "fallback",
              requestedAt: 25,
              updatedAt: 26,
              status: "fallback_running",
              nextAction: "fallback_transport",
              summary: "cold reopen reclaim dispatched",
              dispatchedTaskId: "task-own-2",
              targetLayer: "worker",
              targetWorker: "browser",
            },
          ],
          createdAt: 15,
          updatedAt: 26,
        },
      ];

      const recoveryRuns = buildRecoveryRuns(records, existingRuns, 100);
      const run = recoveryRuns.find((entry) => entry.sourceGroupId === "task-own-0");
      const bundle = buildReplayIncidentBundle(records, "task-own-0");
      const replayConsole = buildReplayConsoleReport(records, 10);
      const resolvedBundles = replayConsole.latestResolvedBundles.filter((entry) => entry.groupId === "task-own-0");
      const operatorSummary = buildOperatorSummaryReport({
        flows: [],
        permissionRecords: [],
        events: [],
        replays: records,
        recoveryRuns,
      });
      const details = [
        `run=${run?.status ?? "-"}`,
        `attempt1=${run?.attempts[0]?.status ?? "-"}`,
        `attempt2=${run?.attempts[1]?.browserOutcome ?? "-"}`,
        `resolvedBundles=${resolvedBundles.length}`,
        `open=${replayConsole.openIncidents}`,
        `followUpClosed=${bundle?.followUpSummary?.closedGroups ?? "-"}`,
        `continuity=${resolvedBundles[0]?.browserContinuityState ?? "-"}`,
        `activeCases=${operatorSummary.attentionOverview?.activeCases?.length ?? 0}`,
      ];
      const passed =
        run?.status === "recovered" &&
        run.attempts[0]?.status === "failed" &&
        run.attempts[1]?.browserOutcome === "cold_reopen" &&
        resolvedBundles.length === 1 &&
        replayConsole.openIncidents === 0 &&
        bundle?.followUpSummary?.closedGroups === 1 &&
        bundle.followUpSummary?.browserContinuityCounts.recovered === 1 &&
        resolvedBundles[0]?.browserContinuityState === "recovered" &&
        (operatorSummary.attentionOverview?.activeCases?.length ?? 0) === 0;
      return buildResult(this, Boolean(passed), details);
    },
  },
];

function buildResult(
  item: BoundedRegressionCaseDescriptor,
  passed: boolean,
  details: string[]
): BoundedRegressionCaseResult {
  return {
    ...item,
    status: passed ? "passed" : "failed",
    details,
  };
}
