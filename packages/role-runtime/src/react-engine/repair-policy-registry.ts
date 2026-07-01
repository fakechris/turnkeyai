// Stage 8 engine cleanup — RepairPolicyRegistry (module shell).
//
// Authority: own candidate-answer repair rules, order, evidence formulas, and
// markers. Natural-finish order and completed-closeout order are declared as
// exported arrays (added in Batch 3). Every repair declares id, phase, order,
// evidenceFormula, and marker, and returns an EngineRepairDecision.
//
// It does NOT own final visibility appenders, tool execution, or generic
// tool-call normalization. Markers come from a repair ledger / passed snapshot,
// not raw ad hoc message scans.
//
// Implementation lands in Batch 3. This shell reserves the module.
export const REPAIR_POLICY_REGISTRY_MODULE = "repair-policy-registry" as const;
