import type {
  RuntimePolicyRenderKind,
  RuntimePolicyRenderRequest,
} from "./types";

export function buildPolicyIdRenderRequest<
  TKind extends RuntimePolicyRenderKind,
>(kind: TKind, policyId: string): RuntimePolicyRenderRequest<TKind> {
  return {
    kind,
    payload: { policyId },
  };
}
