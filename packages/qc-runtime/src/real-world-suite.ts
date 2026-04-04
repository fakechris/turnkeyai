import type {
  BoundedRegressionCaseResult,
} from "./bounded-regression-harness";

import { runBoundedRegressionSuite } from "./bounded-regression-harness";

export interface RealWorldScenarioDescriptor {
  scenarioId: string;
  area:
    | "browser"
    | "recovery"
    | "context"
    | "parallel"
    | "governance"
    | "runtime"
    | "operator";
  title: string;
  summary: string;
  caseIds: string[];
}

export interface RealWorldScenarioResult extends RealWorldScenarioDescriptor {
  status: "passed" | "failed";
  totalCases: number;
  passedCases: number;
  failedCases: number;
  caseResults: BoundedRegressionCaseResult[];
}

export interface RealWorldSuiteResult {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: RealWorldScenarioResult[];
}

const SCENARIOS: RealWorldScenarioDescriptor[] = [
  {
    scenarioId: "browser-research-recovery-runbook",
    area: "browser",
    title: "Browser research recovery runbook",
    summary:
      "模拟真实浏览器研究任务在 detached -> fallback -> manual verification 下的恢复、runtime waiting 与 operator triage 收敛。",
    caseIds: [
      "browser-recovery-multi-attempt-chain-stays-aligned",
      "browser-recovery-recovered-but-waiting-manual-stays-visible",
      "runtime-summary-aligns-browser-recovered-manual-follow-up",
      "operator-triage-prioritizes-compound-incident",
      "replay-console-browser-continuity-counts",
    ],
  },
  {
    scenarioId: "browser-research-transport-reconnect-runbook",
    area: "browser",
    title: "Browser research transport reconnect runbook",
    summary:
      "模拟真实浏览器研究任务在 relay/direct-cdp reconnect、workflow-log 诊断和 operator triage 之间的连续排障路径。",
    caseIds: [
      "relay-recovery-workflow-log-surfaces-peer-diagnostics",
      "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics",
      "browser-recovery-multi-attempt-chain-stays-aligned",
      "replay-console-browser-continuity-counts",
      "operator-triage-prioritizes-compound-incident",
    ],
  },
  {
    scenarioId: "parallel-governed-synthesis-runbook",
    area: "parallel",
    title: "Parallel governed synthesis runbook",
    summary:
      "模拟真实多 shard 综合任务，在 retry、merge gate、治理 fallback 与 approval gate 下保持 operator-facing 可解释性。",
    caseIds: [
      "parallel-three-shard-success-ready-to-merge",
      "parallel-flow-summary-highlights-shard-issues",
      "parallel-flow-summary-clears-attention-after-retry",
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "continuation-pressure-runbook",
    area: "context",
    title: "Continuation pressure runbook",
    summary:
      "模拟长任务在 follow-up、scheduled re-entry 与高压上下文压缩下，continuation carry-forward、prompt boundary 与 runtime query 仍保持一致。",
    caseIds: [
      "session-follow-up-reuses-existing-chain",
      "session-scheduled-reentry-preserves-existing-continuity",
      "context-evidence-heavy-keeps-pending-work",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "runtime-prompt-console-summarizes-boundaries",
      "runtime-chain-query-answers-root-active-and-waiting-point",
    ],
  },
  {
    scenarioId: "operator-escalation-runbook",
    area: "operator",
    title: "Operator escalation runbook",
    summary:
      "模拟 operator 从 replay bundle、recovery gate、approval/fallback 到 triage 首页的完整排障路径。",
    caseIds: [
      "replay-bundle-exposes-recovery-operator-gate",
      "replay-console-surfaces-workflow-state",
      "recovery-retry-escalation",
      "recovery-approval-fallback-chain",
      "recovery-reject-aborts-chain",
      "operator-triage-prioritizes-compound-incident",
    ],
  },
  {
    scenarioId: "operator-escalation-compound-incident-runbook",
    area: "operator",
    title: "Operator escalation compound incident runbook",
    summary:
      "模拟值班 operator 同时处理 browser manual follow-up、runtime waiting、prompt pressure 与 recovery lifecycle 的复合排障路径。",
    caseIds: [
      "browser-recovery-recovered-but-waiting-manual-stays-visible",
      "runtime-summary-aligns-browser-recovered-manual-follow-up",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "operator-triage-prioritizes-compound-incident",
      "operator-surfaces-track-recovery-lifecycle",
    ],
  },
  {
    scenarioId: "governed-publish-approval-runbook",
    area: "governance",
    title: "Governed publish approval runbook",
    summary:
      "模拟真实发布任务在 official API、browser fallback、approval gate 与最终恢复闭环之间的 operator 决策路径。",
    caseIds: [
      "governance-official-api-success-high-trust",
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
      "replay-bundle-exposes-recovery-operator-gate",
      "recovery-approval-fallback-chain",
      "recovery-bundle-closes-after-approved-fallback",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "governed-publish-approval-reject-runbook",
    area: "governance",
    title: "Governed publish approval reject runbook",
    summary:
      "模拟真实发布任务在 approval gate 被拒绝后，replay bundle、recovery gate 与 operator summary 一致收口到 aborted/blocked。",
    caseIds: [
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
      "replay-bundle-exposes-recovery-operator-gate",
      "recovery-reject-aborts-chain",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "governed-publish-readback-verification",
    area: "governance",
    title: "Governed publish readback verification",
    summary:
      "模拟真实发布任务在 approval gate、browser fallback 和 publish readback verification 后，operator attention 与 governance closure 一致收口。",
    caseIds: [
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
      "governance-publish-readback-verifies-closure",
      "replay-bundle-exposes-recovery-operator-gate",
      "recovery-approval-fallback-chain",
      "recovery-bundle-closes-after-approved-fallback",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "parallel-follow-up-merge-runbook",
    area: "parallel",
    title: "Parallel follow-up merge runbook",
    summary:
      "模拟真实多 shard 任务在 conflict、follow-up、retry 和最终 merge-ready 闭环下的收敛路径。",
    caseIds: [
      "parallel-three-shard-success-ready-to-merge",
      "parallel-flow-summary-highlights-shard-issues",
      "parallel-follow-up-summary-stays-open",
      "parallel-flow-summary-clears-attention-after-retry",
      "parallel-follow-up-summary-closes-after-recovery",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "runtime-observability-reentry-runbook",
    area: "runtime",
    title: "Runtime observability re-entry runbook",
    summary:
      "模拟真实长任务在 child progress、reconnect window、stale waiting、prompt boundary 与单链查询之间的联动诊断。",
    caseIds: [
      "runtime-child-session-progress-visible",
      "runtime-summary-keeps-browser-recovered-chain-active",
      "runtime-summary-preserves-reconnect-window-before-stale",
      "runtime-summary-prioritizes-attention-chains",
      "runtime-summary-surfaces-stale-waiting-point-and-child-span",
      "runtime-prompt-console-summarizes-boundaries",
      "runtime-chain-query-answers-root-active-and-waiting-point",
    ],
  },
  {
    scenarioId: "long-continuation-under-pressure-runbook",
    area: "context",
    title: "Long continuation under pressure runbook",
    summary:
      "模拟长任务在 follow-up、re-entry、重压 compaction 与 runtime waiting-point 并存时，carry-forward 和记忆打包仍保持稳定。",
    caseIds: [
      "session-follow-up-reuses-existing-chain",
      "session-scheduled-reentry-preserves-existing-continuity",
      "context-evidence-heavy-keeps-pending-work",
      "context-reentry-preserves-active-tasks-and-open-questions",
      "context-continuity-keeps-decisions-and-constraints-under-budget",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
    ],
  },
];

export function listRealWorldScenarios(): RealWorldScenarioDescriptor[] {
  return SCENARIOS.map((scenario) => ({ ...scenario, caseIds: [...scenario.caseIds] }));
}

export function runRealWorldSuite(scenarioIds?: string[]): RealWorldSuiteResult {
  const scenarioById = new Map(SCENARIOS.map((scenario) => [scenario.scenarioId, scenario] as const));
  if (scenarioIds?.length) {
    const validScenarioIds = new Set(scenarioById.keys());
    const unknownScenarioIds = scenarioIds.filter((scenarioId) => !validScenarioIds.has(scenarioId));
    if (unknownScenarioIds.length > 0) {
      throw new Error(`unknown real-world scenario ids: ${unknownScenarioIds.join(", ")}`);
    }
  }
  const selected = scenarioIds?.length
    ? scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)).filter((scenario): scenario is RealWorldScenarioDescriptor => scenario != null)
    : SCENARIOS;
  const scenarios = selected.map(runScenario);
  return {
    totalScenarios: scenarios.length,
    passedScenarios: scenarios.filter((scenario) => scenario.status === "passed").length,
    failedScenarios: scenarios.filter((scenario) => scenario.status === "failed").length,
    totalCases: scenarios.reduce((sum, scenario) => sum + scenario.totalCases, 0),
    passedCases: scenarios.reduce((sum, scenario) => sum + scenario.passedCases, 0),
    failedCases: scenarios.reduce((sum, scenario) => sum + scenario.failedCases, 0),
    scenarios,
  };
}

function runScenario(
  scenario: RealWorldScenarioDescriptor
): RealWorldScenarioResult {
  const suite = runBoundedRegressionSuite(scenario.caseIds);
  return {
    ...scenario,
    status: suite.failedCases === 0 ? "passed" : "failed",
    totalCases: suite.totalCases,
    passedCases: suite.passedCases,
    failedCases: suite.failedCases,
    caseResults: suite.results,
  };
}
