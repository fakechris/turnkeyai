import type { LLMToolCall, LLMToolDefinition } from "@turnkeyai/llm-adapter/types";
import type { Tool, ToolContext, ToolResult } from "./tool";

/** A name-indexed registry of tools that dispatches a tool call by name. */
export interface Toolkit<Ctx extends ToolContext = ToolContext> {
  definitions(): LLMToolDefinition[];
  has(name: string): boolean;
  execute(call: LLMToolCall, ctx: Ctx): Promise<ToolResult>;
}

/**
 * Build a toolkit from an ordered list of tools.
 *
 * Insertion order is preserved by `definitions()` so callers that filter or
 * truncate the definition list see a stable, deterministic ordering. When two
 * tools share a name the later one wins (last registration); this mirrors a
 * plain object/switch override and keeps host wiring predictable.
 */
export function createToolkit<Ctx extends ToolContext>(tools: Array<Tool<Ctx>>): Toolkit<Ctx> {
  const byName = new Map<string, Tool<Ctx>>();
  for (const tool of tools) {
    byName.set(tool.definition.name, tool);
  }
  const definitions = tools.map((tool) => tool.definition);
  return {
    definitions() {
      return definitions;
    },
    has(name) {
      return byName.has(name);
    },
    async execute(call, ctx) {
      const tool = byName.get(call.name);
      if (!tool) {
        return {
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          content: `Unknown tool: ${call.name}`,
        };
      }
      return tool.execute(call, ctx);
    },
  };
}
