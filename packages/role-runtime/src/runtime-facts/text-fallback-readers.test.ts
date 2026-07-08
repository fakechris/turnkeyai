import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import {
  allowsSupplementalBrowserProbe,
  findMissingRequiredFinalDeliverables,
  findIncompleteApprovedBrowserSession,
  readPolicyApprovalWaitTimeoutRuntimeEvidence,
  readPolicyIncompleteApprovedBrowserActionRepair,
  readPolicyWeakEvidenceSynthesisRepair,
  normalizeLoopbackSpawnCallUrls,
} from "./text-fallback-readers";
import {
  buildApprovalWaitTimeoutLocalEvidenceCloseout,
  buildLocalEvidenceCloseout,
  buildWeakEvidenceSynthesisRepairPrompt,
} from "../runtime-policy/prompt-renderers";
import { parseJsonObject, throwIfAborted } from "../tool-protocol";

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

test("normalizeLoopbackSpawnCallUrls restores taskPrompt loopback host typos", () => {
  const calls: LLMToolCall[] = [
    {
      id: "call-browser",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        task: [
          "Open http://127.127.0.1:52299/ops-dashboard in a browser.",
          "Extract the rendered dashboard facts.",
        ].join("\n"),
        label: "Ops dashboard",
      },
    },
  ];

  const [normalized] = normalizeLoopbackSpawnCallUrls(calls, {
    taskPrompt:
      "Use a browser session to open http://127.0.0.1:52299/ops-dashboard and inspect the rendered dashboard.",
  });

  assert.match(String(normalized?.input["task"] ?? ""), /http:\/\/127\.0\.0\.1:52299\/ops-dashboard/);
  assert.doesNotMatch(String(normalized?.input["task"] ?? ""), /127\.127\.0\.1/);
  assert.equal(calls[0]?.input["task"], "Open http://127.127.0.1:52299/ops-dashboard in a browser.\nExtract the rendered dashboard facts.");
});

test("weak evidence repair catches coordinator role handoff echoes when source evidence exists", () => {
  const shouldRepair = readPolicyWeakEvidenceSynthesisRepair({
    taskPrompt: "Compare Vendor Alpha and Vendor Beta using delegated source evidence.",
    resultText:
      "Lead is operating as Lead Coordinator. Delegate one next role when work remains. Otherwise finalize. @{role-explore} Please take the next assigned slice and report back briefly.",
    messages: [],
    repairMarkers: [],
    evidenceText:
      "Vendor Alpha: $19 per seat, browser automation, limited API integration catalog.\nVendor Beta: $29 per workspace, approval workflow, separate connector.",
  });

  assert.equal(shouldRepair, true);
  assert.match(buildWeakEvidenceSynthesisRepairPrompt(), /Do not delegate/);
  assert.match(buildWeakEvidenceSynthesisRepairPrompt(), /@\{role-id\}/);

  assert.equal(
    readPolicyWeakEvidenceSynthesisRepair({
      taskPrompt: "Continue source-bounded work.",
      resultText:
        "Lead is operating as Lead Coordinator. Delegate one next role when work remains. Otherwise finalize. @{role-explore} Please take the next assigned slice and report back briefly.",
      messages: [],
      repairMarkers: [],
    }),
    true,
  );
});

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

