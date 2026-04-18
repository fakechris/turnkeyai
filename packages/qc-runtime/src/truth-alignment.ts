import type {
  TruthAlignment,
  TruthRemediation,
  TruthRemediationAction,
  TruthRemediationScope,
  TruthSource,
} from "@turnkeyai/core-types/team";

export function buildTruthAlignment(input: {
  confirmed: boolean;
  inferred: boolean;
  stale: boolean;
  truthSource: TruthSource;
  remediation?: TruthRemediation[];
}): TruthAlignment {
  return {
    truthState: input.stale ? "stale" : input.confirmed ? "confirmed" : "inferred",
    confirmed: input.confirmed,
    inferred: input.inferred,
    stale: input.stale,
    truthSource: input.truthSource,
    remediation: dedupeTruthRemediation(input.remediation ?? []),
  };
}

export function truthRemediation(input: {
  action: TruthRemediationAction;
  scope: TruthRemediationScope;
  summary: string;
  subjectId?: string;
}): TruthRemediation {
  return {
    action: input.action,
    scope: input.scope,
    summary: input.summary,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
  };
}

export function dedupeTruthRemediation(remediation: TruthRemediation[]): TruthRemediation[] {
  const deduped = new Map<string, TruthRemediation>();
  for (const item of remediation) {
    const key = JSON.stringify([item.action, item.scope, item.subjectId ?? "", item.summary]);
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return [...deduped.values()];
}
