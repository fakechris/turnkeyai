// Stage 8 engine cleanup — CompletedCloseoutController (module shell).
//
// Authority: own completed-session final synthesis, the completed repair loop,
// and the final clean synthesis when a repair produces tool-call artifact text.
// It makes the current terminal-hook simulation explicit and bounded.
//
// It uses an injected FinalSynthesizer (no direct model gateway import) and
// reuses RepairPolicyRegistry. It does NOT own ordinary tool execution, the
// normalizer pipeline, the final appendix pipeline, or new simulated main-loop
// behavior beyond the current compatibility ceiling (completed repair loop plus
// one clean synthesis after a tool-call artifact).
//
// Implementation lands in Batch 4. This shell reserves the module.
export const COMPLETED_CLOSEOUT_CONTROLLER_MODULE = "completed-closeout-controller" as const;