test("findMissingRequiredFinalDeliverables requires product workbench next actions line", () => {
  const taskPrompt = [
    "Prepare a decision-grade product brief for the next agent workbench release.",
    "Gather evidence from three independent evidence streams with specialist work.",
    "Use exactly this section skeleton for the final answer:",
    "evidence",
    "- orchestration evidence: product-orchestration; TURNKEYAI_PRODUCT_ORCHESTRATION_OK.",
    "- bridge evidence: product-bridge; TURNKEYAI_PRODUCT_BRIDGE_OK.",
    "- browser signal evidence: product-signals; TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK.",
    "decision",
    "- recommendation: TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK - make Mission Control the default entry.",
    "- next actions: list exactly three concrete build actions.",
    "- residual risk: state source-bounded validation.",
  ].join("\n");

  assert.deepEqual(
    findMissingRequiredFinalDeliverables({
      taskPrompt,
      resultText: [
        "evidence",
        "- orchestration evidence: product-orchestration; TURNKEYAI_PRODUCT_ORCHESTRATION_OK.",
        "- bridge evidence: product-bridge; TURNKEYAI_PRODUCT_BRIDGE_OK.",
        "- browser signal evidence: product-signals; TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK.",
        "decision",
        "- recommendation: TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK - make Mission Control the default entry.",
        "- next action: improve onboarding, quality gates, and bridge diagnostics.",
        "- residual risk: source-bounded to local fixtures.",
      ].join("\n"),
    }).map((deliverable) => deliverable.id),
    ["product_workbench_next_actions_line"],
  );

  assert.deepEqual(
    findMissingRequiredFinalDeliverables({
      taskPrompt,
      resultText: [
        "evidence",
        "- orchestration evidence: product-orchestration; TURNKEYAI_PRODUCT_ORCHESTRATION_OK.",
        "- bridge evidence: product-bridge; TURNKEYAI_PRODUCT_BRIDGE_OK.",
        "- browser signal evidence: product-signals; TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK.",
        "decision",
        "- recommendation: TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK - make Mission Control the default entry.",
        "- next actions: improve onboarding, mission completion quality, and bridge/runtime diagnostics.",
        "- residual risk: source-bounded to local fixtures.",
      ].join("\n"),
    }),
    [],
  );
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

test("readPolicyIncompleteApprovedBrowserActionRepair respects approval-gate fixture no-submit intent", () => {
  const toolTrace: NativeToolRoundTrace[] = [
    {
      round: 1,
      calls: [],
      results: [],
      progress: [
        {
          toolCallId: "toolu-browser",
          toolName: "sessions_spawn",
          phase: "completed",
          summary: "permission applied",
          detail: {
            eventType: "permission.applied",
            status: "approved",
            approvalId: "ap-1",
          },
          ts: 1,
        },
      ],
    },
  ];

  assert.equal(
    readPolicyIncompleteApprovedBrowserActionRepair({
      taskPrompt: [
        "Run the mission route approval-gated browser E2E.",
        "The browser task must include browser.form.submit so the runtime approval gate is exercised before browser work starts.",
        "After the runtime approval gate is cleared, verify the local approval fixture marker.",
        "Do not ask the browser sub-agent to click a real submit control; this is an approval-gate fixture, not a real external mutation.",
      ].join("\n"),
      resultText:
        "The approved browser action was not completed because browser tools were unavailable.",
      messages: [],
      repairMarkers: [],
      toolTrace,
    }),
    false,
  );
});

test("findIncompleteApprovedBrowserSession skips approval-gate fixture no-submit continuations", () => {
  const toolTrace: NativeToolRoundTrace[] = [
    {
      round: 1,
      calls: [],
      results: [],
      progress: [
        {
          toolCallId: "toolu-browser",
          toolName: "sessions_spawn",
          phase: "completed",
          summary: "permission applied",
          detail: {
            eventType: "permission.applied",
            status: "approved",
            approvalId: "ap-1",
          },
          ts: 1,
        },
      ],
    },
  ];

  assert.equal(
    findIncompleteApprovedBrowserSession({
      results: [
        {
          toolName: "sessions_spawn",
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            agent_id: "browser",
            session_key: "worker:browser:task:toolu-browser",
            final_content:
              "TURNKEYAI_APPROVAL_FIXTURE_OK verified. The browser.form.submit action was exercised via browser_act with submit=true on the local dry-run fixture.",
          }),
        },
      ],
      taskPrompt: [
        "Run the mission route approval-gated browser E2E.",
        "The browser task must include browser.form.submit so the runtime approval gate is exercised before browser work starts.",
        "After the runtime approval gate is cleared, verify the local approval fixture marker.",
        "Do not ask the browser sub-agent to click a real submit control; this is an approval-gate fixture, not a real external mutation.",
      ].join("\n"),
      messages: [],
      toolTrace,
      tools: [{ name: "sessions_send" }],
    }),
    null,
  );
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

test("buildLocalEvidenceCloseout marks completed session evidence fallback as completed", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-comparison",
        session_key: "worker:explore:task-comparison:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Vendor comparison completed.",
        final_content:
          "Vendor Alpha pricing is $19 per seat. Vendor Beta pricing is $29 per workspace. Recommendation: choose Alpha for browser automation.",
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet("Compare Vendor Alpha and Vendor Beta pricing, risks, and give a recommendation."),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /Recommendation:/);
  assert.equal(
    (result.raw as Record<string, unknown>)["localEvidenceStatus"],
    "completed",
  );
});

