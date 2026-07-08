import type {
  GenerateTextInput,
  GenerateTextResult,
  ModelConfigEntry,
  ProtocolClient,
} from "./types";
import { assertRequestEnvelopeWithinLimits } from "./request-envelope-guard";
import type { RequestEnvelopeLimits } from "./request-envelope-guard";
import { ModelRegistry } from "./registry";

export class LLMGateway {
  private readonly registry: ModelRegistry;
  private readonly clients: ProtocolClient[];
  private readonly requestTimeoutMs: number;
  private readonly requestEnvelopeLimits: Partial<RequestEnvelopeLimits> | undefined;

  constructor(options: {
    registry: ModelRegistry;
    clients: ProtocolClient[];
    requestTimeoutMs?: number;
    requestEnvelopeLimits?: Partial<RequestEnvelopeLimits>;
  }) {
    this.registry = options.registry;
    this.clients = options.clients;
    this.requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
    this.requestEnvelopeLimits = options.requestEnvelopeLimits;
  }

  async listModels() {
    return this.registry.list();
  }

  async listModelChains() {
    return this.registry.listChains();
  }

  async describeSelection(input: { modelId?: string; modelChainId?: string }) {
    return this.registry.describeSelection(input);
  }

  async generate(input: GenerateTextInput): Promise<GenerateTextResult> {
    const selectionInput = {
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
    };
    const [selection, selectionDescription] = await Promise.all([
      this.registry.resolveSelection(selectionInput),
      this.registry.describeSelection(selectionInput),
    ]);
    const candidateModelIds = dedupeEquivalentModelBackings(
      [selection.primaryModelId, ...selection.fallbackModelIds],
      [selectionDescription.primary, ...selectionDescription.fallbacks]
    );
    const attemptedModelIds: string[] = [];
    let lastError: unknown;

    for (const modelId of candidateModelIds) {
      attemptedModelIds.push(modelId);
      try {
        const model = await this.registry.resolve(modelId);
        const requestEnvelope = assertRequestEnvelopeWithinLimits(
          {
            ...input,
            modelId,
          },
          this.requestEnvelopeLimits,
          model
        );
        const client = this.clients.find((item) => item.supports(model.protocol));

        if (!client) {
          throw new Error(`no protocol client for ${model.protocol}`);
        }

        const result = await runWithRequestTimeout(
          (signal) =>
            client.generate(model, {
              ...input,
              modelId,
              signal,
            }),
          {
            timeoutMs: this.requestTimeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
            modelId,
          }
        );
        return {
          ...result,
          requestEnvelope,
          ...(selection.chainId ? { modelChainId: selection.chainId } : {}),
          ...(selection.chainId || attemptedModelIds.length > 1 ? { attemptedModelIds } : {}),
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("model generation failed without an error");
  }
}

function dedupeEquivalentModelBackings(
  modelIds: string[],
  modelEntries: ModelConfigEntry[]
): string[] {
  const seen = new Set<string>();
  return modelIds.filter((modelId, index) => {
    const entry = modelEntries[index];
    if (!entry) {
      return true;
    }
    const key = modelBackingKey(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function modelBackingKey(entry: ModelConfigEntry): string {
  return [
    entry.protocol,
    entry.providerId,
    entry.model,
    entry.baseURL ?? `baseURLEnv:${entry.baseURLEnv ?? ""}`,
    entry.apiKeyEnv,
    stableStringify(entry.headers ?? {}),
    stableStringify(entry.query ?? {}),
    entry.temperature ?? "",
    entry.maxOutputTokens ?? "",
  ].join("\0");
}

function stableStringify(value: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, string>>((acc, key) => {
        acc[key] = value[key] ?? "";
        return acc;
      }, {})
  );
}

function resolveRequestTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  const envValue = process.env.TURNKEYAI_LLM_REQUEST_TIMEOUT_MS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return 120_000;
}

async function runWithRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  input: { timeoutMs: number; signal?: AbortSignal; modelId: string }
): Promise<T> {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? new Error("LLM request aborted");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutError = new Error(`llm_request_timeout: model ${input.modelId} did not respond within ${input.timeoutMs}ms`);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, input.timeoutMs);
  });
  const externalSignal = input.signal;
  const abortPromise =
    externalSignal &&
    new Promise<never>((_, reject) => {
      abortListener = () => {
        const reason = externalSignal.reason ?? new Error("LLM request aborted");
        controller.abort(reason);
        reject(reason);
      };
      externalSignal.addEventListener("abort", abortListener, { once: true });
    });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener && externalSignal) {
      externalSignal.removeEventListener("abort", abortListener);
    }
  }
}
