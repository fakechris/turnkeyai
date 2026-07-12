import type {
  GenerateTextInput,
  GenerateTextResult,
  ModelConfigEntry,
  ModelRetryDiagnostics,
  ProviderLifecycleEvent,
  ProtocolClient,
} from "./types";
import { ProviderRequestError } from "./types";
import {
  assertRequestEnvelopeWithinLimits,
  RequestEnvelopeOverflowError,
  type RequestEnvelopeLimits,
} from "./request-envelope-guard";
import {
  createRetryAllowance,
  decideProviderRetry,
  DEFAULT_PROVIDER_RETRY_POLICY,
  providerErrorCode,
  type ProviderRetryPolicy,
} from "./retry-policy";
import { ModelRegistry } from "./registry";

export class LLMGateway {
  private readonly registry: ModelRegistry;
  private readonly clients: ProtocolClient[];
  private readonly requestTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly generateWallClockMs: number;
  private readonly requestEnvelopeLimits: Partial<RequestEnvelopeLimits> | undefined;
  private readonly retryPolicy: ProviderRetryPolicy;
  private readonly retrySleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly retryRandom: () => number;

  constructor(options: {
    registry: ModelRegistry;
    clients: ProtocolClient[];
    requestTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
    generateWallClockMs?: number;
    requestEnvelopeLimits?: Partial<RequestEnvelopeLimits>;
    retryPolicy?: Partial<ProviderRetryPolicy>;
    retrySleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
    retryRandom?: () => number;
  }) {
    this.registry = options.registry;
    this.clients = options.clients;
    this.requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
    this.streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(
      options.streamIdleTimeoutMs,
    );
    this.generateWallClockMs = resolveGenerateWallClockMs(options.generateWallClockMs);
    this.requestEnvelopeLimits = options.requestEnvelopeLimits;
    this.retryPolicy = {
      ...DEFAULT_PROVIDER_RETRY_POLICY,
      ...(options.retryPolicy ?? {}),
    };
    this.retrySleep = options.retrySleep ?? sleepWithSignal;
    this.retryRandom = options.retryRandom ?? Math.random;
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
    const retryModels: ModelRetryDiagnostics[] = [];
    let totalAttempts = 0;
    let totalRetries = 0;
    const maxTransportAttempts = Math.max(
      this.retryPolicy.transientMaxAttempts,
      this.retryPolicy.timeoutMaxAttempts,
    );
    const retryAllowance = createRetryAllowance({
      allowanceId: `model-transport:${selection.chainId ?? selection.primaryModelId}`,
      ownerScopeId: selection.chainId ?? selection.primaryModelId,
      failureDomain: "model_transport",
      maxAttempts: maxTransportAttempts,
    });
    const deadline = Math.min(
      Date.now() + this.generateWallClockMs,
      input.deadlineAt ?? Number.POSITIVE_INFINITY,
    );
    let lastError: unknown;

    modelChain: for (const modelId of candidateModelIds) {
      attemptedModelIds.push(modelId);
      const modelDiagnostics: ModelRetryDiagnostics = {
        modelId,
        attempts: 0,
        retries: 0,
        errors: [],
      };
      retryModels.push(modelDiagnostics);

      for (let attempt = 1; ; attempt += 1) {
        if (!retryAllowance.claimAttempt()) {
          break modelChain;
        }
        if (input.signal?.aborted) {
          throw input.signal.reason ?? new Error("LLM request aborted");
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new ProviderRequestError(
            `llm_generate_deadline_exceeded: generation exceeded its absolute deadline`,
            { code: "deadline_exceeded", retryable: false },
          );
        }
        modelDiagnostics.attempts += 1;
        totalAttempts += 1;
        let providerAttempt:
          | Pick<
              ProviderLifecycleEvent,
              "attempt" | "modelId" | "providerId" | "protocol"
            >
          | undefined;
        try {
          const model = await this.registry.resolve(modelId);
          const requestEnvelope = assertRequestEnvelopeWithinLimits(
            {
              ...input,
              modelId,
            },
            this.requestEnvelopeLimits,
            model,
          );
          const client = this.clients.find((item) => item.supports(model.protocol));

          if (!client) {
            throw new Error(`no protocol client for ${model.protocol}`);
          }

          providerAttempt = {
            attempt: totalAttempts,
            modelId,
            providerId: model.providerId,
            protocol: model.protocol,
          };
          await emitProviderLifecycle(input, {
            kind: "attempt_started",
            at: Date.now(),
            ...providerAttempt,
          });

          const result = await runWithRequestTimeout(
            (signal, onActivity) =>
              client.generate(model, {
                ...input,
                modelId,
                signal,
                onProviderActivity: (activity) => {
                  input.onProviderActivity?.(activity);
                  emitProviderLifecycleDeferred(input, {
                    kind: "activity",
                    at: Date.now(),
                    ...providerAttempt!,
                    activity: activity ?? "event",
                  });
                  onActivity();
                },
              }),
            {
              timeoutMs: Math.min(
                providerStreamingEnabled(model.protocol)
                  ? this.streamIdleTimeoutMs
                  : this.requestTimeoutMs,
                remainingMs,
              ),
              deadlineAt: deadline,
              ...(input.signal ? { signal: input.signal } : {}),
              modelId,
            },
          );
          await emitProviderLifecycle(input, {
            kind: "attempt_completed",
            at: Date.now(),
            ...providerAttempt,
          });
          return {
            ...result,
            requestEnvelope,
            retryDiagnostics: {
              totalAttempts,
              totalRetries,
              models: retryModels,
            },
            ...(selection.chainId ? { modelChainId: selection.chainId } : {}),
            ...(selection.chainId || attemptedModelIds.length > 1 ? { attemptedModelIds } : {}),
          };
        } catch (error) {
          if (error instanceof RequestEnvelopeOverflowError) {
            throw error;
          }
          const code = providerErrorCode(error);
          if (providerAttempt) {
            await emitProviderLifecycle(input, {
              kind: "attempt_failed",
              at: Date.now(),
              ...providerAttempt,
              code,
              message: error instanceof Error ? error.message : String(error),
              retryable:
                error instanceof ProviderRequestError && error.retryable,
            });
          }
          if (input.signal?.aborted) {
            throw input.signal.reason ?? error;
          }
          lastError = error;
          modelDiagnostics.errors.push(code);
          const decision = decideProviderRetry({
            error,
            attempt,
            policy: this.retryPolicy,
            random: this.retryRandom,
          });
          if (!decision.retry) {
            break;
          }
          if (!retryAllowance.hasRemainingAttempts()) {
            break;
          }
          if (Date.now() + decision.delayMs >= deadline) {
            break;
          }
          modelDiagnostics.retries += 1;
          totalRetries += 1;
          if (providerAttempt) {
            await emitProviderLifecycle(input, {
              kind: "retry_wait",
              at: Date.now(),
              ...providerAttempt,
              code,
              retry: modelDiagnostics.retries,
              delayMs: decision.delayMs,
            });
          }
          await this.retrySleep(decision.delayMs, input.signal);
        }
      }
    }

    throw lastError ?? new Error("model generation failed without an error");
  }
}