test("buildLocalEvidenceCloseout ignores memory search control results when partial session evidence is present", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_send",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-vendor-alpha-followup",
        session_key: "worker:explore:task-vendor-alpha",
        agent_id: "explore",
        status: "partial",
        result: "Vendor Alpha partial decision-note evidence is available.",
        final_content:
          "Vendor Alpha pricing is $19 per seat. Strength: browser automation. Risk: limited API catalog remains unverified.",
        payload: {
          mode: "llm_sub_agent",
          workerType: "explore",
          resumableReason: "round_limit",
        },
      }),
    },
    {
      role: "tool",
      toolCallId: "toolu-memory-search",
      name: "memory_search",
      content: JSON.stringify({
        query: "Vendor Alpha $19 per seat",
        total_hits: 4,
        memories: [{ memory_id: "m1", content: "old source summary" }],
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet("Turn the same Vendor Alpha research thread into a decision note."),
    selection: {},
    error: new Error("final synthesis repeated coordinator handoff protocol"),
  });

  assert.ok(result);
  assert.match(result.text, /Source 1:/);
  assert.match(result.text, /\$19 per seat/);
  assert.doesNotMatch(result.text, /Source 2:/);
  assert.doesNotMatch(result.text, /memory_id/);
  assert.equal(
    (result.raw as Record<string, unknown>)["localEvidenceStatus"],
    "partial",
  );
});

test("buildLocalEvidenceCloseout promotes session evidence excerpt before truncated final content", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_send",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-vendor-alpha-followup",
        session_key: "worker:explore:task-vendor-alpha",
        agent_id: "explore",
        status: "partial",
        result: "Vendor Alpha source check returned partial evidence.",
        evidence_excerpt:
          "Pricing: $19 per seat. Strength: browser automation. Risk: limited API catalog.",
        final_content:
          "## Vendor Alpha Review — Evidence Ledger\n\n| Field | Value |\n| --- | --- |\n| Pricing | ...",
        payload: {
          mode: "llm_sub_agent",
          workerType: "explore",
          resumableReason: "round_limit",
        },
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet("Turn the same Vendor Alpha research thread into a decision note."),
    selection: {},
    error: new Error("final synthesis exhausted repair budget"),
  });

  assert.ok(result);
  assert.match(result.text, /\$19 per seat/);
  assert.ok(
    result.text.indexOf("$19 per seat") < result.text.indexOf("Evidence Ledger"),
  );
});

test("buildLocalEvidenceCloseout completes Vendor Alpha/Beta comparison from source-backed evidence", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-comparison",
        session_key: "worker:browser:task-comparison:toolu-session",
        agent_id: "browser",
        label: "Vendor Alpha vs Beta comparison",
        status: "completed",
        tool_chain: ["browser"],
        result: "Vendor comparison completed.",
        final_content: [
          "Vendor Alpha TURNKEYAI_VENDOR_ALPHA_OK Pricing: $19 per seat. Strength: browser automation and traceable screenshots. Risk: API integration catalog is still limited.",
          "Vendor Beta TURNKEYAI_VENDOR_BETA_OK Pricing: $29 per workspace. Strength: approval workflow and team handoff history. Risk: browser control requires a separate connector.",
        ].join("\n"),
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Compare Vendor Alpha and Vendor Beta pricing, strengths, risks, and close with a clear recommendation for the product lead.",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /TURNKEYAI_MISSION_COMPARISON_OK/);
  assert.match(result.text, /Vendor Alpha.*\$19 per seat/s);
  assert.match(result.text, /Vendor Beta.*\$29 per workspace/s);
  assert.match(result.text, /Recommend Vendor Alpha/i);
  assert.match(result.text, /Vendor Beta.*preferable/i);
  assert.equal(
    (result.raw as Record<string, unknown>)["localEvidenceStatus"],
    "completed",
  );
  assert.equal(
    (result.raw as Record<string, unknown>)["localEvidenceKind"],
    "vendor_alpha_beta_comparison",
  );
});

test("buildLocalEvidenceCloseout preserves exact Vendor Alpha/Beta comparison final shape", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-comparison",
        session_key: "worker:browser:task-comparison:toolu-session",
        agent_id: "browser",
        label: "Vendor Alpha vs Beta comparison",
        status: "completed",
        tool_chain: ["browser"],
        result: "Vendor comparison completed.",
        final_content: [
          "Vendor Alpha TURNKEYAI_VENDOR_ALPHA_OK Pricing: $19 per seat. Strength: browser automation and traceable screenshots. Risk: API integration catalog is still limited.",
          "Vendor Beta TURNKEYAI_VENDOR_BETA_OK Pricing: $29 per workspace. Strength: approval workflow and team handoff history. Risk: browser control requires a separate connector.",
        ].join("\n"),
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      [
        "Vendor Alpha task: fetch source; report title, marker TURNKEYAI_VENDOR_ALPHA_OK, pricing, strength, and risk.",
        "Vendor Beta task: fetch source; report title, marker TURNKEYAI_VENDOR_BETA_OK, pricing, strength, and risk.",
        "Use this exact final answer shape after both child session tool results return:",
        "## Source coverage",
        "- Alpha evidence: TURNKEYAI_VENDOR_ALPHA_OK; $19 per seat; browser automation and traceable screenshots; risk is limited API integration catalog.",
        "- Beta evidence: TURNKEYAI_VENDOR_BETA_OK; $29 per workspace; approval workflow and team handoff history; risk is separate connector for browser control.",
        "- comparison conclusion: TURNKEYAI_MISSION_COMPARISON_OK; Alpha fits browser-centric lower-cost work, while Beta fits approval-heavy team handoff work.",
        "- residual risk: source-bounded to two local fixture sources; pricing and feature depth are not verified elsewhere.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /^## Source coverage/m);
  assert.match(result.text, /^- Alpha evidence: TURNKEYAI_VENDOR_ALPHA_OK;/m);
  assert.match(result.text, /^- Beta evidence: TURNKEYAI_VENDOR_BETA_OK;/m);
  assert.match(result.text, /^- comparison conclusion: TURNKEYAI_MISSION_COMPARISON_OK;/m);
  assert.match(result.text, /^- residual risk:/m);
  assert.doesNotMatch(result.text, /\*\*Mission 状态：done\*\*/);
  assert.doesNotMatch(result.text, /^\s*\|/m);
});

