import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type {
  GenerateTextInput,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import { readToolResultContentText } from "./tool-history-pruning";
import { produceTaskIntentEnvelope } from "./runtime-facts/task-intent-producer";
import {
  continuationRequestPrefersResumableSession,
  extractLatestUserContinuationText,
  isExplicitSessionContinuationRequest,
} from "./runtime-facts/text-fallback-readers";

const FOCUSED_MEMORY_RECALL_TOOL_NAMES = new Set([
  "memory_search",
  "memory_get",
]);
const PERMISSION_TOOL_NAMES = new Set([
  "permission_query",
  "permission_result",
  "permission_applied",
]);
const TASK_TRACKING_TOOL_NAMES = new Set([
  "tasks_list",
  "tasks_create",
  "tasks_update",
]);
const FOCUSED_MEMORY_RECALL_REQUEST_PATTERN =
  /\b(?:durable memory|memory_search|memory_get|check durable memory|inspect any candidate memory)\b/i;
const FOCUSED_MEMORY_RECALL_GLOBAL_CONFLICT_PATTERN =
  /\b(?:public documentation|status pages?|announcements?|web search|web_fetch|official site|URL|https?:\/\/)\b|(?:公网|公开文档|公告|状态页|官网|网址|链接)/iu;
const FOCUSED_MEMORY_RECALL_NEARBY_CONFLICT_PATTERN = new RegExp(
  `${FOCUSED_MEMORY_RECALL_REQUEST_PATTERN.source}[\\s\\S]{0,180}\\b(?:delegate|delegated|spawn|sub[- ]?agent|independent researcher|separate researcher)\\b|\\b(?:delegate|delegated|spawn|sub[- ]?agent|independent researcher|separate researcher)\\b[\\s\\S]{0,180}${FOCUSED_MEMORY_RECALL_REQUEST_PATTERN.source}`,
  "iu",
);
const FOCUSED_MEMORY_RECALL_CJK_NEARBY_CONFLICT_PATTERN =
  /(?:durable memory|memory_search|memory_get|记忆|长期记忆)[\s\S]{0,120}(?:委派|派给|子\s*agent|独立研究员)|(?:委派|派给|子\s*agent|独立研究员)[\s\S]{0,120}(?:durable memory|memory_search|memory_get|记忆|长期记忆)/iu;

export function filterToolDefinitionsForTask(
  tools: GenerateTextInput["tools"],
  taskPrompt: string,
): GenerateTextInput["tools"] {
  if (!tools?.length) return tools;
  let filtered = tools;
  const taskFacts = produceTaskIntentEnvelope({
    taskPrompt,
    messages: [],
  }).facts;
  if (!taskFacts.permissionToolsAllowed) {
    filtered = filtered.filter((tool) => !PERMISSION_TOOL_NAMES.has(tool.name));
  }
  if (!taskAllowsTaskTrackingTools(taskPrompt, taskFacts)) {
    filtered = filtered.filter(
      (tool) => !TASK_TRACKING_TOOL_NAMES.has(tool.name),
    );
  }
  if (taskRequestsFocusedDurableMemoryRecall(taskPrompt)) {
    filtered = filtered.filter((tool) =>
      FOCUSED_MEMORY_RECALL_TOOL_NAMES.has(tool.name),
    );
  }
  return filtered;
}

export function buildToolDefinitionFilterTaskContext(
  activation: RoleActivationInput,
  taskPrompt: string,
): string {
  const intent = activation.handoff.payload.intent;
  return [
    taskPrompt,
    intent?.relayBrief ?? "",
    ...(intent?.recentMessages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    ),
  ].join("\n");
}

export function buildToolDefinitionFilterMessageContext(
  messages: LLMMessage[],
): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => readToolResultContentText(message.content))
    .join("\n");
}

export function taskRequestsFocusedDurableMemoryRecall(
  taskPrompt: string,
): boolean {
  if (!FOCUSED_MEMORY_RECALL_REQUEST_PATTERN.test(taskPrompt)) {
    return false;
  }
  if (FOCUSED_MEMORY_RECALL_GLOBAL_CONFLICT_PATTERN.test(taskPrompt)) {
    return false;
  }
  if (
    FOCUSED_MEMORY_RECALL_NEARBY_CONFLICT_PATTERN.test(taskPrompt) ||
    FOCUSED_MEMORY_RECALL_CJK_NEARBY_CONFLICT_PATTERN.test(taskPrompt)
  ) {
    return false;
  }
  return true;
}

export function taskAllowsTaskTrackingTools(
  taskPrompt: string,
  taskFacts = produceTaskIntentEnvelope({ taskPrompt, messages: [] }).facts,
): boolean {
  if (
    taskFacts.sourceCheckContinuationRequested &&
    !taskPromptExplicitlyRequestsTaskTracking(taskPrompt)
  ) {
    return false;
  }
  if (
    isExplicitSessionContinuationRequest(
      extractLatestUserContinuationText(taskPrompt),
    ) ||
    continuationRequestPrefersResumableSession({
      latestUserText: extractLatestUserContinuationText(taskPrompt),
      context: taskPrompt,
    })
  ) {
    return taskPromptExplicitlyRequestsTaskTracking(taskPrompt);
  }
  return true;
}

function taskPromptExplicitlyRequestsTaskTracking(taskPrompt: string): boolean {
  return /\b(?:tasks?_(?:list|create|update)|work items?|todo|to-do|task tracking|create (?:a )?task|update (?:the )?task|mark .* done|任务|待办|工作项)\b/i.test(
    taskPrompt,
  );
}
