// Stage 8 engine cleanup — PermissionPolicy (module shell).
//
// Authority: own permission-query suppression and approval-gate compatibility
// decisions (read-only permission-query suppression; approval-gated browser
// rewrite / forced permission-query decisions that currently depend on
// compatibility detectors; future tool filtering if the engine adopts
// filterTools).
//
// It does NOT execute tools, repair final-answer quality unrelated to
// permission, or synthesize completed closeout. It must not add new raw regexes
// outside legacy-text-detectors.ts.
//
// Implementation lands in Batch 1. This shell reserves the module.
export const PERMISSION_POLICY_MODULE = "permission-policy" as const;
