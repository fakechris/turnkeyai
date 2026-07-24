import path from "node:path";

import {
  DYNAMIC_CONTEXT_BASELINE_PROTOCOL,
  type ContextSectionReceipt,
  type DynamicContextBaseline,
  type DynamicContextBaselineStore,
  type DynamicContextScope,
} from "@turnkeyai/core-types/dynamic-context-baseline";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

export class FileDynamicContextBaselineStore
  implements DynamicContextBaselineStore
{
  private readonly rootDir: string;
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(options: { rootDir: string }) {
    this.rootDir = options.rootDir;
  }

  async get(
    scope: DynamicContextScope,
  ): Promise<DynamicContextBaseline | null> {
    const value = await readJsonFile<DynamicContextBaseline>(
      this.baselinePath(scope),
    );
    return isDynamicContextBaseline(value) &&
        sameScope(value.scope, scope)
      ? value
      : null;
  }

  async put(baseline: DynamicContextBaseline): Promise<void> {
    assertDynamicContextBaseline(baseline);
    const scopeKey = dynamicContextScopeKey(baseline.scope);
    await this.mutex.run(scopeKey, async () => {
      await writeJsonFileAtomic(
        this.baselinePath(baseline.scope),
        baseline,
      );
    });
  }

  private baselinePath(scope: DynamicContextScope): string {
    return path.join(
      this.rootDir,
      `${encodeURIComponent(dynamicContextScopeKey(scope))}.json`,
    );
  }
}

export function dynamicContextScopeKey(scope: DynamicContextScope): string {
  return `${scope.threadId}\u0000${scope.roleId}\u0000${scope.flowId}`;
}

function assertDynamicContextBaseline(
  value: DynamicContextBaseline,
): void {
  if (!isDynamicContextBaseline(value)) {
    throw new Error("invalid dynamic context baseline");
  }
}

function isDynamicContextBaseline(
  value: unknown,
): value is DynamicContextBaseline {
  return isRecord(value) &&
    value["protocol"] === DYNAMIC_CONTEXT_BASELINE_PROTOCOL &&
    typeof value["baselineId"] === "string" &&
    isScope(value["scope"]) &&
    typeof value["promptPackVersion"] === "string" &&
    typeof value["modelFingerprint"] === "string" &&
    typeof value["toolFingerprint"] === "string" &&
    Array.isArray(value["sections"]) &&
    value["sections"].every(isSectionReceipt) &&
    typeof value["activatedAt"] === "number";
}

function isSectionReceipt(value: unknown): value is ContextSectionReceipt {
  return isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["version"] === "string" &&
    typeof value["digest"] === "string" &&
    Array.isArray(value["sourceRefs"]) &&
    value["sourceRefs"].every((item) => typeof item === "string") &&
    typeof value["packedTokens"] === "number" &&
    Number.isFinite(value["packedTokens"]) &&
    typeof value["omitted"] === "boolean" &&
    typeof value["updatedAt"] === "number" &&
    Number.isFinite(value["updatedAt"]);
}

function isScope(value: unknown): value is DynamicContextScope {
  return isRecord(value) &&
    typeof value["threadId"] === "string" &&
    typeof value["roleId"] === "string" &&
    typeof value["flowId"] === "string";
}

function sameScope(
  left: DynamicContextScope,
  right: DynamicContextScope,
): boolean {
  return left.threadId === right.threadId &&
    left.roleId === right.roleId &&
    left.flowId === right.flowId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
