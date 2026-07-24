import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { captureContextWorkingSetFromMessages } from "./context-working-set";

test("working-set capture retains typed session, approval, artifact, image, file, and skill receipts", () => {
  const messages: LLMMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read-1",
          name: "read_file",
          input: {
            path: "/workspace/report.md",
            start_line: 10,
            end_line: 40,
            skill_id: "research",
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "session-1",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        session_key: "worker:explore:1",
        status: "timeout",
        resumable: true,
        evidence_available: true,
        artifact_ids: ["artifact-1"],
      }),
    },
    {
      role: "tool",
      toolCallId: "permission-1",
      name: "permission_query",
      content: JSON.stringify({
        approval_id: "approval-1",
        approval_state: "pending",
      }),
    },
    {
      role: "tool",
      toolCallId: "image-1",
      name: "browser_screenshot",
      content: JSON.stringify({
        artifact_id: "image-1",
        kind: "screenshot",
        mime_type: "image/png",
      }),
    },
    {
      role: "user",
      content: "Prior report: artifact://report-2",
    },
  ];

  const result = captureContextWorkingSetFromMessages(messages);

  assert.deepEqual(result.files, [
    {
      path: "/workspace/report.md",
      startLine: 10,
      endLine: 40,
    },
  ]);
  assert.deepEqual(result.skills, [{ skillId: "research" }]);
  assert.deepEqual(result.sessions, [
    {
      sessionKey: "worker:explore:1",
      status: "timeout",
      resumable: true,
      evidenceAvailable: true,
    },
  ]);
  assert.deepEqual(result.approvals, [
    { approvalId: "approval-1", state: "pending" },
  ]);
  assert.deepEqual(result.images, [{ artifactId: "image-1" }]);
  assert.deepEqual(
    result.artifacts.sort(),
    ["artifact-1", "artifact://report-2", "image-1"].sort(),
  );
});

test("working-set capture deduplicates by stable identity and keeps the newest state", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "one",
      name: "sessions_send",
      content: JSON.stringify({
        session_key: "worker:1",
        status: "timeout",
        resumable: true,
      }),
    },
    {
      role: "tool",
      toolCallId: "two",
      name: "sessions_send",
      content: JSON.stringify({
        session_key: "worker:1",
        status: "completed",
        resumable: false,
      }),
    },
  ];

  const result = captureContextWorkingSetFromMessages(messages);

  assert.deepEqual(result.sessions, [
    {
      sessionKey: "worker:1",
      status: "completed",
      resumable: false,
    },
  ]);
});

test("working-set capture parses provider-native tool_result content blocks", () => {
  const captured = captureContextWorkingSetFromMessages([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content: JSON.stringify({
            session_key: "worker:provider-native",
            status: "partial",
            resumable: true,
            artifact_id: "artifact:provider-native",
          }),
        },
      ],
    },
  ]);

  assert.deepEqual(captured.sessions, [
    {
      sessionKey: "worker:provider-native",
      status: "partial",
      resumable: true,
    },
  ]);
  assert.deepEqual(captured.artifacts, ["artifact:provider-native"]);
});

test("working-set capture applies strict per-kind limits", () => {
  const messages: LLMMessage[] = Array.from({ length: 5 }, (_, index) => ({
    role: "tool" as const,
    toolCallId: `call-${index}`,
    name: "sessions_spawn",
    content: JSON.stringify({
      session_key: `session-${index}`,
      artifact_id: `artifact-${index}`,
    }),
  }));

  const result = captureContextWorkingSetFromMessages(messages, {
    maxSessions: 2,
    maxArtifacts: 3,
  });

  assert.deepEqual(
    result.sessions.map((item) => item.sessionKey),
    ["session-3", "session-4"],
  );
  assert.deepEqual(result.artifacts, [
    "artifact-2",
    "artifact-3",
    "artifact-4",
  ]);
});

test("working-set capture treats zero limits as empty collections", () => {
  const result = captureContextWorkingSetFromMessages(
    [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "read-1",
          name: "read_file",
          input: {
            path: "/workspace/report.md",
            skill_id: "research",
          },
        }],
      },
      {
        role: "tool",
        toolCallId: "tool-1",
        name: "sessions_spawn",
        content: JSON.stringify({
          session_key: "session-1",
          approval_id: "approval-1",
          artifact_id: "image-1",
          kind: "screenshot",
          mime_type: "image/png",
        }),
      },
    ],
    {
      maxFiles: 0,
      maxSkills: 0,
      maxArtifacts: 0,
      maxSessions: 0,
      maxApprovals: 0,
      maxImages: 0,
    },
  );

  assert.deepEqual(result, {
    files: [],
    skills: [],
    artifacts: [],
    sessions: [],
    approvals: [],
    images: [],
  });
});
