// Stage 8 engine cleanup — EngineRunObserver (module shell).
//
// Authority: own every observability sink used by the engine path (toolTrace,
// native tool messages, runtime progress events, provider tool protocol round
// boundary, model-use summary, pruning/reduction/memory-flush metadata) and
// produce one metadata snapshot at the end of the run.
//
// It does NOT decide whether a tool call is allowed, whether a continuation
// fires, whether a repair fires, or transform final answer text.
//
// Implementation lands in Batch 1 ("Extract Observability, Normalization, And
// Finalization"). This shell only reserves the module and its public entry
// point so the layout compiles.
export const ENGINE_RUN_OBSERVER_MODULE = "engine-run-observer" as const;
