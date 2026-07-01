// Stage 8 engine cleanup — TaskFacts (module shell).
//
// Authority: centralize task prompt facts currently inferred repeatedly
// (requested table columns, requires-browser-evidence, requested browser
// dimensions, requested next actions, source evidence requirements). Starts as a
// facade over existing helpers/text, not a producer rewrite.
//
// It does NOT own policy order, tool execution, or final synthesis.
//
// Implementation lands in Batch 5. This shell reserves the module.
export const TASK_FACTS_MODULE = "task-facts" as const;
