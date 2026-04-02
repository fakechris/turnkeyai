import type {
  BoundedRegressionCaseResult,
} from "./bounded-regression-harness";

import { runBoundedRegressionSuite } from "./bounded-regression-harness";

export interface FailureInjectionScenarioDescriptor {
  scenarioId: string;
  area: "browser" | "recovery" | "context" | "parallel" | "governance" | "runtime" | "operator";
  title: string;
  summary: string;
  caseIds: string[];
}

export interface FailureInjectionScenarioResult extends FailureInjectionScenarioDescriptor {
  status: "passed" | "failed";
  totalCases: number;
  passedCases: number;
  failedCases: number;
  caseResults: BoundedRegressionCaseResult[];
}

export interface FailureInjectionSuiteResult {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: FailureInjectionScenarioResult[];
}

const SCENARIOS: FailureInjectionScenarioDescriptor[] = [
  {
    scenarioId: "browser-detach-reopen-recovery",
    area: "browser",
    title: "Detached target -> reopen -> continuity recovery",
    summary: "验证 browser session 在 detach / reopen / continuity attention 下的恢复与可观测语义。",
    caseIds: [
      "browser-recovery-cold-reopen-outcome",
      "browser-continuity-attention-summary",
      "replay-console-browser-continuity-counts",
    ],
  },
  {
    scenarioId: "recovery-retry-fallback-approval",
    area: "recovery",
    title: "Retry -> fallback -> approval -> resume",
    summary: "验证恢复链在重复失败、fallback、approval gate 和 resume 下的状态迁移。",
    caseIds: [
      "recovery-retry-escalation",
      "recovery-fallback-downgrade",
      "recovery-approval-resume-chain",
      "recovery-approval-fallback-chain",
      "recovery-reject-aborts-chain",
    ],
  },
  {
    scenarioId: "parallel-shard-failure-and-recovery",
    area: "parallel",
    title: "Shard failure -> retry -> follow-up close",
    summary: "验证 shard timeout/conflict 后 attention、retry 和 follow-up 关闭路径。",
    caseIds: [
      "parallel-flow-summary-highlights-shard-issues",
      "parallel-flow-summary-clears-attention-after-retry",
      "parallel-follow-up-summary-stays-open",
      "parallel-follow-up-summary-closes-after-recovery",
    ],
  },
  {
    scenarioId: "governance-denial-fallback-and-approval",
    area: "governance",
    title: "Official API denial -> browser fallback -> approval gate",
    summary: "验证 permission governance 在失败注入下能解释 fallback 与 approval-required 路径。",
    caseIds: [
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
    ],
  },
  {
    scenarioId: "runtime-stale-waiting-and-manual-attention",
    area: "runtime",
    title: "Waiting chain -> stale -> manual attention",
    summary: "验证 runtime/operator 在 stale waiting point 与 manual recovery attention 下保持一致。",
    caseIds: [
      "runtime-summary-aligns-manual-recovery-and-operator-attention",
      "runtime-summary-surfaces-stale-waiting-point-and-child-span",
      "runtime-summary-prioritizes-attention-chains",
    ],
  },
  {
    scenarioId: "context-budget-pressure-and-reentry",
    area: "context",
    title: "Budget pressure -> re-entry continuity",
    summary: "验证高压上下文与 re-entry 下 pending work、decision、constraints 不丢失。",
    caseIds: [
      "context-evidence-heavy-keeps-pending-work",
      "context-reentry-preserves-active-tasks-and-open-questions",
      "context-continuity-keeps-decisions-and-constraints-under-budget",
      "context-continuity-keeps-journal-notes-under-budget",
    ],
  },
  {
    scenarioId: "operator-triage-compound-incident",
    area: "operator",
    title: "Recovered browser incident + prompt pressure + runtime waiting",
    summary:
      "验证复合 incident 下 operator triage 会优先暴露 browser/recovery case，同时保留 runtime waiting 与 prompt pressure 的排障入口。",
    caseIds: [
      "browser-recovery-recovered-but-waiting-manual-stays-visible",
      "runtime-summary-aligns-browser-recovered-manual-follow-up",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "operator-triage-prioritizes-compound-incident",
    ],
  },
];

export function listFailureInjectionScenarios(): FailureInjectionScenarioDescriptor[] {
  return SCENARIOS.map((scenario) => ({ ...scenario, caseIds: [...scenario.caseIds] }));
}

export function runFailureInjectionSuite(
  scenarioIds?: string[]
): FailureInjectionSuiteResult {
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
  scenario: FailureInjectionScenarioDescriptor
): FailureInjectionScenarioResult {
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
