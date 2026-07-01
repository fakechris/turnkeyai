// Stage 8 engine cleanup — FinalizationPipeline (module shell).
//
// Authority: own final text transforms after a final answer has been selected
// (local/private URL redaction; timeout continuation visibility appendix;
// required follow-up visibility appendix; residual-risk visibility appendix;
// browser failure bucket appendix; final metadata-only shaping that does not
// decide policy).
//
// It does NOT call the model, execute tools, run answer-repair prompts, or
// decide closeout precedence. It must not inspect mutable run state directly;
// callers pass a snapshot.
//
// Implementation lands in Batch 1. This shell reserves the module.
export const FINALIZATION_PIPELINE_MODULE = "finalization-pipeline" as const;
