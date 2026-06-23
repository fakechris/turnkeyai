import assert from "node:assert/strict";
import test from "node:test";

import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { McpCallResult, McpSession, McpToolDescriptor } from "./mcp-transport";
import { createMcpToolkit, mcpToolToTool } from "./mcp-tool-adapter";

function fakeSession(overrides?: {
  tools?: McpToolDescriptor[];
  call?: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
}): McpSession & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async listTools() {
      return (
        overrides?.tools ?? [
          { name: "read_file", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          { name: "write_file", inputSchema: { type: "object" } },
        ]
      );
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (overrides?.call) return overrides.call(name, args);
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
    async close() {},
  };
}

const call = (name: string, input: Record<string, unknown> = {}): LLMToolCall => ({ id: `c-${name}`, name, input });

test("mcpToolToTool passes the MCP inputSchema through verbatim and prefixes the name", () => {
  const descriptor: McpToolDescriptor = { name: "read_file", description: "d", inputSchema: { type: "object", additionalProperties: false } };
  const tool = mcpToolToTool(fakeSession(), descriptor, { namePrefix: "mcp__fs__" });
  assert.equal(tool.definition.name, "mcp__fs__read_file");
  assert.equal(tool.definition.description, "d");
  assert.deepEqual(tool.definition.inputSchema, { type: "object", additionalProperties: false });
});

test("mcpToolToTool flattens text blocks and calls the unprefixed server name", async () => {
  const session = fakeSession();
  const tool = mcpToolToTool(session, { name: "read_file", inputSchema: { type: "object" } }, { namePrefix: "mcp__fs__" });
  const result = await tool.execute(call("mcp__fs__read_file", { path: "/x" }), {});
  // dispatched name is prefixed, but the server is called with its own name
  assert.deepEqual(session.calls, [{ name: "read_file", args: { path: "/x" } }]);
  assert.equal(result.content, "ran read_file");
  assert.equal(result.isError, undefined);
});

test("mcpToolToTool maps an MCP error result to an error ToolResult", async () => {
  const session = fakeSession({ call: async () => ({ content: [{ type: "text", text: "nope" }], isError: true }) });
  const tool = mcpToolToTool(session, { name: "boom", inputSchema: { type: "object" } });
  const result = await tool.execute(call("boom"), {});
  assert.equal(result.isError, true);
  assert.equal(result.content, "nope");
});

test("mcpToolToTool converts a thrown transport error into an error ToolResult", async () => {
  const session = fakeSession({ call: async () => { throw new Error("transport closed"); } });
  const tool = mcpToolToTool(session, { name: "boom", inputSchema: { type: "object" } });
  const result = await tool.execute(call("boom"), {});
  assert.equal(result.isError, true);
  assert.equal(result.content, "transport closed");
});

test("mcpToolToTool JSON-stringifies non-text content blocks", async () => {
  const session = fakeSession({ call: async () => ({ content: [{ type: "image", data: "abc" }] }) });
  const tool = mcpToolToTool(session, { name: "shot", inputSchema: { type: "object" } });
  const result = await tool.execute(call("shot"), {});
  assert.equal(result.content, JSON.stringify({ type: "image", data: "abc" }));
});

test("createMcpToolkit registers every advertised tool and routes by prefixed name", async () => {
  const toolkit = await createMcpToolkit(fakeSession(), { namePrefix: "mcp__fs__" });
  assert.deepEqual(toolkit.definitions().map((d) => d.name), ["mcp__fs__read_file", "mcp__fs__write_file"]);
  const result = await toolkit.execute(call("mcp__fs__write_file"), {});
  assert.equal(result.content, "ran write_file");
});

test("createMcpToolkit honors toolFilter", async () => {
  const toolkit = await createMcpToolkit(fakeSession(), { toolFilter: (d) => d.name === "read_file" });
  assert.deepEqual(toolkit.definitions().map((d) => d.name), ["read_file"]);
  assert.equal(toolkit.has("write_file"), false);
});
