import type {
  BoundedRegressionCaseResult,
} from "./bounded-regression-harness";

import { runBoundedRegressionSuite } from "./bounded-regression-harness";

export interface ScenarioParityAcceptanceScenarioDescriptor {
  scenarioId: string;
  area: "dispatch" | "parallel" | "browser" | "recovery" | "context" | "governance" | "operator" | "observability";
  title: string;
  summary: string;
  caseIds: string[];
}

export interface ScenarioParityAcceptanceScenarioResult extends ScenarioParityAcceptanceScenarioDescriptor {
  status: "passed" | "failed";
  totalCases: number;
  passedCases: number;
  failedCases: number;
  caseResults: BoundedRegressionCaseResult[];
}

export interface ScenarioParityAcceptanceSuiteResult {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  scenarios: ScenarioParityAcceptanceScenarioResult[];
}

const SCENARIOS: ScenarioParityAcceptanceScenarioDescriptor[] = [
  {
    scenarioId: "dispatch-follow-up-existing-session",
    area: "dispatch",
    title: "Spawn 后继续 send 到已有 session",
    summary: "验证 follow-up 会沿用已有 continuity，而不是退化成新的执行链。",
    caseIds: ["session-follow-up-reuses-existing-chain", "runtime-child-session-progress-visible"],
  },
  {
    scenarioId: "dispatch-scheduled-reentry-existing-session",
    area: "dispatch",
    title: "Scheduled re-entry 命中已有 session",
    summary: "验证 scheduled re-entry 会回到原 continuity，而不是生成一条孤立链。",
    caseIds: ["session-scheduled-reentry-preserves-existing-continuity"],
  },
  {
    scenarioId: "parallel-three-shard-success",
    area: "parallel",
    title: "三路 shard 全成功后 merge-ready",
    summary: "验证三路独立 shard 完成后，合流 readiness 清晰且无多余 attention。",
    caseIds: ["parallel-three-shard-success-ready-to-merge"],
  },
  {
    scenarioId: "parallel-timeout-retry-merge",
    area: "parallel",
    title: "一条 shard timeout 后 retry 再 merge",
    summary: "验证 timeout / retry / merge 的组合链。",
    caseIds: ["parallel-flow-summary-clears-attention-after-retry"],
  },
  {
    scenarioId: "parallel-conflict-blocks-merge",
    area: "parallel",
    title: "duplicate/conflict 阻断 merge",
    summary: "验证 merge gate 不会让低质量 shard 结果直接合流。",
    caseIds: ["parallel-flow-summary-highlights-shard-issues"],
  },
  {
    scenarioId: "browser-spawn-send-resume",
    area: "browser",
    title: "browser spawn -> send -> resume",
    summary: "验证 browser continuity 在恢复后仍然挂在同一条执行链上。",
    caseIds: [
      "browser-recovery-cold-reopen-outcome",
      "browser-recovery-multi-attempt-chain-stays-aligned",
      "replay-console-browser-continuity-counts",
    ],
  },
  {
    scenarioId: "browser-ownership-reclaim-isolation",
    area: "browser",
    title: "browser ownership reclaim isolation",
    summary:
      "验证 wrong-owner deny、ownership reclaim 与 cold reopen 后，只保留一条 recovered continuity，且旧 owner 不会污染新的 browser continuity 视图。",
    caseIds: [
      "browser-ownership-reclaim-keeps-single-recovered-case",
      "browser-recovery-multi-attempt-chain-stays-aligned",
      "browser-recovery-cold-reopen-outcome",
      "replay-console-browser-continuity-counts",
    ],
  },
  {
    scenarioId: "recovery-fallback-and-approval",
    area: "recovery",
    title: "retry / fallback / approval / resume",
    summary: "验证 recovery 多轮动作的因果链和 operator 状态迁移。",
    caseIds: [
      "recovery-retry-escalation",
      "recovery-approval-resume-chain",
      "recovery-approval-fallback-chain",
      "recovery-browser-detached-target",
    ],
  },
  {
    scenarioId: "context-evidence-heavy-and-reentry",
    area: "context",
    title: "context pressure / re-entry / runtime visibility",
    summary:
      "验证高压预算和 re-entry 下，pending work / open questions / decisions 仍稳定，且 prompt/runtime 诊断对等待点与 carry-forward 的判断一致。",
    caseIds: [
      "context-evidence-heavy-keeps-pending-work",
      "context-reentry-preserves-active-tasks-and-open-questions",
      "context-continuity-keeps-decisions-and-constraints-under-budget",
      "context-continuity-keeps-journal-notes-under-budget",
      "runtime-prompt-console-summarizes-boundaries",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "runtime-chain-query-answers-root-active-and-waiting-point",
    ],
  },
  {
    scenarioId: "governance-success-fallback-approval",
    area: "governance",
    title: "official API / fallback / approval gate",
    summary: "验证治理链能解释 success、fallback 和 approval-required 三类路径。",
    caseIds: [
      "governance-official-api-success-high-trust",
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
    ],
  },
  {
    scenarioId: "operator-cross-surface-consistency",
    area: "operator",
    title: "单 case 跨三面一致",
    summary: "验证 operator summary / attention / replay bundle 的 case 语义一致。",
    caseIds: [
      "operator-summary-aligns-attention-across-surfaces",
      "operator-attention-aligns-with-summary",
      "operator-surfaces-track-recovery-lifecycle",
      "operator-case-cards-preserve-order-and-metadata",
    ],
  },
  {
    scenarioId: "operator-triage-compound-incident",
    area: "operator",
    title: "compound incident triage",
    summary:
      "验证 operator triage 会把 browser manual follow-up incident、runtime waiting 和 prompt pressure 聚成一条可执行排障路径。",
    caseIds: [
      "browser-recovery-recovered-but-waiting-manual-stays-visible",
      "runtime-summary-aligns-browser-recovered-manual-follow-up",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "operator-triage-prioritizes-compound-incident",
    ],
  },
  {
    scenarioId: "real-world-browser-research-runbook",
    area: "browser",
    title: "real-world browser research runbook",
    summary:
      "验证真实浏览器研究任务在 recovery、prompt pressure、runtime waiting 和 triage 首页之间形成同场景的 operator runbook。",
    caseIds: [
      "browser-recovery-multi-attempt-chain-stays-aligned",
      "browser-recovery-recovered-but-waiting-manual-stays-visible",
      "context-runtime-pressure-keeps-carry-forward-and-waiting-visible",
      "operator-triage-prioritizes-compound-incident",
      "runtime-chain-query-answers-root-active-and-waiting-point",
    ],
  },
  {
    scenarioId: "real-world-governed-publish-runbook",
    area: "governance",
    title: "real-world governed publish runbook",
    summary:
      "验证真实发布任务从 official API 决策、approval gate、browser fallback 到 recovery closure 的同场景 operator 语义。",
    caseIds: [
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
      "replay-bundle-exposes-recovery-operator-gate",
      "recovery-approval-fallback-chain",
      "recovery-bundle-closes-after-approved-fallback",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "real-world-governed-publish-approval-reject-runbook",
    area: "governance",
    title: "real-world governed publish approval reject runbook",
    summary:
      "验证真实发布任务在 approval gate 被 operator 拒绝后，会跨 replay/recovery/operator 一致进入 blocked closure，而不是残留可执行动作。",
    caseIds: [
      "governance-summary-highlights-browser-fallback",
      "governance-approval-required-side-effect-blocks",
      "replay-bundle-exposes-recovery-operator-gate",
      "recovery-reject-aborts-chain",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "real-world-parallel-follow-up-runbook",
    area: "parallel",
    title: "real-world parallel follow-up runbook",
    summary:
      "验证真实多 shard 任务在冲突、follow-up、retry 和最终 closure 下的 operator-facing merge 语义。",
    caseIds: [
      "parallel-flow-summary-highlights-shard-issues",
      "parallel-follow-up-summary-stays-open",
      "parallel-flow-summary-clears-attention-after-retry",
      "parallel-follow-up-summary-closes-after-recovery",
      "operator-summary-aligns-attention-across-surfaces",
    ],
  },
  {
    scenarioId: "browser-transport-reconnect-workflow",
    area: "browser",
    title: "browser transport reconnect workflow",
    summary:
      "验证 relay/direct-cdp transport 在 reconnect 后，workflow-log、replay console 与 operator next-step 保持同一条恢复语义。",
    caseIds: [
      "relay-recovery-workflow-log-surfaces-peer-diagnostics",
      "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics",
      "browser-recovery-multi-attempt-chain-stays-aligned",
    ],
  },
  {
    scenarioId: "observability-live-chain-visibility",
    area: "observability",
    title: "整链活态可见与单查定位",
    summary: "验证 child progress、waiting point、stale 判断和单条查询定位能力。",
    caseIds: [
      "runtime-child-session-progress-visible",
      "runtime-summary-keeps-browser-recovered-chain-active",
      "runtime-summary-preserves-reconnect-window-before-stale",
      "runtime-summary-aligns-manual-recovery-and-operator-attention",
      "runtime-summary-surfaces-stale-waiting-point-and-child-span",
      "runtime-chain-query-answers-root-active-and-waiting-point",
    ],
  },
];

export function listScenarioParityAcceptanceScenarios(): ScenarioParityAcceptanceScenarioDescriptor[] {
  return SCENARIOS.map((scenario) => ({ ...scenario, caseIds: [...scenario.caseIds] }));
}

export function runScenarioParityAcceptanceSuite(
  scenarioIds?: string[]
): ScenarioParityAcceptanceSuiteResult {
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
  scenario: ScenarioParityAcceptanceScenarioDescriptor
): ScenarioParityAcceptanceScenarioResult {
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
