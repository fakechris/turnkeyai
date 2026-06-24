import type { RoleId, ThreadId } from "@turnkeyai/core-types/team";
import type { MemoryProvider } from "@turnkeyai/agent-core/memory-provider";
import type { RoleMemoryResolver } from "./role-memory-resolver";

/**
 * Bridges TurnkeyAI's thread+role scoped {@link RoleMemoryResolver} to the
 * generic, scope-agnostic {@link MemoryProvider} contract in agent-core.
 *
 * agent-core treats the memory scope as an opaque `namespace` string. The host
 * owns the encoding: here a thread id and role id are packed into one namespace
 * and unpacked on the way back, so a generic agent can recall TurnkeyAI memory
 * without agent-core ever learning about threads or roles.
 */

const NAMESPACE_SEPARATOR = "::";

/** Encode a thread id + role id into an opaque memory namespace. */
export function memoryNamespace(threadId: ThreadId, roleId: RoleId): string {
  return `${threadId}${NAMESPACE_SEPARATOR}${roleId}`;
}

/** Decode a namespace produced by {@link memoryNamespace}. */
export function parseMemoryNamespace(namespace: string): { threadId: ThreadId; roleId: RoleId } {
  if (typeof namespace !== "string") {
    throw new Error(`invalid memory namespace (expected string): ${String(namespace)}`);
  }
  const index = namespace.indexOf(NAMESPACE_SEPARATOR);
  if (index < 0) {
    throw new Error(`invalid memory namespace (expected "<threadId>${NAMESPACE_SEPARATOR}<roleId>"): ${namespace}`);
  }
  return {
    threadId: namespace.slice(0, index) as ThreadId,
    roleId: namespace.slice(index + NAMESPACE_SEPARATOR.length) as RoleId,
  };
}

/** Present a RoleMemoryResolver as a generic agent-core MemoryProvider. */
export function asMemoryProvider(
  resolver: Pick<RoleMemoryResolver, "retrieveMemory" | "getMemory">
): MemoryProvider {
  return {
    async retrieve({ namespace, queryText, limit }) {
      const { threadId, roleId } = parseMemoryNamespace(namespace);
      const hits = await resolver.retrieveMemory({ threadId, roleId, queryText });
      // Clamp to >= 0: a negative limit would otherwise slice from the end and
      // silently drop the highest-ranked hits.
      return typeof limit === "number" ? hits.slice(0, Math.max(0, limit)) : hits;
    },
    async get({ namespace, memoryId }) {
      const { threadId, roleId } = parseMemoryNamespace(namespace);
      return resolver.getMemory({ threadId, roleId, memoryId });
    },
  };
}
