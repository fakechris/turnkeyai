// Stage 8 engine cleanup — ExecutionBudgetController (module shell).
//
// Authority: own execution budget and batching mechanics (final-round warning
// before model call; max tool calls per round cap; wall-clock abort signal and
// budget checks; batch grouping for serial vs concurrent execution;
// recovery-budget truncation of pending calls; synthetic skipped results for
// over-cap calls).
//
// It does NOT decide whether an answer needs repair, whether a completed
// session closeout should synthesize final text, or continuation semantics
// beyond budget signal data. It exposes wall-clock/recovery-budget snapshots for
// CloseoutPolicyRegistry but must not independently select wall_clock_budget or
// recovery_tool_budget closeouts.
//
// Implementation lands in Batch 2. This shell reserves the module.
export const EXECUTION_BUDGET_CONTROLLER_MODULE = "execution-budget-controller" as const;
