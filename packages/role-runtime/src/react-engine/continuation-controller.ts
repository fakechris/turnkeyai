// Stage 8 engine cleanup — ContinuationController (module shell).
//
// Authority: own the session/browser continuation plane (empty-round
// continuation injection; session lookup injection; direct sessions_send
// precedence over lookup; timeout follow-up continuation; supplemental browser
// probe after relevant timeouts; incomplete approved-browser session
// continuation; independent evidence stream continuation; forced
// permission-result round before model-error/closeout when required).
//
// It does NOT own final-answer repairs, completed closeout synthesis, the
// normalizer order, or runtime progress recording. It returns actions; it does
// not directly mutate state.messages. Every action carries a reason string for
// policy trace.
//
// Implementation lands in Batch 2. This shell reserves the module.
export const CONTINUATION_CONTROLLER_MODULE = "continuation-controller" as const;
