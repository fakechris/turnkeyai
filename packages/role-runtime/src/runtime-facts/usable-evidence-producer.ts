import type {
  EvidenceEnvelope,
  EvidenceProvenance,
  RuntimeFactInput,
  UsableEvidenceFacts,
} from "./types";
import { nativeToolResultTraceHasUsableEvidence } from "../tool-protocol";

export function produceUsableEvidenceEnvelope(
  input: Pick<RuntimeFactInput, "toolTrace">,
): EvidenceEnvelope<"usable_evidence", UsableEvidenceFacts> {
  const provenance = buildUsableEvidenceProvenance(input.toolTrace);
  return {
    kind: "usable_evidence",
    schemaVersion: 1,
    facts: {
      usableEvidence: provenance.length > 0,
    },
    provenance,
  };
}

function buildUsableEvidenceProvenance(
  toolTrace: RuntimeFactInput["toolTrace"],
): EvidenceProvenance[] {
  return toolTrace.flatMap((round, traceIndex) =>
    round.results
      .filter(nativeToolResultTraceHasUsableEvidence)
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
