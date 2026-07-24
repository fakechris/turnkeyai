import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import {
  CONTEXT_SOURCE_DIGEST_PROTOCOL,
  guardContextCheckpointSource,
} from "./context-source-guard";

function assistantToolUse(id: string, tool = "web_fetch"): LLMMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: tool,
        input: { url: `https://example.com/${id}` },
      },
    ],
  };
}

function toolResult(id: string, content = `${id} evidence`): LLMMessage {
  return {
    role: "tool",
    toolCallId: id,
    name: "web_fetch",
    content,
  };
}

function history(rounds: number, resultChars = 80): LLMMessage[] {
  return Array.from({ length: rounds }, (_, index) => {
    const id = `call-${index + 1}`;
    return [
      assistantToolUse(id),
      toolResult(id, `${id}:${"x".repeat(resultChars)}`),
    ];
  }).flat();
}

test("context source guard leaves a bounded protocol-safe source unchanged", () => {
  const messages = history(3);
  const result = guardContextCheckpointSource(messages, {
    maxSourceMessages: 100,
    maxSourceBytes: 100_000,
    maxSourceTokens: 100_000,
  });

  assert.equal(result.messages, messages);
  assert.equal(result.snapshot.protocolSafe, true);
  assert.equal(result.snapshot.compacted, false);
  assert.equal(result.snapshot.digestedMessageCount, 0);
});

test("context source guard retains recent complete protocol units and digests the old prefix", () => {
  const messages = history(12, 500);
  const result = guardContextCheckpointSource(messages, {
    maxSourceMessages: 9,
    maxSourceBytes: 4_000,
    maxSourceTokens: 2_000,
    recentProtocolUnits: 4,
    maxSampleChars: 80,
  });

  assert.equal(result.snapshot.compacted, true);
  assert.equal(result.snapshot.protocolSafe, true);
  assert.equal(result.messages.length <= 9, true);
  assert.equal(result.snapshot.guardedBytes <= 4_000, true);
  assert.equal(result.snapshot.guardedTokens <= 2_000, true);
  assert.deepEqual(result.messages.slice(-8), messages.slice(-8));
  assert.equal(result.messages[0]?.role, "user");
  const digest = JSON.parse(String(result.messages[0]?.content)) as {
    protocol: string;
    source_messages: number;
  };
  assert.equal(digest.protocol, CONTEXT_SOURCE_DIGEST_PROTOCOL);
  assert.equal(digest.source_messages, 16);
});

test("context source guard is deterministic for the same transcript", () => {
  const messages = history(20, 300);
  const options = {
    maxSourceMessages: 7,
    maxSourceBytes: 3_000,
    maxSourceTokens: 1_500,
    recentProtocolUnits: 3,
  };

  const first = guardContextCheckpointSource(messages, options);
  const second = guardContextCheckpointSource(structuredClone(messages), options);

  assert.deepEqual(first, second);
});

test("context source guard fails closed on an incomplete tool protocol unit", () => {
  const messages = [...history(4), assistantToolUse("missing")];
  const result = guardContextCheckpointSource(messages, {
    maxSourceMessages: 2,
    maxSourceBytes: 200,
    maxSourceTokens: 50,
  });

  assert.equal(result.messages, messages);
  assert.equal(result.snapshot.protocolSafe, false);
  assert.equal(result.snapshot.compacted, false);
});

test("context source guard can collapse every complete unit into one bounded digest", () => {
  const messages = history(5, 5_000);
  const result = guardContextCheckpointSource(messages, {
    maxSourceMessages: 1,
    maxSourceBytes: 900,
    maxSourceTokens: 400,
    recentProtocolUnits: 4,
    maxDigestGroups: 2,
    maxRepresentativeSamplesPerGroup: 1,
    maxSampleChars: 60,
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "user");
  assert.equal(result.snapshot.digestedProtocolUnitCount, 5);
  assert.equal(result.snapshot.retainedProtocolUnitCount, 0);
  assert.equal(result.snapshot.guardedBytes <= 900, true);
  assert.equal(result.snapshot.guardedTokens <= 400, true);
});

test("context source guard groups repeated tool units and reports representative statistics", () => {
  const messages = history(10, 200);
  const result = guardContextCheckpointSource(messages, {
    maxSourceMessages: 3,
    maxSourceBytes: 2_000,
    maxSourceTokens: 900,
    recentProtocolUnits: 1,
  });
  const digest = JSON.parse(String(result.messages[0]?.content)) as {
    groups: Array<{ key: string; count: number; message_count: number }>;
  };

  assert.equal(digest.groups.length >= 1, true);
  assert.equal(digest.groups.some((group) => group.count >= 9), true);
  assert.equal(digest.groups.some((group) => group.message_count >= 18), true);
});

test("context source guard bounds a transcript beyond 4,000 messages and 8 MiB with defaults", () => {
  const messages = history(2_001, 4_500);
  const result = guardContextCheckpointSource(messages);

  assert.equal(messages.length > 4_000, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(messages), "utf8") > 8 * 1024 * 1024,
    true,
  );
  assert.equal(result.snapshot.protocolSafe, true);
  assert.equal(result.snapshot.compacted, true);
  assert.equal(result.messages.length <= 4_000, true);
  assert.equal(result.snapshot.guardedBytes <= 8 * 1024 * 1024, true);
  assert.deepEqual(result.messages.slice(-8), messages.slice(-8));
});