async function emitProviderLifecycle(
  input: GenerateTextInput,
  event: ProviderLifecycleEvent,
): Promise<void> {
  try {
    await input.onProviderLifecycle?.(event);
  } catch {
    // Observability must never change provider execution behavior.
  }
}

function emitProviderLifecycleDeferred(
  input: GenerateTextInput,
  event: ProviderLifecycleEvent,
): void {
  try {
    const pending = input.onProviderLifecycle?.(event);
    if (pending && typeof pending.then === "function") {
      void pending.catch(() => undefined);
    }
  } catch {
    // Observability must never change provider execution behavior.
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
    entry.promptCacheMode ?? "off",
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

function resolveGenerateWallClockMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  const envValue = process.env.TURNKEYAI_LLM_GENERATE_WALL_CLOCK_MS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return 5 * 60_000;
}

function resolveStreamIdleTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  const envValue = process.env.TURNKEYAI_LLM_STREAM_IDLE_TIMEOUT_MS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return 45_000;
}

function providerStreamingEnabled(protocol: string): boolean {
  return (
    protocol === "anthropic-compatible" ||
    (protocol === "openai-compatible" &&
      process.env.TURNKEYAI_LLM_STREAMING === "1")
  );
}

async function runWithRequestTimeout<T>(
  operation: (
    signal: AbortSignal,
    onActivity: () => void,
  ) => Promise<T>,
  input: {
    timeoutMs: number;
    deadlineAt: number;
    signal?: AbortSignal;
    modelId: string;
  }
): Promise<T> {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? new Error("LLM request aborted");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutError = new ProviderRequestError(
    `llm_request_timeout: model ${input.modelId} produced no provider activity for ${input.timeoutMs}ms`,
    { code: "timeout", retryable: true },
  );
  let rejectTimeout: ((error: ProviderRequestError) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const armTimeout = () => {
    if (timeout) clearTimeout(timeout);
    const remainingMs = Math.max(0, input.deadlineAt - Date.now());
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      rejectTimeout?.(timeoutError);
    }, Math.min(input.timeoutMs, remainingMs));
  };
  armTimeout();
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
    return await Promise.race([
      operation(controller.signal, armTimeout),
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener && externalSignal) {
      externalSignal.removeEventListener("abort", abortListener);
    }
  }
}

async function sleepWithSignal(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("LLM request aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, delayMs));
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("LLM request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
