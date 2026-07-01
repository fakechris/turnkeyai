// Stage 8 engine cleanup — EvidenceLedger (module shell).
//
// Authority: centralize structured facts (source labels, browser evidence
// dimensions, completed session facts, timeout/cancellation facts, permission
// result facts) read from tool results, messages, prompt packet, and
// activation. It starts as a facade over existing helpers, not a producer
// rewrite.
//
// It does NOT own policy order, tool execution, or final synthesis. Policies may
// read the EvidenceSnapshot it produces; they may not invent inline regexes.
//
// Implementation lands in Batch 5 ("Add EvidenceLedger And TaskFacts Facade").
// This shell reserves the module.
export const EVIDENCE_LEDGER_MODULE = "evidence-ledger" as const;
