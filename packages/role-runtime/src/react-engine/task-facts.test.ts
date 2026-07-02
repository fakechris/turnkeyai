import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import {
  buildAwaitingContextSetupNoToolRepairPrompt,
  buildExtraneousProviderTableSchemaRepairPrompt,
  buildMissingRequestedTableColumnsRepairPrompt,
  buildOriginalRequestTableColumnContext,
  buildRequestedTableColumnActivationContext,
  explicitlyRequestsProviderSupportSchema,
  markdownTableHasExactRequestedColumns,
  recordRepairPrompt,
  requestedColumnsLookLikeProviderSearchPricing,
  requestedTableColumnMessageContext,
  resolveRequestedTableColumns,
  resultIntroducesProviderSupportSchema,
  shouldRepairExtraneousProviderTableSchema,
  shouldRepairMissingRequestedTableColumns,
  shouldSuppressToolsForAwaitingContextSetup,
  taskPromptRequestsAwaitingContextSetup,
} from "./task-facts";
import type { LLMMessage } from "./types";

function makeActivation(): RoleActivationInput {
  return {
    handoff: {
      payload: {
        intent: {
          relayBrief: "table: vendor | risk",
          instructions: "表格列出：结论、证据 URL",
          recentMessages: [
            { role: "user", content: "table columns: status, owner" },
          ],
        },
      },
    },
  } as RoleActivationInput;
}

test("TaskFacts resolves explicitly requested table columns from English and Chinese prompts", () => {
  assert.deepEqual(
    resolveRequestedTableColumns([
      "table columns: provider, support, evidence URL",
      "表格列出：风险、建议",
    ]),
    ["provider", "support", "evidence URL", "风险", "建议"],
  );
});

test("TaskFacts infers provider search/pricing evidence columns when the task asks that shape", () => {
  assert.deepEqual(
    resolveRequestedTableColumns([
      "Research whether DeepSeek R1 API providers support search/web_search and list input/output pricing with evidence.",
    ]),
    [
      "provider",
      "是否明确支持 DeepSeek R1",
      "是否明确支持 search/web_search",
      "输入价格",
      "输出价格",
      "证据 URL",
      "关键原文摘录",
    ],
  );
});

test("TaskFacts detects markdown tables containing the requested header columns", () => {
  assert.equal(
    markdownTableHasExactRequestedColumns(
      [
        "| Provider | Evidence URL | Risk |",
        "| --- | --- | --- |",
        "| A | https://example.com | 未验证 |",
      ].join("\n"),
      ["provider", "evidence url"],
    ),
    true,
  );
  assert.equal(
    markdownTableHasExactRequestedColumns(
      ["| Provider | Risk |", "| --- | --- |", "| A | low |"].join("\n"),
      ["provider", "evidence url"],
    ),
    false,
  );
});

test("TaskFacts builds activation and message context for requested columns", () => {
  const activation = makeActivation();
  assert.deepEqual(buildOriginalRequestTableColumnContext(activation), [
    "table: vendor | risk",
    "表格列出：结论、证据 URL",
  ]);
  assert.deepEqual(buildRequestedTableColumnActivationContext(activation), [
    "table: vendor | risk",
    "表格列出：结论、证据 URL",
    "table columns: status, owner",
  ]);

  const messages: LLMMessage[] = [
    { role: "assistant", content: "ignored" },
    {
      role: "user",
      content: [{ type: "text", text: "table: source, quote" }],
    },
  ];
  assert.deepEqual(requestedTableColumnMessageContext(messages), [
    "table: source, quote",
  ]);
});

test("TaskFacts detects extraneous provider support schema and explicit requests", () => {
  const schema =
    "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |\n| --- | --- | --- | --- |";
  assert.equal(resultIntroducesProviderSupportSchema(schema), true);
  assert.equal(
    explicitlyRequestsProviderSupportSchema(
      "Compare provider options for DeepSeek R1 search/web_search support, input price, and output price.",
    ),
    true,
  );
  assert.equal(
    explicitlyRequestsProviderSupportSchema(
      "Compare pricing, strengths, risks, tradeoff, and recommendation.",
    ),
    false,
  );
  assert.equal(
    requestedColumnsLookLikeProviderSearchPricing([
      "provider",
      "是否明确支持目标模型",
      "是否明确支持 search/web_search",
      "输入价格",
      "输出价格",
    ]),
    true,
  );
});

test("TaskFacts owns missing requested table column repair prompts and markers", () => {
  const taskPrompt = "Return table: provider, evidence URL.";
  const messages: LLMMessage[] = [];
  const repairMarkers: LLMMessage[] = [];
  const resultText = ["| provider |", "| --- |", "| A |"].join("\n");

  assert.equal(
    shouldRepairMissingRequestedTableColumns({
      taskPrompt,
      messages,
      repairMarkers,
      resultText,
    }),
    true,
  );

  const prompt = buildMissingRequestedTableColumnsRepairPrompt({
    taskPrompt,
    messages,
    resultText,
  });
  assert.match(prompt, /Required table header columns: provider \| evidence URL/);
  assert.equal(recordRepairPrompt(repairMarkers, prompt), repairMarkers[0]);
  assert.equal(
    shouldRepairMissingRequestedTableColumns({
      taskPrompt,
      messages,
      repairMarkers,
      resultText,
    }),
    false,
  );
});

test("TaskFacts owns extraneous provider schema repair prompts and markers", () => {
  const taskPrompt =
    "Compare pricing, strengths, risks, tradeoff, and recommendation.";
  const messages: LLMMessage[] = [];
  const repairMarkers: LLMMessage[] = [];
  const resultText = [
    "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
    "| --- | --- | --- | --- |",
    "| A | 未验证 | 未验证 | 未验证 |",
  ].join("\n");

  assert.equal(
    shouldRepairExtraneousProviderTableSchema({
      taskPrompt,
      messages,
      repairMarkers,
      resultText,
    }),
    true,
  );

  const prompt = buildExtraneousProviderTableSchemaRepairPrompt({
    taskPrompt,
    resultText,
  });
  assert.match(prompt, /provider\/search\/model-support columns/);
  recordRepairPrompt(repairMarkers, prompt);
  assert.equal(
    shouldRepairExtraneousProviderTableSchema({
      taskPrompt,
      messages,
      repairMarkers,
      resultText,
    }),
    false,
  );
});

test("TaskFacts owns awaiting-context setup suppression and marker idempotency", () => {
  const taskPrompt =
    "No research is needed. Briefly acknowledge and continue when context is provided.";
  const repairMarkers: LLMMessage[] = [];

  assert.equal(taskPromptRequestsAwaitingContextSetup(taskPrompt), true);
  assert.equal(
    taskPromptRequestsAwaitingContextSetup(
      "No research is needed. Briefly acknowledge and recover the launch window from durable memory.",
    ),
    false,
  );
  assert.equal(
    shouldSuppressToolsForAwaitingContextSetup({ taskPrompt, repairMarkers }),
    true,
  );

  recordRepairPrompt(
    repairMarkers,
    buildAwaitingContextSetupNoToolRepairPrompt(taskPrompt),
  );
  assert.equal(
    shouldSuppressToolsForAwaitingContextSetup({ taskPrompt, repairMarkers }),
    false,
  );
});
