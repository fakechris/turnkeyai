// Stage 8 engine cleanup — legacy text detectors (module shell).
//
// Authority: hold legacy text-fallback detectors for facts that are not yet
// structured. Every detector added here must state the structured field that
// should replace it, its producer, its feasibility class (already_structured,
// present_only_as_text, or missing_from_producer), and the Stage 8
// inventory/debt row it centralizes. Detectors need positive and negative
// fixtures.
//
// HARD INVARIANT: no detector here may authorize, retroactively validate, or
// execute a side-effect tool. Detectors return facts only.
//
// Implementation lands in Batch 5. This shell reserves the module.
export const LEGACY_TEXT_DETECTORS_MODULE = "legacy-text-detectors" as const;
