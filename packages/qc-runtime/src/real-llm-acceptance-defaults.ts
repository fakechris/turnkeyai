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

export function joinRealAcceptanceScenarios(scenarios: readonly string[]): string {
  return scenarios.join(",");
}
