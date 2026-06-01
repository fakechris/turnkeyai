import type { GenerateTextInput, GenerateTextResult, ProtocolClient } from "./types";
import { assertRequestEnvelopeWithinLimits } from "./request-envelope-guard";
import { ModelRegistry } from "./registry";

export class LLMGateway {
  private readonly registry: ModelRegistry;
  private readonly clients: ProtocolClient[];
  private readonly requestTimeoutMs: number;

  constructor(options: { registry: ModelRegistry; clients: ProtocolClient[]; requestTimeoutMs?: number }) {
    this.registry = options.registry;
    this.clients = options.clients;
    this.requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
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
    const selection = await this.registry.resolveSelection({
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
    });
    const candidateModelIds = [selection.primaryModelId, ...selection.fallbackModelIds];
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
          undefined,
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
  let timeout: NodeJS.Timeout | undefined;
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
