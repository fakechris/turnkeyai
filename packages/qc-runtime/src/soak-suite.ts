import type {
  BoundedRegressionCaseResult,
} from "./bounded-regression-harness";

import { runBoundedRegressionSuite } from "./bounded-regression-harness";

export interface SoakScenarioDescriptor {
  scenarioId: string;
  area:
    | "dispatch"
    | "parallel"
    | "browser"
    | "recovery"
    | "context"
    | "governance"
    | "operator"
    | "observability"
    | "runtime";
  title: string;
  summary: string;
  caseIds: string[];
}

export interface SoakScenarioResult extends SoakScenarioDescriptor {
  status: "passed" | "failed";
  totalCases: number;
  passedCases: number;
  failedCases: number;
  caseResults: BoundedRegressionCaseResult[];
}

export interface SoakSuiteResult {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: SoakScenarioResult[];
}

const SCENARIOS: SoakScenarioDescriptor[] = [
  {
    scenarioId: "browser-recovery-long-chain",
    area: "browser",
    title: "Detached -> resume -> fallback -> cold reopen",
    summary:
      "验证 browser recovery 在长链 resume/fallback/cold reopen 后，replay / runtime / operator 三面都收敛到 recovered。",
    caseIds: [
      "browser-recovery-cold-reopen-outcome",
      "browser-recovery-multi-attempt-chain-stays-aligned",
      "browser-recovery-recovered-but-waiting-manual-stays-visible",
      "replay-console-browser-continuity-counts",
      "runtime-summary-keeps-browser-recovered-chain-active",
    ],
  },
  {
    scenarioId: "browser-reentry-and-session-continuity",
    area: "dispatch",
    title: "Follow-up / scheduled re-entry continuity",
    summary:
      "验证 browser continuity 在 follow-up、scheduled re-entry、detached target attention 下保持同一执行链语义。",
    caseIds: [
      "session-follow-up-reuses-existing-chain",
      "session-scheduled-reentry-preserves-existing-continuity",
      "recovery-browser-detached-target",
      "browser-continuity-attention-summary",
    ],
  },
  {
    scenarioId: "recovery-causality-and-operator-closure",
    area: "recovery",
    title: "Recovery causality / supersession / closure",
    summary:
      "验证 recovery attempt 的因果链、superseded relation、workflow closure 与 operator attention 清理保持一致。",
    caseIds: [
      "recovery-causality-chain",
      "recovery-retry-escalation",
      "recovery-fallback-downgrade",
      "recovery-reject-aborts-chain",
      "replay-console-surfaces-workflow-state",
      "operator-summary-clears-recovery-attention-after-recovery",
    ],
  },
  {
    scenarioId: "context-pressure-and-runtime-reentry",
    area: "context",
    title: "Context pressure / re-entry / runtime visibility",
    summary:
      "验证高压上下文、re-entry continuity、prompt compaction 诊断与 runtime waiting-point 可见性在长任务里同时成立。",
    caseIds: [
      "context-evidence-heavy-keeps-pending-work",
      "context-reentry-preserves-active-tasks-and-open-questions",
      "context-continuity-keeps-decisions-and-constraints-under-budget",
      "context-continuity-keeps-journal-notes-under-budget",
      "runtime-prompt-console-summarizes-boundaries",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "context-high-pressure-real-task-keeps-operator-runbook",
      "runtime-summary-surfaces-stale-waiting-point-and-child-span",
      "runtime-chain-query-answers-root-active-and-waiting-point",
    ],
  },
  {
    scenarioId: "operator-compound-incident-runbook",
    area: "operator",
    title: "Compound incident runbook",
    summary:
      "验证 browser recovery、manual follow-up、runtime waiting 和 prompt pressure 会在 operator triage / replay / runtime 三面形成稳定排障路径。",
    caseIds: [
      "browser-recovery-recovered-but-waiting-manual-stays-visible",
      "runtime-summary-aligns-browser-recovered-manual-follow-up",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "operator-triage-prioritizes-compound-incident",
      "replay-console-surfaces-workflow-state",
    ],
  },
  {
    scenarioId: "governance-approval-fallback-closure",
    area: "governance",
    title: "Governance approval -> fallback -> closure",
    summary:
      "验证 approval-required side effect 在 browser fallback、approved recovery 与 bundle closure 后的 operator 收口保持一致。",
    caseIds: [
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
      "parallel-governed-merge-waits-for-approval",
      "replay-bundle-exposes-recovery-operator-gate",
      "recovery-approval-fallback-chain",
      "recovery-bundle-closes-after-approved-fallback",
      "parallel-governed-merge-closes-after-readback",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "parallel-retry-and-merge-closure",
    area: "parallel",
    title: "Parallel retry -> merge closure",
    summary:
      "验证多 shard 任务在 timeout、follow-up、retry 和最终 merge closure 下的 operator-facing 合流语义持续一致。",
    caseIds: [
      "parallel-flow-summary-highlights-shard-issues",
      "parallel-follow-up-summary-stays-open",
      "parallel-flow-summary-clears-attention-after-retry",
      "parallel-follow-up-summary-closes-after-recovery",
      "parallel-governed-merge-waits-for-approval",
      "parallel-governed-merge-closes-after-readback",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "browser-transport-reconnect-diagnostics",
    area: "browser",
    title: "Browser transport reconnect diagnostics",
    summary:
      "验证 relay/direct-cdp reconnect、workflow-log 诊断与 browser continuity 在长链稳定性里持续一致，并且 local 主链不被 transport 扩展回归。",
    caseIds: [
      "relay-recovery-workflow-log-surfaces-peer-diagnostics",
      "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics",
      "browser-recovery-cold-reopen-outcome",
      "replay-console-browser-continuity-counts",
    ],
  },
  {
    scenarioId: "transport-soak-validation-ops-readiness",
    area: "browser",
    title: "Transport soak validation ops readiness",
    summary:
      "验证 transport soak 的 relay/direct-cdp target failure、acceptance failure 与 validation-ops 排障入口在长链里持续可读。",
    caseIds: [
      "transport-soak-validation-ops-surfaces-target-buckets",
      "browser-transport-real-world-e2e-keeps-replay-operator-aligned",
      "relay-recovery-workflow-log-surfaces-peer-diagnostics",
      "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics",
    ],
  },
  {
    scenarioId: "phase1-production-closure-long-chain",
    area: "operator",
    title: "Phase 1 production closure long chain",
    summary:
      "验证 Phase 1 收尾场景在 browser transport、operator active/resolved、context 压力和治理闭环下保持稳定。",
    caseIds: [
      "browser-transport-real-world-e2e-keeps-replay-operator-aligned",
      "transport-soak-validation-ops-surfaces-target-buckets",
      "operator-case-semantics-separate-active-manual-from-resolved-recent",
      "context-real-task-attachment-pressure-keeps-critical-carry-forward",
      "context-weak-observational-evidence-does-not-outrank-continuation",
      "parallel-governance-downgrade-fallback-explains-operator-contract",
      "parallel-governance-contract-dedupes-retried-audits-by-case",
    ],
  },
];

export function listSoakScenarios(): SoakScenarioDescriptor[] {
  return SCENARIOS.map((scenario) => ({ ...scenario, caseIds: [...scenario.caseIds] }));
}

export function runSoakSuite(scenarioIds?: string[]): SoakSuiteResult {
  const selected = scenarioIds?.length
    ? SCENARIOS.filter((scenario) => scenarioIds.includes(scenario.scenarioId))
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
  scenario: SoakScenarioDescriptor
): SoakScenarioResult {
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
