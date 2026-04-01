import type { RoleSlot } from "@turnkeyai/core-types/team";

export interface RoleModelSelection {
  modelId?: string;
  modelChainId?: string;
}

export interface RoleModelHint {
  provider: string;
  name: string;
}

export function getRoleModelSelection(role: RoleSlot): RoleModelSelection {
  return {
    ...(role.modelRef ? { modelId: role.modelRef } : role.model?.name ? { modelId: role.model.name } : {}),
    ...(role.modelChain ? { modelChainId: role.modelChain } : {}),
  };
}

export function getRoleModelHint(role: RoleSlot): RoleModelHint {
  const selection = getRoleModelSelection(role);
  return {
    provider: role.model?.provider ?? "unknown",
    name: selection.modelId ?? selection.modelChainId ?? "unknown",
  };
}
