import {
  LEGACY_TEXT_DETECTORS,
  runLegacyTextDetector,
  type LegacyTextDetectorResult,
} from "./legacy-text-detectors";

export const LEGACY_TRACE_IMPORTER_MODULE = "legacy-trace-importer" as const;

export interface LegacyTraceImportInput {
  text: string;
  detectorIds?: readonly string[];
}

export interface LegacyTraceImportResult {
  facts: LegacyTextDetectorResult[];
}

export function importLegacyTraceFacts(
  input: LegacyTraceImportInput,
): LegacyTraceImportResult {
  const detectorIds =
    input.detectorIds ??
    LEGACY_TEXT_DETECTORS.map((detector) => detector.id);
  return {
    facts: detectorIds
      .map((id) => runLegacyTextDetector(id, input.text))
      .filter((result) => result.matched),
  };
}
