export const DYNAMIC_CONTEXT_BASELINE_PROTOCOL =
  "turnkeyai.dynamic_context_baseline.v1" as const;

export interface DynamicContextScope {
  threadId: string;
  roleId: string;
  flowId: string;
}

export interface ContextSectionReceipt {
  name: string;
  version: string;
  digest: string;
  sourceRefs: string[];
  packedTokens: number;
  omitted: boolean;
  updatedAt: number;
}

export interface DynamicContextBaseline {
  protocol: typeof DYNAMIC_CONTEXT_BASELINE_PROTOCOL;
  baselineId: string;
  scope: DynamicContextScope;
  promptPackVersion: string;
  modelFingerprint: string;
  toolFingerprint: string;
  sections: ContextSectionReceipt[];
  activatedAt: number;
}

export interface DynamicContextBaselineStore {
  get(scope: DynamicContextScope): Promise<DynamicContextBaseline | null>;
  put(baseline: DynamicContextBaseline): Promise<void>;
}
