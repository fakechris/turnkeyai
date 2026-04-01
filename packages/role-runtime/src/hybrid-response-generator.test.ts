import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";

import type { GeneratedRoleReply, RoleResponseGenerator } from "./deterministic-response-generator";
import { HybridRoleResponseGenerator } from "./hybrid-response-generator";
import type { RolePromptPacket } from "./prompt-policy";

test("hybrid response generator falls back cleanly on request envelope overflow", async () => {
  const generator = new HybridRoleResponseGenerator({
    primary: {
      async generate(): Promise<GeneratedRoleReply> {
        throw new RequestEnvelopeOverflowError({
          diagnostics: {
            messageCount: 2,
            promptChars: 130_000,
            promptBytes: 181_000,
            metadataBytes: 128,
            artifactCount: 30,
            toolCount: 0,
            toolSchemaBytes: 0,
            toolResultCount: 0,
            toolResultBytes: 0,
            inlineAttachmentBytes: 0,
            inlineImageCount: 0,
            inlineImageBytes: 0,
            inlinePdfCount: 0,
            inlinePdfBytes: 0,
            multimodalPartCount: 0,
            totalSerializedBytes: 200_000,
            overLimitKeys: ["promptChars", "promptBytes", "artifactCount"],
          },
        });
      },
    } satisfies RoleResponseGenerator,
    fallback: {
      async generate(): Promise<GeneratedRoleReply> {
        return {
          content: "Fallback summary.",
          mentions: ["role-lead"],
          metadata: {
            adapterName: "heuristic",
          },
        };
      },
    } satisfies RoleResponseGenerator,
  });

  const result = await generator.generate({
    activation: {} as RoleActivationInput,
    packet: {} as RolePromptPacket,
  });

  assert.equal(result.content, "Fallback summary.");
  assert.equal(result.metadata?.adapterName, "heuristic");
  assert.match(String(result.metadata?.fallbackReason ?? ""), /request envelope exceeds safe limits/i);
  assert.equal(
    ((result.metadata?.requestEnvelopeFailure as { diagnostics?: { artifactCount?: number } } | undefined)?.diagnostics
      ?.artifactCount),
    30
  );
});
