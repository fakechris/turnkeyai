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

/** Flatten MCP content blocks into the single string our ToolResult carries.
 *  Falls back to the structured payload when a tool returns only
 *  `structuredContent` (common when it declares an outputSchema). */
function flattenContent(result: McpCallResult): string {
  const text = (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text ?? "" : JSON.stringify(block)))
    .join("\n");
  if (text.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return text;
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
        const result = await session.callTool(descriptor.name, call.input ?? {}, ctx.signal);
        return {
          toolCallId: call.id,
          toolName: name,
          content: flattenContent(result),
          ...(result.isError ? { isError: true } : {}),
          raw: result,
        };
      } catch (error) {
        // An aborted in-flight call is a cancellation, not a failure — downstream
        // runtime code treats the two differently.
        if (ctx.signal?.aborted) {
          return {
            toolCallId: call.id,
            toolName: name,
            cancelled: true,
            content: "mcp tool call cancelled",
          };
        }
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
