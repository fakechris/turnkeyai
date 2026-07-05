import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type {
  LLMToolCall,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";

import { createEngineRoleToolkit } from "./engine-role-toolkit";
import type { RolePromptPacket } from "../prompt-policy";

test("createEngineRoleToolkit exposes the provided definitions and has lookup", () => {
  const definitions: LLMToolDefinition[] = [
    { name: "memory_search", description: "Search memory", inputSchema: {} },
    { name: "tasks_list", description: "List tasks", inputSchema: {} },
  ];
  const toolkit = createEngineRoleToolkit({
    toolDefinitions: definitions,
    activeToolLoop: undefined,
  });

  assert.deepEqual(toolkit.definitions(), definitions);
  assert.equal(toolkit.has("memory_search"), true);
  assert.equal(toolkit.has("sessions_spawn"), false);
});

test("createEngineRoleToolkit delegates execution to the active role tool loop", async () => {
  const activation = { runState: { roleId: "role-1" } } as RoleActivationInput;
  const packet = { roleId: "role-1", taskPrompt: "Search." } as RolePromptPacket;
  const signal = new AbortController().signal;
  const call: LLMToolCall = {
    id: "call-1",
    name: "memory_search",
    input: { query: "status" },
  };
  const seen: unknown[] = [];
  const toolkit = createEngineRoleToolkit({
    toolDefinitions: [
      { name: "memory_search", description: "Search memory", inputSchema: {} },
    ],
    activeToolLoop: {
      executor: {
        definitions: () => [],
        async execute(input) {
          seen.push(input);
          return {
            toolCallId: input.call.id,
            toolName: input.call.name,
            content: "found",
          };
        },
      },
    },
  });

  const result = await toolkit.execute(call, { activation, packet, signal });

  assert.deepEqual(result, {
    toolCallId: "call-1",
    toolName: "memory_search",
    content: "found",
  });
  assert.deepEqual(seen, [{ call, activation, packet, signal }]);
});

test("createEngineRoleToolkit returns the adapter-compatible unknown-tool result without an active loop", async () => {
  const call: LLMToolCall = {
    id: "call-unknown",
    name: "unknown_tool",
    input: {},
  };
  const toolkit = createEngineRoleToolkit({
    toolDefinitions: [],
    activeToolLoop: undefined,
  });

  const result = await toolkit.execute(call, {
    activation: {} as RoleActivationInput,
    packet: {} as RolePromptPacket,
  });

  assert.deepEqual(result, {
    toolCallId: "call-unknown",
    toolName: "unknown_tool",
    isError: true,
    content: "Unknown tool: unknown_tool",
  });
});