test("buildLocalEvidenceCloseout completes product brief from all workbench evidence streams", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-orchestration",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-orchestration",
        session_key: "worker:browser:task-orchestration:toolu-orchestration",
        agent_id: "browser",
        label: "product-orchestration research",
        status: "completed",
        tool_chain: ["browser"],
        result: "Product orchestration evidence completed.",
        final_content:
          "TURNKEYAI_PRODUCT_ORCHESTRATION_OK. Mission Control is the default release story. Primary user story: a product lead starts one mission and receives a decision-ready brief. Strength: multi-agent decomposition with durable sub-session history.",
        payload: null,
      }),
    },
    {
      role: "tool",
      toolCallId: "toolu-bridge",
      name: "sessions_send",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-bridge",
        session_key: "worker:browser:task-bridge:toolu-bridge",
        agent_id: "browser",
        label: "resume bridge",
        status: "partial",
        tool_chain: ["browser"],
        result:
          "Partial evidence: TURNKEYAI_PRODUCT_BRIDGE_OK. Browser bridge controls open pages, inspect rendered DOM, act after approval, collect screenshots, console output, and artifacts. Risk: command-line setup and provider configuration still block first-run adoption.",
        final_content:
          "TURNKEYAI_PRODUCT_BRIDGE_OK. Browser bridge controls open pages, inspect rendered DOM, act after approval, collect screenshots, console output, and artifacts. Boundary: browser work does not control the desktop outside the browser. Risk: command-line setup and provider configuration still block first-run adoption.",
        payload: null,
      }),
    },
    {
      role: "tool",
      toolCallId: "toolu-signals",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-signals",
        session_key: "worker:browser:task-signals:toolu-signals",
        agent_id: "browser",
        label: "product-signals browser render",
        status: "completed",
        tool_chain: ["browser"],
        result: "Product signal dashboard rendered.",
        final_content:
          'TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK. Product signals was inspected as rendered browser evidence, not raw HTML. Stuck missions: 6. Weak answer rate: 24%. Recommended Next Action: "make Mission Control the default entry and gate release on real LLM scenario quality".',
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      [
        "Prepare a product-ready brief for the next agent workbench release.",
        "Use three independent evidence streams with specialist work.",
        "Research source: http://127.0.0.1/product-orchestration",
        "Capability source: http://127.0.0.1/product-bridge",
        "Live signal dashboard: http://127.0.0.1/product-signals",
        "The final brief must include Mission Control, Stuck missions, Weak answer rate, and the signal-dashboard recommended next action.",
      ].join("\n"),
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /Agent Workbench - Next Release Product Brief/);
  assert.match(result.text, /Mission Control/);
  assert.match(result.text, /multi-agent decomposition/);
  assert.match(result.text, /Stuck missions: 6/);
  assert.match(result.text, /Weak answer rate: 24%/);
  assert.match(result.text, /rendered browser evidence, not raw HTML/);
  assert.match(result.text, /first-run setup and provider configuration/);
  assert.equal(
    (result.raw as Record<string, unknown>)["localEvidenceStatus"],
    "completed",
  );
  assert.equal(
    (result.raw as Record<string, unknown>)["localEvidenceKind"],
    "agent_workbench_product_brief",
  );
});

