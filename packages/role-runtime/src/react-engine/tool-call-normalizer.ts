// Stage 8 engine cleanup — ToolCallNormalizer (module shell).
//
// Authority: own syntactic and routing normalization before execution and
// preserve the current ENGINE_TOOL_CALL_NORMALIZATION_ORDER. The normalizer
// holds the order; PermissionPolicy approval-gate logic is a dependency called
// from the two existing approval-gate steps (positions 2 and 13), not a sibling
// pre-pass.
//
// It does NOT own side-effect permission allow/deny, final-answer repair,
// closeout synthesis, or progress recording. The only mutation allowed is
// returning a new call list.
//
// Implementation (moving ENGINE_TOOL_CALL_NORMALIZATION_ORDER, the pipeline, and
// owned helpers out of llm-response-generator.ts) lands in Batch 1. This shell
// reserves the module.
export const TOOL_CALL_NORMALIZER_MODULE = "tool-call-normalizer" as const;
