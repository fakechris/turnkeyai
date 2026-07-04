import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RoleToolExecutionResult } from "../tool-use";
import {
  readLegacyApprovalWaitTimeoutRuntimeEvidence,
  readLegacyCompletedSessionEvidenceText,
  readLegacySourceBoundedEvidenceText,
} from "../tool-loop-shared";
import {
  collectToolResultContentText,
  collectToolTraceResultContent,
} from "../tool-result-evidence";
import { produceBrowserEvidenceEnvelope } from "./browser-evidence-producer";
import { producePermissionEvidenceEnvelope } from "./permission-evidence-producer";
import { produceSessionEvidenceEnvelope } from "./session-evidence-producer";
import { produceTaskIntentEnvelope } from "./task-intent-producer";
import type {
  EvidenceEnvelope,
  RuntimeFactBundle,
  RuntimeFactInput,
  RuntimeFactKind,
  RuntimeRoundFactBundle,
  RuntimeRoundFactInput,
} from "./types";
import { produceUsableEvidenceEnvelope } from "./usable-evidence-producer";

export function buildRuntimeFactBundle(
  input: RuntimeFactInput,
): RuntimeFactBundle {
  const taskIntent = produceTaskIntentEnvelope(input);
  const session = produceSessionEvidenceEnvelope(input);
  const permission = producePermissionEvidenceEnvelope(input);
  const browser = produceBrowserEvidenceEnvelope({
    taskIntent: taskIntent.facts,
    toolTrace: input.toolTrace,
  });
  const usable = produceUsableEvidenceEnvelope(input);
  const toolTraceResultContent = collectToolTraceResultContent(input.toolTrace);
  const sourceBoundedEvidenceText = readLegacySourceBoundedEvidenceText({
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
  });
  const completedSessionEvidenceText = readLegacyCompletedSessionEvidenceText(
    input.toolTrace,
  );
  return {
    envelopes: [taskIntent, session, permission, browser, usable],
    policy: {
      taskIntent: taskIntent.facts,
      session: session.facts,
      permission: permission.facts,
      browser: browser.facts,
      usable: usable.facts,
    },
    finalText: {
      sourceBoundedEvidenceText,
      completedSessionEvidenceText,
      naturalFinishEvidenceText: [
        sourceBoundedEvidenceText,
        completedSessionEvidenceText,
      ]
        .filter((text) => text.trim().length > 0)
        .join("\n\n"),
      toolTraceResultContent,
      approvalWaitTimeoutRuntimeEvidence:
        readLegacyApprovalWaitTimeoutRuntimeEvidence(input.toolTrace),
      toolResultContentText: toolTraceResultContent,
    },
  };
}

export function buildRuntimeRoundFactBundle(
  input: RuntimeRoundFactInput,
): RuntimeRoundFactBundle {
  const toolTrace = toolTraceFromRoundResults(input.results);
  const session = produceSessionEvidenceEnvelope({ toolTrace });
  const permission = producePermissionEvidenceEnvelope({ toolTrace });
  const usable = produceUsableEvidenceEnvelope({ toolTrace });
  return {
    envelopes: [session, permission, usable],
    policy: {
      session: session.facts,
      permission: permission.facts,
      usable: usable.facts,
    },
    finalText: {
      toolResultContentText: collectToolResultContentText(input.results),
    },
  };
}

function toolTraceFromRoundResults(
  results: RoleToolExecutionResult[],
): NativeToolRoundTrace[] {
  return [
    {
      round: 0,
      calls: results.map((result) => ({
        id: result.toolCallId,
        name: result.toolName,
        input: {},
      })),
      results: results.map((result) => ({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        isError: result.isError === true,
        contentBytes: result.content.length,
        content: result.content,
        ...(result.cancelled === undefined
          ? {}
          : { cancelled: result.cancelled }),
        ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
      })),
      progress: results.flatMap((result) =>
        (result.progress ?? []).map((progress) => ({
          toolCallId: result.toolCallId,
          toolName: progress.toolName || result.toolName,
          phase: progress.phase,
          summary: progress.summary,
          ...(progress.detail === undefined ? {} : { detail: progress.detail }),
          ts: 0,
        })),
      ),
    },
  ];
}

export type RuntimeFactEnvelope = EvidenceEnvelope<RuntimeFactKind, unknown>;