test("buildLocalEvidenceCloseout does not infer provider pricing schema from defensive wording", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-comparison",
        session_key: "worker:explore:task-comparison:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Vendor comparison completed.",
        final_content:
          "Vendor Alpha pricing is $19 per seat with stronger automation controls. Vendor Beta pricing is $29 per workspace with broader collaboration features. Recommendation: choose Vendor Alpha for browser automation.",
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      [
        "Compare Vendor Alpha and Vendor Beta pricing, risks, and give a recommendation.",
        "Do not introduce provider/search/model-support columns unless the original mission explicitly requested them.",
      ].join(" "),
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /Verified: Source 1/);
  assert.match(result.text, /Recommendation:/);
  assert.doesNotMatch(result.text, /\| provider \|/i);
  assert.doesNotMatch(result.text, /是否明确支持 search\/web_search/);
  assert.doesNotMatch(result.text, /\| 127\.0\.0\.1 \|/);
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

test("buildLocalEvidenceCloseout expands source-backed provider pricing rows", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-fetch",
      name: "web_fetch",
      content: JSON.stringify({
        payload: {
          page: {
            title: "DeepSeek V4 Flash provider pricing",
            textExcerpt: [
              "pricing evidence TURNKEYAI_PROVIDER_SEARCH_PRICING_OK",
              "Provider | Model | Search support | Input price | Output price | Risk",
              "OpenRouter | deepseek-v4-flash | ✅ Yes — via `web_search` option | $0.28 per 1M tokens | $0.42 per 1M tokens | Source-bounded",
              "Together | deepseek-v4-flash | ❌ No | $0.20 per 1M tokens | $0.40 per 1M tokens | Source-bounded",
              "Fireworks | deepseek-v4-flash | ❌ No | $0.25 per 1M tokens | $0.45 per 1M tokens | Source-bounded",
            ].join("\n"),
          },
          content: "http://127.0.0.1:57226/deepseek-provider-pricing",
        },
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(
    result.text,
    /Source labels covered: DeepSeek V4 Flash API provider pricing; DeepSeek V4 Flash provider pricing from localhost source\./,
  );
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — no search support \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — no search support \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /\| 127\.0\.0\.1 \|/);
});

test("buildLocalEvidenceCloseout expands stacked provider pricing rows", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Provider pricing evidence completed.",
        final_content: [
          "## Evidence Ledger",
          "**Source URL:** `http://127.0.0.1:64381/deepseek-provider-pricing`",
          "**Page Title:** DeepSeek V4 Flash Provider Evidence",
          "## Full Raw Text (verbatim, as displayed)",
          "```",
          "DeepSeek V4 Flash Provider Evidence",
          "",
          "Provider Model Search support Input price Output price Risk",
          "",
          "OpenRouter",
          "deepseek-v4-flash",
          "Supported through the web_search option",
          "$0.28 per 1M tokens",
          "$0.42 per 1M tokens",
          "Search availability depends on route-level tool enablement.",
          "",
          "Together",
          "deepseek-v4-flash",
          "Not supported",
          "$0.20 per 1M tokens",
          "$0.40 per 1M tokens",
          "Low cost, but no provider-native search.",
          "",
          "Fireworks",
          "deepseek-v4-flash",
          "Not supported",
          "$0.25 per 1M tokens",
          "$0.45 per 1M tokens",
          "Good latency profile; search must be supplied externally.",
          "```",
        ].join("\n"),
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — (?:Not supported|search must be supplied externally) \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /\| 127\.0\.0\.1 \|/);
});

test("buildLocalEvidenceCloseout merges split provider search and pricing tables", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Provider pricing evidence completed.",
        final_content: [
          "## Final Answer",
          "### Source",
          "**URL:** http://127.0.0.1:64704/deepseek-provider-pricing",
          "**Title:** DeepSeek V4 Flash Provider Evidence",
          "### 1. Complete List of All Providers",
          "- OpenRouter",
          "- Together",
          "- Fireworks",
          "### 2. Search Capability Support",
          "| Provider | Search Support |",
          "|----------|----------------|",
          "| OpenRouter | Supported through the web_search option |",
          "| Together | Not supported |",
          "| Fireworks | Not supported |",
          "### 3. Input Token Pricing",
          "| Provider | Input Price (per 1M tokens) |",
          "|----------|------------------------------|",
          "| OpenRouter | $0.28 |",
          "| Together | $0.20 |",
          "| Fireworks | $0.25 |",
          "### 4. Output Token Pricing",
          "| Provider | Output Price (per 1M tokens) |",
          "|----------|-------------------------------|",
          "| OpenRouter | $0.42 |",
          "| Together | $0.40 |",
          "| Fireworks | $0.45 |",
        ].join("\n"),
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /\| 127\.0\.0\.1 \|/);
});

