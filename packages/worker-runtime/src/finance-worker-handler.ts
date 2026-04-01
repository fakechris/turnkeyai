import {
  getInstructions,
  getRecentMessages,
  getRelayBrief,
} from "@turnkeyai/core-types/team";
import type { WorkerExecutionResult, WorkerHandler, WorkerInvocationInput } from "@turnkeyai/core-types/team";

export class FinanceWorkerHandler implements WorkerHandler {
  readonly kind = "finance" as const;

  async canHandle(input: WorkerInvocationInput): Promise<boolean> {
    const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
    if (!role) {
      return false;
    }

    const capabilities = new Set(role.capabilities ?? []);
    return capabilities.has("finance") || /finance|pricing|cost/i.test(role.name);
  }

  async run(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null> {
    const sourceText = [
      input.packet.taskPrompt,
      getInstructions(input.activation.handoff.payload),
      getRelayBrief(input.activation.handoff.payload),
      ...getRecentMessages(input.activation.handoff.payload).map((item) => item.content),
    ]
      .filter(Boolean)
      .join("\n");

    if (!/pricing|price|cost|\$/i.test(sourceText)) {
      return null;
    }

    const priceLines = extractPriceLines(sourceText);
    return {
      workerType: this.kind,
      status: "completed",
      summary: [
        "Finance worker extracted pricing signals.",
        `Signals: ${priceLines.join(" | ") || "none detected"}`,
      ].join("\n"),
      payload: {
        priceLines,
        trace: [
          {
            stepId: `${input.activation.handoff.taskId}:finance-extract`,
            kind: "console",
            startedAt: Date.now(),
            completedAt: Date.now(),
            status: "ok",
            input: {
              source: "prompt",
            },
            output: {
              priceLineCount: priceLines.length,
            },
          },
        ],
      },
    };
  }
}

function extractPriceLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => hasStrongPricingSignal(line))
    .slice(0, 8);
}

function hasStrongPricingSignal(line: string): boolean {
  if (
    /\$|€|£|\/1m|tokens?|\/month|\/yr|\/year|month|year|seat|credits?/i.test(line) ||
    /\d+(?:\.\d+)?\s*(usd|eur|€|£|credits?|seat)/i.test(line)
  ) {
    return true;
  }

  return /\b(price|pricing|cost)\b/i.test(line) && /\d/.test(line);
}
