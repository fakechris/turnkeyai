import type {
  EvidenceEnvelope,
  EvidenceProvenance,
  RuntimeFactInput,
  UsableEvidenceFacts,
} from "./types";

export function produceUsableEvidenceEnvelope(
  input: Pick<RuntimeFactInput, "toolTrace">,
): EvidenceEnvelope<"usable_evidence", UsableEvidenceFacts> {
  return {
    kind: "usable_evidence",
    schemaVersion: 1,
    facts: {
      usableEvidence: input.toolTrace.some((round) =>
        round.results.some((result) => !result.isError && result.skipped !== true),
      ),
    },
    provenance: buildUsableEvidenceProvenance(input.toolTrace),
  };
}

function buildUsableEvidenceProvenance(
  toolTrace: RuntimeFactInput["toolTrace"],
): EvidenceProvenance[] {
  return toolTrace.flatMap((round, traceIndex) =>
    round.results
      .filter((result) => !result.isError && result.skipped !== true)
      .map((result) => ({
        source: "native_tool_trace" as const,
        toolName: result.toolName,
        toolCallId: result.toolCallId,
        roundIndex: round.round,
        traceIndex,
        messageIndex: null,
      })),
  );
}