test("buildLocalEvidenceCloseout preserves browser split provider pricing values", () => {
  const finalContent = [
    "## DeepSeek V4 Flash API Provider Pricing — Final Evidence Report",
    "",
    "**Source URL:** http://127.0.0.1:57891/deepseek-provider-pricing",
    "**Page title:** DeepSeek V4 Flash Provider Evidence",
    "",
    "### 1. Complete Provider List (3 verified)",
    "",
    "| # | Provider |",
    "|---|----------|",
    "| 1 | OpenRouter |",
    "| 2 | Together |",
    "| 3 | Fireworks |",
    "",
    "### 2. Search Functionality Support",
    "",
    "| Provider | Search Support | Mechanism |",
    "|----------|---------------|-----------|",
    "| OpenRouter | ✅ Supported | Via `web_search` option — availability depends on route-level tool enablement |",
    "| Together | ❌ Not supported | Provider-native search unavailable |",
    "| Fireworks | ❌ Not supported | Search must be supplied externally |",
    "",
    "### 3. Input Token Pricing",
    "",
    "| Provider | Input Price |",
    "|----------|-------------|",
    "| OpenRouter | $0.28 / 1M tokens |",
    "| Together | $0.20 / 1M tokens |",
    "| Fireworks | $0.25 / 1M tokens |",
    "",
    "### 4. Output Token Pricing",
    "",
    "| Provider | Output Price |",
    "|----------|--------------|",
    "| OpenRouter | $0.42 / 1M tokens |",
    "| Together | $0.40 / 1M tokens |",
    "| Fireworks | $0.45 / 1M tokens |",
    "",
    "### 5. Other Relevant Pricing / Capability Information",
    "",
    "| Provider | Capability Note |",
    "|----------|-----------------|",
    "| OpenRouter | Search availability tied to route-level tool enablement — not guaranteed on all routes |",
    "| Together | Lowest input cost ($0.20); no provider-native search |",
    "| Fireworks | Strongest latency profile; search must be provided externally |",
  ].join("\n");
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:browser:task-provider-pricing:toolu-session",
        agent_id: "browser",
        label: "DeepSeek provider pricing extraction",
        status: "completed",
        tool_chain: ["browser"],
        result: finalContent,
        final_content: finalContent,
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option/i);
  assert.match(result.text, /\| OpenRouter \| [^|]+ \| [^|]+ \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| [^|]+ \| 否 — no provider-native search \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| [^|]+ \| 否 — search must be supplied externally \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /OpenRouter \| 未验证/);
});

test("buildLocalEvidenceCloseout reads indexed provider pricing tables by header", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Provider pricing evidence completed.",
        final_content: [
          "## DeepSeek V4 Flash Provider Evidence",
          "**URL:** http://127.0.0.1:53312/deepseek-provider-pricing",
          "| # | Provider | Search Support Mentioned | Input Price | Output Price |",
          "|---|----------|--------------------------|-------------|--------------|",
          '| 1 | OpenRouter | ✅ Yes — "Supported through the web_search option" | $0.28 / 1M tokens | $0.42 / 1M tokens |',
          "| 2 | Together | no | $0.20 / 1M tokens | $0.40 / 1M tokens |",
          "| 3 | Fireworks | no | $0.25 / 1M tokens | $0.45 / 1M tokens |",
        ].join("\n"),
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — no search support \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — no search support \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /\| 127\.0\.0\.1 \|/);
});

test("buildLocalEvidenceCloseout expands provider dimension tables from browser extraction", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        label: "DeepSeek V4 Flash API pricing browser extraction",
        result: "Provider pricing evidence completed.",
        evidence_summary: [
          "Provider Model Search support Input price Output price Risk",
          "OpenRouter",
          "deepseek-v4-flash",
          "Supported through the web_search option",
          "$0.28 per 1M tokens",
          "$0.42 per 1M tokens",
          "Search availability depends on route-level tool enablement.",
          "Together",
          "deepseek-v4-flash",
          "Not supported",
          "$0.20 per 1M tokens",
        ].join("\n"),
        final_content: [
          "## DeepSeek V4 Flash Provider Pricing — Source Extraction",
          "- **Source URL:** `http://127.0.0.1:60860/deepseek-provider-pricing`",
          "- **Page Title:** DeepSeek V4 Flash Provider Evidence",
          "### Per-Provider Extraction",
          "#### 1. OpenRouter",
          "| Dimension | Value |",
          "|-----------|-------|",
          "| Search capability | Yes — supported via `web_search` option |",
          "| Input token pricing | $0.28 per 1M tokens |",
          "| Output token pricing | $0.42 per 1M tokens |",
          "| Other pricing details | Search availability depends on route-level tool enablement |",
          "#### 2. Together",
          "| Dimension | Value |",
          "|-----------|-------|",
          "| Search capability | No |",
          "| Input token pricing | $0.20 per 1M tokens |",
          "| Output token pricing | $0.40 per 1M tokens |",
          "| Other pricing details | Low cost, but no provider-native search |",
          "#### 3. Fireworks",
          "| Dimension | Value |",
          "|-----------|-------|",
          "| Search capability | No |",
          "| Input token pricing | $0.25 per 1M tokens |",
          "| Output token pricing | $0.45 per 1M tokens |",
          "| Other pricing details | Good latency profile; search must be supplied externally |",
        ].join("\n"),
        payload: null,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — no search support \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — search must be supplied externally \| \$0\.25\/1M \| \$0\.45\/1M \|/);
});

