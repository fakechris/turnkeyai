import assert from "node:assert/strict";
import test from "node:test";

import type {
  LLMToolCall,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";

import { createNativeToolCapabilityRegistry } from "../tool-capability-registry";
import {
  applyToolArgumentValidationBeforeAdmission,
  createToolArgumentValidator,
} from "./tool-argument-validator";

const SEARCH_TOOL: LLMToolDefinition = {
  name: "memory_search",
  description: "Search memory",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "number", minimum: 1, maximum: 10 },
    },
    required: ["query"],
  },
};

function call(
  id: string,
  name: string,
  input: Record<string, unknown>,
): LLMToolCall {
  return { id, name, input };
}

test("ToolArgumentValidator compiles every native tool schema", () => {
  const registry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["browser", "explore"],
    permissionsEnabled: true,
    memoryEnabled: true,
    tasksEnabled: true,
    webFetchEnabled: true,
  });

  assert.equal(registry.definitions().length, 13);
  assert.doesNotThrow(() =>
    createToolArgumentValidator(registry.definitions()),
  );
});

test("every native tool schema rejects unexpected properties", () => {
  const definitions = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["browser", "explore"],
    permissionsEnabled: true,
    memoryEnabled: true,
    tasksEnabled: true,
    webFetchEnabled: true,
  }).definitions();
  const validator = createToolArgumentValidator(definitions);
  const calls = definitions.map((definition, index) =>
    call(`unexpected-${index}`, definition.name, { __unexpected: true }),
  );

  const decision = validator.validate(calls);

  assert.deepEqual(decision.executable, []);
  assert.deepEqual(
    decision.rejected.map((result) => result.toolName),
    definitions.map((definition) => definition.name),
  );
});

test("ToolArgumentValidator rejects non-object provider payloads without throwing", () => {
  const validator = createToolArgumentValidator([SEARCH_TOOL]);
  const malformedInputs: unknown[] = [null, [], "query", 3, true];

  for (const [index, input] of malformedInputs.entries()) {
    const decision = validator.validate([
      call(
        `malformed-${index}`,
        "memory_search",
        input as Record<string, unknown>,
      ),
    ]);
    assert.equal(decision.executable.length, 0);
    assert.equal(decision.rejected[0]?.isError, true);
  }
});

test("ToolArgumentValidator passes valid calls through unchanged", () => {
  const validator = createToolArgumentValidator([SEARCH_TOOL]);
  const valid = call("call-valid", "memory_search", {
    query: "release decision",
    limit: 5,
  });

  const decision = validator.validate([valid]);

  assert.deepEqual(decision, { executable: [valid], rejected: [] });
});

test("ToolArgumentValidator rejects invalid arguments with structured repair guidance", () => {
  const validator = createToolArgumentValidator([SEARCH_TOOL]);
  const invalid = call("call-invalid", "memory_search", {
    limit: "many",
    secret: "must-not-be-echoed",
  });

  const decision = validator.validate([invalid]);

  assert.deepEqual(decision.executable, []);
  assert.equal(decision.rejected.length, 1);
  const result = decision.rejected[0]!;
  assert.equal(result.toolCallId, invalid.id);
  assert.equal(result.toolName, invalid.name);
  assert.equal(result.isError, true);
  assert.equal(result.skipped, true);
  const payload = JSON.parse(result.content) as {
    protocol: string;
    code: string;
    tool_name: string;
    issues: Array<{ path: string; keyword: string; expected: string }>;
    instruction: string;
  };
  assert.equal(payload.protocol, "turnkeyai.tool_argument_error.v1");
  assert.equal(payload.code, "invalid_tool_arguments");
  assert.equal(payload.tool_name, "memory_search");
  assert.deepEqual(
    payload.issues.map((issue) => [issue.path, issue.keyword]),
    [
      ["/query", "required"],
      ["/", "additionalProperties"],
      ["/limit", "type"],
    ],
  );
  assert.match(payload.instruction, /correct the arguments and resend/i);
  assert.doesNotMatch(result.content, /must-not-be-echoed/);
});

test("ToolArgumentValidator rejects tools that were not offered to the model", () => {
  const validator = createToolArgumentValidator([SEARCH_TOOL]);
  const unknown = call("call-unknown", "tasks_update", {
    work_item_id: "item-1",
  });

  const decision = validator.validate([unknown]);

  assert.deepEqual(decision.executable, []);
  const result = decision.rejected[0]!;
  const payload = JSON.parse(result.content) as {
    code: string;
    tool_name: string;
    issues: Array<{ path: string; keyword: string; expected: string }>;
  };
  assert.equal(payload.code, "unknown_tool");
  assert.equal(payload.tool_name, "tasks_update");
  assert.deepEqual(payload.issues, [
    { path: "/", keyword: "tool", expected: "an offered tool name" },
  ]);
});

test("ToolArgumentValidator preserves admission order across mixed calls", () => {
  const validator = createToolArgumentValidator([SEARCH_TOOL]);
  const calls = [
    call("valid-1", "memory_search", { query: "one" }),
    call("invalid-1", "memory_search", {}),
    call("valid-2", "memory_search", { query: "two" }),
  ];

  const decision = validator.validate(calls);

  assert.deepEqual(
    decision.executable.map((item) => item.id),
    ["valid-1", "valid-2"],
  );
  assert.deepEqual(
    decision.rejected.map((item) => item.toolCallId),
    ["invalid-1"],
  );
});

test("tool argument validation runs before execution-budget admission", () => {
  const validator = createToolArgumentValidator([SEARCH_TOOL]);
  const calls = [
    call("invalid", "memory_search", {}),
    call("valid", "memory_search", { query: "release decision" }),
  ];
  const budgetInputs: string[][] = [];

  const decision = applyToolArgumentValidationBeforeAdmission({
    calls,
    validator,
    admit(executable) {
      budgetInputs.push(executable.map((item) => item.id));
      return { executable: executable.slice(0, 1), rejected: [] };
    },
  });

  assert.deepEqual(budgetInputs, [["valid"]]);
  assert.deepEqual(
    decision.executable.map((item) => item.id),
    ["valid"],
  );
  assert.deepEqual(
    decision.rejected.map((item) => item.toolCallId),
    ["invalid"],
  );
});
