import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import { HeuristicModelAdapter } from "./model-adapter";
import { DefaultRoleProfileRegistry } from "./role-profile";

test("heuristic fallback lead synthesis uses latest tool evidence instead of a generic success line", async () => {
  const adapter = new HeuristicModelAdapter();
  const activation = buildActivationWithToolResult();
  const profile = new DefaultRoleProfileRegistry().resolve(activation.thread.roles[0]!);

  const result = await adapter.invoke({
    activation,
    profile,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue from the slow-source attempt.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.match(result.content, /Final synthesis based on the latest tool result/);
  assert.match(result.content, /Verified resumed source evidence/);
  assert.match(result.content, /Unverified/);
  assert.match(result.content, /Residual risk/);
  assert.match(result.content, /Continuation/);
  assert.doesNotMatch(result.content, /daemon, flow ledger, role runs/i);
});

test("heuristic fallback lead synthesis extracts nested session tool evidence without raw JSON", async () => {
  const adapter = new HeuristicModelAdapter();
  const activation = buildActivationWithToolResult([
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: "task-1",
      session_key: "worker:explore:1",
      agent_id: "explore",
      label: "fetch-cancel-resume-fixture",
      status: "cancelled",
      result: "operator cancelled active source verification",
    }),
    [
      "sessions_send result:",
      JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:explore:1",
        agent_id: "explore",
        label: "fetch-cancel-resume-fixture",
        status: "completed",
        result: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          final_content: null,
          payload: null,
        }),
        payload: {
          final_content: [
            "<p>Verified owner: Release Captain.</p>",
            "<p>Verified risk: runbook gap before launch approval.</p>",
            "<p>Mitigation: complete rollback rehearsal before release gate.</p>",
          ].join(""),
        },
      }),
    ].join("\n"),
  ]);
  const profile = new DefaultRoleProfileRegistry().resolve(activation.thread.roles[0]!);

  const result = await adapter.invoke({
    activation,
    profile,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue from the cancelled source-check attempt.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.match(result.content, /Release Captain/);
  assert.match(result.content, /runbook gap/);
  assert.match(result.content, /rollback rehearsal/);
  assert.match(result.content, /Cancellation context/);
  assert.match(result.content, /Unverified/);
  assert.match(result.content, /Residual risk/);
  assert.match(result.content, /Continuation/);
  assert.doesNotMatch(result.content, /"protocol"/);
  assert.doesNotMatch(result.content, /<p>/);
});

test("heuristic fallback lead synthesis prefers completed evidence over a later cancellation note", async () => {
  const adapter = new HeuristicModelAdapter();
  const activation = buildActivationWithToolResult([
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      status: "completed",
      result: "Continuation completed.",
      final_content: "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal.",
    }),
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      status: "cancelled",
      result: "earlier cancellation remained visible in the timeline",
    }),
  ]);
  const profile = new DefaultRoleProfileRegistry().resolve(activation.thread.roles[0]!);

  const result = await adapter.invoke({
    activation,
    profile,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Close out the continuation.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.match(result.content, /Release Captain/);
  assert.match(result.content, /runbook gap/);
  assert.match(result.content, /rollback rehearsal/);
  assert.doesNotMatch(result.content, /earlier cancellation remained visible/);
  assert.doesNotMatch(result.content, /Cancellation context/);
});

function buildActivationWithToolResult(
  content: string | string[] = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    result: "Verified resumed source evidence. Unverified freshness remains.",
  })
): RoleActivationInput {
  const contents = Array.isArray(content) ? content : [content];
  return {
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Test Team",
      leadRoleId: "role-lead",
      roles: [
        {
          roleId: "role-lead",
          name: "Lead",
          seat: "lead",
          runtime: "local",
          model: {
            provider: "anthropic",
            name: "claude-test",
          },
        },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "msg-root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 6,
      edges: [],
      shardGroups: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey: "role:role-lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 0,
      maxIterations: 3,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-1",
      flowId: "flow-1",
      sourceMessageId: "msg-root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-1",
      payload: {
        threadId: "thread-1",
        intent: {
          relayBrief: "Handle the task.",
          recentMessages: contents.map((item, index) => ({
            messageId: `tool-${index + 1}`,
            role: "tool",
            name: index === 0 && contents.length > 1 ? "sessions_spawn" : "sessions_send",
            content: item,
            createdAt: index + 1,
          })),
        },
      },
      createdAt: 1,
    },
  };
}

test("heuristic lead fallback labels partial sub-agent evidence as partial, not verified", async () => {
  const adapter = new HeuristicModelAdapter();
  const activation = buildActivationWithToolResult(
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: "task-1",
      session_key: "worker:explore:1",
      agent_id: "explore",
      status: "partial",
      tool_chain: ["explore"],
      result: "Run was cut off by the wall-clock budget.",
      final_content: "Source A verified the pricing page; source B not reached.",
      payload: { content: "Source A verified the pricing page; source B not reached." },
    })
  );
  const profile = new DefaultRoleProfileRegistry().resolve(activation.thread.roles[0]!);

  const result = await adapter.invoke({
    activation,
    profile,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Close out the delegated research.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.match(result.content, /Partially verified \(the delegated session returned a PARTIAL, resumable result/);
  assert.doesNotMatch(result.content, /\nVerified:/);
  assert.match(result.content, /continue the same session to finish the cut-off work/i);
});

test("heuristic lead fallback keeps completed sub-agent evidence as verified", async () => {
  const adapter = new HeuristicModelAdapter();
  const activation = buildActivationWithToolResult(
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: "task-1",
      session_key: "worker:explore:1",
      agent_id: "explore",
      status: "completed",
      tool_chain: ["explore"],
      result: "Completed.",
      final_content: "Source A verified the pricing page in full.",
      payload: { content: "Source A verified the pricing page in full." },
    })
  );
  const profile = new DefaultRoleProfileRegistry().resolve(activation.thread.roles[0]!);

  const result = await adapter.invoke({
    activation,
    profile,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Close out the delegated research.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.match(result.content, /Verified: /);
  assert.doesNotMatch(result.content, /Partially verified/);
});