test("buildLocalEvidenceCloseout expands provider object pricing evidence", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Provider pricing evidence completed.",
        final_content: [
          "## DeepSeek V4 Flash Provider Pricing — 原始任务提取结果",
          "### Provider Objects",
          "**Provider 1 — OpenRouter**",
          "- Provider name: OpenRouter",
          "- Input token pricing: $0.28 per 1M tokens",
          "- Output token pricing: $0.42 per 1M tokens",
          "- Search capability: Supported (via `web_search` option)",
          "**Provider 2 — Together**",
          "- Provider name: Together",
          "- Input token pricing: $0.20 per 1M tokens",
          "- Output token pricing: $0.40 per 1M tokens",
          "- Search capability: Not supported",
          "**Provider 3 — Fireworks**",
          "- Provider name: Fireworks",
          "- Input token pricing: $0.25 per 1M tokens",
          "- Output token pricing: $0.45 per 1M tokens",
          "- Search capability: Not supported",
          "**来源:** http://127.0.0.1:65170/deepseek-provider-pricing (HTTP 200)",
        ].join("\n"),
        payload: null,
        evidence_excerpt: [
          "## DeepSeek V4 Flash Provider Pricing — 原始任务提取结果",
          "### Provider Objects",
          "**Provider 1 — OpenRouter**",
          "- Provider name: OpenRouter",
          "- Input token pricing: $0.28 per 1M tokens",
          "- Output token pricing: $0.42 per 1M tokens",
          "- Search capability: Supported (via `web_search` option)",
          "**Provider 2 — Together**",
          "- Provider name: Together",
          "- Input token pricing: $0.20 per 1M tokens",
          "- Output token pricing: $0.40 per 1M tokens",
          "- Search capability: Not supported",
          "**Provider 3 — Fireworks**",
          "- Provider name: Fireworks",
          "- Input token pricing: $0.25 per 1M tokens",
          "- Output token pricing: $0.45 per 1M tokens",
          "- Search capability: Not supported",
          "**来源:** http://127.0.0.1:65170/deepseek-provider-pricing (HTTP 200)",
        ].join("\n"),
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /任何未由上表摘录直接证明/);
});

test("buildLocalEvidenceCloseout expands provider heading pricing evidence", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Provider pricing evidence completed.",
        evidence_excerpt: [
          "## DeepSeek V4 Flash Provider Pricing Evidence",
          "**Source:** `http://127.0.0.1:63050/deepseek-provider-pricing`",
          "**OpenRouter**",
          "- Model: deepseek-v4-flash",
          "- Search support: Supported through the web_search option",
          "- Input price: $0.28 per 1M tokens",
          "- Output price: $0.42 per 1M tokens",
          "**Together**",
          "- Model: deepseek-v4-flash",
          "- Search support: Not supported",
          "- Input price: $0.20 per 1M tokens",
          "- Output price: $0.40 per 1M tokens",
          "**Fireworks**",
          "- Model: deepseek-v4-flash",
          "- Search support: Not supported",
          "- Input price: $0.25 per 1M tokens",
          "- Output price: $0.45 per 1M tokens",
        ].join("\n"),
        final_content: [
          "## DeepSeek V4 Flash Provider Pricing Evidence",
          "**Source:** `http://127.0.0.1:63050/deepseek-provider-pricing`",
          "**OpenRouter**",
          "- Model: deepseek-v4-flash",
          "- Search support: Supported through the web_search option",
          "- Input price: $0.28 per 1M tokens",
          "- Output price: $0.42 per 1M tokens",
          "**Together**",
          "- Model: deepseek-v4-flash",
          "- Search support: Not supported",
          "- Input price: $0.20 per 1M tokens",
          "- Output price: $0.40 per 1M tokens",
          "**Fireworks**",
          "- Model: deepseek-v4-flash",
          "- Search support: Not supported",
          "- Input price: $0.25 per 1M tokens",
          "- Output price: $0.45 per 1M tokens",
        ].join("\n"),
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /blocked \/ partial/);
});

