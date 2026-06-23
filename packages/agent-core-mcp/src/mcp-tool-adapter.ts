import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { Tool, ToolContext, ToolResult } from "@turnkeyai/agent-core/tool";
import { createToolkit, type Toolkit } from "@turnkeyai/agent-core/toolkit";
import type { McpCallResult, McpSession, McpToolDescriptor } from "./mcp-transport";

export interface McpToolAdapterOptions {
  /** Prefix prepended to every tool name (e.g. "mcp__filesystem__") to avoid
   *  collisions with native tools. */
  namePrefix?: string;
  /** Keep only the descriptors this returns truthy for. */
  toolFilter?: (descriptor: McpToolDescriptor) => boolean;
}

/** Flatten MCP content blocks into the single string our ToolResult carries. */
function flattenContent(result: McpCallResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text ?? "" : JSON.stringify(block)))
    .join("\n");
}

/** Wrap one MCP server tool as an agent-core Tool. The host context is ignored
 *  (MCP tools are scope-agnostic), so this composes with any `Ctx`. */
export function mcpToolToTool<Ctx extends ToolContext = ToolContext>(
  session: McpSession,
  descriptor: McpToolDescriptor,
  options?: McpToolAdapterOptions
): Tool<Ctx> {
  const name = `${options?.namePrefix ?? ""}${descriptor.name}`;
  return {
    definition: {
      name,
      description: descriptor.description ?? "",
      inputSchema: descriptor.inputSchema,
    },
    async execute(call: LLMToolCall, ctx: Ctx): Promise<ToolResult> {
      try {
        const result = await session.callTool(descriptor.name, call.input, ctx.signal);
        return {
          toolCallId: call.id,
          toolName: name,
          content: flattenContent(result),
          ...(result.isError ? { isError: true } : {}),
          raw: result,
        };
      } catch (error) {
        return {
          toolCallId: call.id,
          toolName: name,
          isError: true,
          content: error instanceof Error ? error.message : "mcp tool call failed",
        };
      }
    },
  };
}

/** Build a Toolkit from every tool an MCP server advertises. */
export async function createMcpToolkit<Ctx extends ToolContext = ToolContext>(
  session: McpSession,
  options?: McpToolAdapterOptions
): Promise<Toolkit<Ctx>> {
  const descriptors = await session.listTools();
  const selected = options?.toolFilter ? descriptors.filter(options.toolFilter) : descriptors;
  return createToolkit<Ctx>(selected.map((descriptor) => mcpToolToTool<Ctx>(session, descriptor, options)));
}
