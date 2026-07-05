import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "./native-tool-messages";
import type { RolePromptPacket } from "./prompt-policy";
import { readPolicyApprovalWaitTimeoutRuntimeEvidence } from "./runtime-facts/text-fallback-readers";
import {
  allowsSupplementalBrowserProbe,
  buildApprovalWaitTimeoutLocalEvidenceCloseout,
  buildLocalEvidenceCloseout,
  parseJsonObject,
  throwIfAborted,
} from "./tool-loop-shared";

function packet(taskPrompt: string, outputContract = ""): RolePromptPacket {
  return {
    roleId: "role:test",
    roleName: "Test Role",
    seat: "member",
    systemPrompt: "You are testing.",
    taskPrompt,
    outputContract,
    suggestedMentions: [],
  } as RolePromptPacket;
}

test("readPolicyApprovalWaitTimeoutRuntimeEvidence keeps permission evidence only", () => {
  const toolTrace: NativeToolRoundTrace[] = [
    {
      round: 1,
      calls: [],
      results: [
        {
          toolCallId: "toolu-permission-query",
          toolName: "permission_query",
          content: JSON.stringify({
            approval_id: "approval-1",
            status: "pending",
          }),
          isError: false,
          contentBytes: 52,
        },
        {
          toolCallId: "toolu-session",
          toolName: "sessions_send",
          content: "ignored session evidence",
          isError: false,
          contentBytes: 24,
        },
      ],
    },
    {
      round: 2,
      calls: [],
      results: [
        {
          toolCallId: "toolu-permission-result",
          toolName: "permission_result",
          content: JSON.stringify({
            approval_id: "approval-1",
            status: "approval_wait_timeout",
          }),
          isError: false,
          contentBytes: 66,
        },
      ],
    },
  ];

  const evidence = readPolicyApprovalWaitTimeoutRuntimeEvidence(toolTrace);

  assert.match(evidence, /permission_query:/);
  assert.match(evidence, /permission_result:/);
  assert.doesNotMatch(evidence, /sessions_send|ignored session evidence/);
});

test("buildApprovalWaitTimeoutLocalEvidenceCloseout preserves model metadata and evidence", () => {
  const result = buildApprovalWaitTimeoutLocalEvidenceCloseout({
    selection: {
      modelId: "model-a",
      modelChainId: "chain-a",
    },
    evidenceText:
      "permission_query requested approval and permission_result returned pending.",
    error: new Error("final synthesis unavailable"),
  });

  assert.equal(result.modelId, "model-a");
  assert.equal(result.modelChainId, "chain-a");
  assert.equal(result.providerId, "local");
  assert.equal(result.adapterName, "local-evidence-closeout");
  assert.match(result.text, /Approval wait-timeout closeout confirmed/);
  assert.match(result.text, /pending/);
  assert.match(
    result.text,
    /permission_query requested approval and permission_result returned pending/,
  );
  assert.deepEqual(result.raw, {
    reason: "approval_wait_timeout_final_synthesis_unavailable",
    message: "final synthesis unavailable",
    evidence:
      "permission_query requested approval and permission_result returned pending.",
  });
});

test("buildLocalEvidenceCloseout builds a generic evidence fallback", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-fetch",
      name: "web_fetch",
      content: JSON.stringify({
        summary: "The source verifies the public release date.",
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet("Summarize the verified release fact."),
    selection: { modelId: "model-a" },
    error: new Error("model unavailable"),
  });

  assert.ok(result);
  assert.equal(result.modelId, "model-a");
  assert.equal(result.providerId, "local");
  assert.match(result.text, /Verified: Source 1/);
  assert.match(result.text, /public release date/);
  assert.deepEqual(result.raw, {
    reason: "final_synthesis_unavailable",
    message: "model unavailable",
  });
});

test("buildLocalEvidenceCloseout preserves requested table columns from generic evidence", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-fetch",
      name: "web_fetch",
      content: JSON.stringify({
        payload: {
          page: {
            title: "DeepSeek V4 Flash pricing",
            textExcerpt:
              "DeepSeek V4 Flash supports search/web_search. Input price $0.10 per 1M tokens. Output price $0.40 per 1M tokens.",
          },
          content: "https://provider.example/pricing",
        },
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\| provider \| 是否明确支持 DeepSeek V4 Flash \|/);
  assert.match(result.text, /provider\.example/);
  assert.match(result.text, /是（页面含模型与价格）/);
  assert.match(result.text, /\$0\.10\/1M/);
  assert.match(result.text, /\$0\.40\/1M/);
});

test("parseJsonObject parses objects only", () => {
  assert.deepEqual(parseJsonObject('{"status":"ok"}'), { status: "ok" });
  assert.equal(parseJsonObject("[]"), null);
  assert.equal(parseJsonObject("not json"), null);
  assert.equal(parseJsonObject(""), null);
});

test("throwIfAborted rethrows a stable AbortError", () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal));

  controller.abort("stop");
  assert.throws(
    () => throwIfAborted(controller.signal),
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

test("allowsSupplementalBrowserProbe respects unavailable browser capabilities", () => {
  assert.equal(
    allowsSupplementalBrowserProbe(packet("Inspect a rendered page.")),
    true,
  );
  assert.equal(
    allowsSupplementalBrowserProbe({
      ...packet("Inspect a rendered page."),
      capabilityInspection: {
        unavailableCapabilities: ["browser sessions unavailable"],
      },
    } as RolePromptPacket),
    false,
  );
});