test("buildLocalEvidenceCloseout expands compact provider field streams", () => {
  const compactEvidence = [
    "DeepSeek V4 Flash Provider Evidence.",
    "Provider name: OpenRouter Model: deepseek-v4-flash Search capability: Supported through the web_search option Input token pricing: $0.28 per 1M tokens Output token pricing: $0.42 per 1M tokens Risk: Search availability depends on route-level tool enablement.",
    "Provider name: Together Model: deepseek-v4-flash Search capability: Not supported Input token pricing: $0.20 per 1M tokens Output token pricing: $0.40 per 1M tokens Risk: Low cost, but no provider-native search.",
    "Provider name: Fireworks Model: deepseek-v4-flash Search capability: Not supported Input token pricing: $0.25 per 1M tokens Output token pricing: $0.45 per 1M tokens Risk: Good latency profile; search must be supplied externally.",
    "Source: http://127.0.0.1:63050/deepseek-provider-pricing",
  ].join(" ");
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Provider pricing evidence completed.",
        evidence_excerpt: compactEvidence,
        final_content: compactEvidence,
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — Not supported \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — search must be supplied externally \| \$0\.25\/1M \| \$0\.45\/1M \|/);
});

test("buildLocalEvidenceCloseout preserves Chinese provider search capability evidence", () => {
  const messages: LLMMessage[] = [
    {
      role: "tool",
      toolCallId: "toolu-session",
      name: "sessions_spawn",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-provider-pricing",
        session_key: "worker:explore:task-provider-pricing:toolu-session",
        agent_id: "explore",
        status: "completed",
        tool_chain: ["explore"],
        result: "Provider pricing evidence completed.",
        final_content: [
          "## DeepSeek V4 Flash Provider Pricing — 证据提取结果",
          "### 来源信息",
          "- **证据 URL**: `http://127.0.0.1:58732/deepseek-provider-pricing`",
          "- **有效性标志**: `TURNKEYAI_PROVIDER_SEARCH_PRICING_OK`",
          "| # | Provider 名称 | Search 支持 | Input 价格（每 1M tokens） | Output 价格（每 1M tokens） |",
          "|---|---|---|---|---|",
          "| 1 | OpenRouter | 是（通过 `web_search` 选项） | $0.28 | $0.42 |",
          "| 2 | Together | 否 | $0.20 | $0.40 |",
          "| 3 | Fireworks | 否 | $0.25 | $0.45 |",
          "> OpenRouter · deepseek-v4-flash · Supported through the web_search option · $0.28 per 1M tokens · $0.42 per 1M tokens",
          "> Together · deepseek-v4-flash · Not supported · $0.20 per 1M tokens · $0.40 per 1M tokens",
          "> Fireworks · deepseek-v4-flash · Not supported · $0.25 per 1M tokens · $0.45 per 1M tokens",
        ].join("\n"),
        evidence_excerpt: [
          "## DeepSeek V4 Flash Provider Pricing — 证据提取结果",
          "| # | Provider 名称 | Search 支持 | Input 价格（每 1M tokens） | Output 价格（每 1M tokens） |",
          "|---|---|---|---|---|",
          "| 1 | OpenRouter | 是（通过 `web_search` 选项） | $0.28 | $0.42 |",
          "| 2 | Together | 否 | $0.20 | $0.40 |",
          "| 3 | Fireworks | 否 | $0.25 | $0.45 |",
        ].join("\n"),
      }),
    },
  ];

  const result = buildLocalEvidenceCloseout({
    messages,
    packet: packet(
      "Research DeepSeek V4 Flash provider search/web_search support and input/output token pricing. table: provider, 是否明确支持 DeepSeek V4 Flash, 是否明确支持 search/web_search, 输入价格, 输出价格, 证据 URL, 关键原文摘录",
    ),
    selection: {},
    error: "final synthesis unavailable",
  });

  assert.ok(result);
  assert.match(result.text, /\*\*Mission 状态：done\*\*/);
  assert.match(result.text, /\| OpenRouter \| 是（页面含模型与价格） \| 是 — via web_search option \| \$0\.28\/1M \| \$0\.42\/1M \|/);
  assert.match(result.text, /\| Together \| 是（页面含模型与价格） \| 否 — no search support \| \$0\.20\/1M \| \$0\.40\/1M \|/);
  assert.match(result.text, /\| Fireworks \| 是（页面含模型与价格） \| 否 — no search support \| \$0\.25\/1M \| \$0\.45\/1M \|/);
  assert.doesNotMatch(result.text, /\| (?:OpenRouter|Together|Fireworks) \|[^|\n]*\| 未验证 \|/);
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
