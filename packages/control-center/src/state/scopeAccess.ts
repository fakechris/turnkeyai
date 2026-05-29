import type { Scope } from "./types";

export const OPERATOR_ACTION_SCOPE_HINT =
  "Open with an operator or admin token to run this action.";

export function canUseOperatorActions(scope: Scope): boolean {
  return scope !== "read";
}
