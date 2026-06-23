/**
 * The single seam that isolates the MCP SDK from the rest of the codebase.
 *
 * The tool adapter (mcp-tool-adapter.ts) depends ONLY on this interface, never
 * on `@modelcontextprotocol/sdk`. Swapping the SDK for a hand-rolled JSON-RPC
 * client, or stubbing a server in tests, means implementing `McpSession` and
 * nothing else changes.
 */

export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema straight off the server's tools/list response. */
  inputSchema: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpSession {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}
