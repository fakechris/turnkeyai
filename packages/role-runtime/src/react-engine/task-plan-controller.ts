import type { LLMMessage, LLMToolDefinition } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";

export const TASK_PLAN_NUDGE_PROTOCOL = "turnkeyai.task_plan_nudge.v1" as const;
const TASK_PLAN_STALE_AFTER_ROUNDS = 10;
const TASK_TOOL_NAMES = new Set([
  "tasks_list",
  "tasks_create",
  "tasks_update",
]);
const TERMINAL_TASK_STATUSES = new Set(["done", "archived"]);

export interface TaskPlanController {
  applyRoundMessagesHook(input: {
    messages: LLMMessage[];
    round: number;
    tools: LLMToolDefinition[];
    toolTrace: NativeToolRoundTrace[];
    planState: string[];
    repairMarkers: LLMMessage[];
  }): { messages: LLMMessage[] };
}

export function createTaskPlanController(): TaskPlanController {
  return {
    applyRoundMessagesHook(input) {
      if (!input.tools.some((tool) => tool.name === "tasks_update")) {
        return { messages: input.messages };
      }
      const activeItems = input.planState.filter(isNonterminalPlanItem);
      if (activeItems.length === 0) {
        return { messages: input.messages };
      }
      const lastTaskRound = latestTaskToolRound(input.toolTrace);
      const quietRounds = input.round - (lastTaskRound - 1);
      if (quietRounds <= TASK_PLAN_STALE_AFTER_ROUNDS) {
        return { messages: input.messages };
      }
      const markerKey = `${lastTaskRound}:${activeItems.join("|")}`;
      if (hasNudgeMarker(input.repairMarkers, markerKey)) {
        return { messages: input.messages };
      }
      const marker: LLMMessage = {
        role: "user",
        content: [
          "TurnkeyAI task plan nudge v1",
          JSON.stringify({
            protocol: TASK_PLAN_NUDGE_PROTOCOL,
            marker_key: markerKey,
            quiet_rounds: quietRounds,
            active_tasks: activeItems,
            instruction:
              "Before more unrelated tool work, use tasks_update to record current progress, completion, or blocker for the active work items.",
          }),
        ].join("\n"),
      };
      input.repairMarkers.push(marker);
      return { messages: [...input.messages, marker] };
    },
  };
}

function latestTaskToolRound(toolTrace: NativeToolRoundTrace[]): number {
  let latest = 0;
  for (const round of toolTrace) {
    if (round.calls.some((call) => TASK_TOOL_NAMES.has(call.name))) {
      latest = Math.max(latest, round.round);
    }
  }
  return latest;
}

function isNonterminalPlanItem(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return (
      typeof parsed["id"] === "string" &&
      typeof parsed["status"] === "string" &&
      !TERMINAL_TASK_STATUSES.has(parsed["status"])
    );
  } catch {
    return false;
  }
}

function hasNudgeMarker(
  repairMarkers: LLMMessage[],
  markerKey: string,
): boolean {
  return repairMarkers.some((message) => {
    if (typeof message.content !== "string") return false;
    const json = message.content.slice(message.content.indexOf("{"));
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      return (
        parsed["protocol"] === TASK_PLAN_NUDGE_PROTOCOL &&
        parsed["marker_key"] === markerKey
      );
    } catch {
      return false;
    }
  });
}
