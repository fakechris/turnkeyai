export const DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS = [
  "basic",
  "approval",
  "followup",
  "timeout",
  "complex",
] as const;

export const DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS = [
  "basic",
  "approval",
  "followup",
  "timeout",
] as const;

export const DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS = [
  "basic",
  "comparison",
  "followup",
  "cancel",
  "approval",
  "browser-dynamic",
  "browser-dashboard",
  "timeout-recovery",
  "memory-recall",
  "task-tracking",
  "product-workbench-brief",
  "realistic-brief",
] as const;

export const DEFAULT_REAL_ACCEPTANCE_NATURAL_MISSION_SCENARIOS = [
  "natural-comparison-research",
  "natural-provider-search-pricing",
  "natural-browser-dynamic-page",
  "natural-browser-dashboard-task",
  "natural-browser-external-page-review",
  "natural-browser-complex-page-review",
  "natural-browser-followup-continuation",
  "natural-browser-restart-continuation",
  "natural-browser-cold-recreation-continuation",
  "natural-browser-profile-lock-recovery",
  "natural-followup-continuation",
  "natural-memory-recall",
  "natural-memory-pressure-flush",
  "natural-memory-invalidation",
  "natural-tool-result-pruning",
  "natural-approval-dry-run-action",
  "natural-approval-denied-safe-closeout",
  "natural-approval-pending-state",
  "natural-approval-wait-timeout-closeout",
  "natural-browser-unavailable-closeout",
  "natural-browser-cdp-timeout-closeout",
  "natural-browser-detached-target-closeout",
  "natural-browser-attach-failed-closeout",
  "natural-timeout-partial-closeout",
  "natural-timeout-followup-continuation",
  "natural-cancel-active-tool",
  "natural-cancel-followup-continuation",
  "natural-asiawalk-multi-agent",
  "natural-long-delegation",
] as const;

export const DEFAULT_REAL_ACCEPTANCE_NATURAL_CORE_AB_SCENARIOS = [
  "natural-comparison-research",
  "natural-provider-search-pricing",
  "natural-browser-dynamic-page",
  "natural-followup-continuation",
  "natural-approval-dry-run-action",
  "natural-long-delegation",
  "natural-asiawalk-multi-agent",
  "natural-timeout-followup-continuation",
  "natural-memory-recall",
] as const;

export const DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_RELIABILITY_AB_SCENARIOS = [
  "natural-browser-followup-continuation",
  "natural-browser-restart-continuation",
  "natural-browser-cold-recreation-continuation",
  "natural-browser-profile-lock-recovery",
  "natural-browser-unavailable-closeout",
  "natural-browser-cdp-timeout-closeout",
  "natural-browser-detached-target-closeout",
  "natural-browser-attach-failed-closeout",
] as const;

export const DEFAULT_REAL_ACCEPTANCE_NATURAL_BROWSER_AB_SCENARIOS = [
  "natural-browser-external-page-review",
  "natural-browser-complex-page-review",
] as const;

export function joinRealAcceptanceScenarios(scenarios: readonly string[]): string {
  return scenarios.join(",");
}
