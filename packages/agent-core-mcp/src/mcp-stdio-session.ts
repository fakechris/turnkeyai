import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpCallResult, McpContentBlock, McpSession, McpToolDescriptor } from "./mcp-transport";

/**
 * The ONLY module that imports `@modelcontextprotocol/sdk`. It produces an
 * {@link McpSession} backed by a stdio child-process MCP server. Everything
 * else in this package depends on the SDK-free `McpSession` interface, so
 * replacing the SDK is a single-file change.
 */
export interface StdioMcpSessionOptions {
  /** Executable that starts the MCP server. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Identity reported to the server during the initialize handshake. */
  clientName?: string;
  clientVersion?: string;
}

export async function createStdioMcpSession(options: StdioMcpSessionOptions): Promise<McpSession> {
  const client = new Client({
    name: options.clientName ?? "turnkeyai-agent-core-mcp",
    version: options.clientVersion ?? "0.0.0",
  });
  const transport = new StdioClientTransport({
    command: options.command,
    ...(options.args ? { args: options.args } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  await client.connect(transport);

  return {
    async listTools(): Promise<McpToolDescriptor[]> {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      }));
    },
    async callTool(name, args, signal): Promise<McpCallResult> {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        signal ? { signal } : undefined
      );
      return {
        content: (Array.isArray(result.content) ? result.content : []) as McpContentBlock[],
        ...(result.isError ? { isError: Boolean(result.isError) } : {}),
      };
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}
