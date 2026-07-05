import type { Toolkit } from "@turnkeyai/agent-core/toolkit";
import type { LLMToolDefinition } from "@turnkeyai/llm-adapter/index";

import type {
  RoleToolContext,
  RoleToolLoopOptions,
} from "../tool-use";

export interface CreateEngineRoleToolkitInput {
  toolDefinitions: LLMToolDefinition[];
  activeToolLoop: RoleToolLoopOptions | undefined;
}

export function createEngineRoleToolkit(
  input: CreateEngineRoleToolkitInput,
): Toolkit<RoleToolContext> {
  const { toolDefinitions, activeToolLoop } = input;
  return {
    definitions: () => toolDefinitions,
    has: (name) => toolDefinitions.some((def) => def.name === name),
    execute: (call, ctx) =>
      activeToolLoop
        ? activeToolLoop.executor.execute({
            call,
            activation: ctx.activation,
            packet: ctx.packet,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          })
        : Promise.resolve({
            toolCallId: call.id,
            toolName: call.name,
            isError: true,
            content: `Unknown tool: ${call.name}`,
          }),
  };
}
