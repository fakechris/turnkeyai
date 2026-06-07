import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface ReferencePreflightOptions {
  baseUrl: string;
  outPath: string;
  referenceToken?: string;
  variant: string;
  timeoutMs: number;
  pollMs: number;
  probePrompt: string;
  check: boolean;
}

interface ReferencePreflightReport {
  kind: "turnkeyai.real-llm-ab-reference-preflight.report";
  status: "passed" | "failed";
  generatedAtMs: number;
  baseUrl: string;
  variant: string;
  checks: {
    modelCatalogJson: boolean;
    modelConfigured: boolean;
    bootstrapJson: boolean;
    threadIdCaptured: boolean;
    messageAccepted: boolean;
    promptObservedInTranscript: boolean;
    assistantFinalCaptured: boolean;
    browserSessionsRouteReachable: boolean;
    noAdapterFallback: boolean;
    noHarnessEcho: boolean;
    noDelegationOnlyFinal: boolean;
  };
  routes: ReferencePreflightRoute[];
  adapterDiagnostics: ReferenceAdapterDiagnostic[];
  rootCauseBuckets: string[];
  findings: string[];
  threadId?: string;
  finalText?: string;
}

interface ReferencePreflightRoute {
  route: string;
  method: "GET" | "POST";
  ok: boolean;
  status: number;
  contentType: string;
  bodySnippet: string;
  bodyJson?: unknown;
  json: boolean;
  error?: string;
}

interface ReferenceAdapterDiagnostic {
  modelId: string;
  providerId: string;
  protocol: string;
  configured: boolean;
  baseURL?: string;
  baseUrlPath?: string;
  safeChatCompletionsUrl?: string;
  absolutePathChatCompletionsUrl?: string;
  basePathDropRisk: boolean;
}

export function parseRealLlmAbReferencePreflightArgs(
  args: string[]
): ReferencePreflightOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let baseUrl: string | undefined;
  let outPath: string | undefined;
  let referenceToken: string | undefined;
  let variant = "operator";
  let timeoutMs = 60_000;
  let pollMs = 1_000;
  let probePrompt = "Please respond with one concise sentence confirming this runtime can answer a normal user message.";
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-url") {
      baseUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      outPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reference-token") {
      referenceToken = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--variant") {
      variant = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = readPositiveInteger(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--poll-ms") {
      pollMs = readPositiveInteger(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--probe-prompt") {
      probePrompt = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!baseUrl) throw new Error("missing required --base-url <url>");
  if (!outPath) throw new Error("missing required --out <path>");
  return {
    baseUrl,
    outPath,
    ...(referenceToken ? { referenceToken } : {}),
    variant,
    timeoutMs,
    pollMs,
    probePrompt,
    check,
  };
}

export function buildRealLlmAbReferencePreflightHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B reference daemon preflight",
    "",
    "Usage:",
    "  npm run acceptance:ab:reference-preflight -- --base-url <reference-daemon-url> --out <preflight.json> [--reference-token <token>] [--variant operator] [--timeout-ms 60000] [--poll-ms 1000] [--check]",
    "",
    "The preflight records raw route status, content type, body snippets, prompt receipt, assistant output, and browser-session route reachability before A/B collection.",
  ].join("\n");
}

export async function runRealLlmAbReferencePreflightCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbReferencePreflightArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbReferencePreflightHelpText());
    return;
  }
  const report = await runReferencePreflight(options);
  const resolvedOutPath = path.resolve(options.outPath);
  mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  writeFileSync(resolvedOutPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`real LLM A/B reference preflight written: ${resolvedOutPath}`);
  if (options.check && report.status !== "passed") {
    console.error("real LLM A/B reference preflight failed");
    for (const finding of report.findings) {
      console.error(`- ${finding}`);
    }
    process.exitCode = 1;
  }
}

export async function runReferencePreflight(input: {
  baseUrl: string;
  referenceToken?: string;
  variant?: string;
  timeoutMs?: number;
  pollMs?: number;
  probePrompt?: string;
  generatedAtMs?: number;
}): Promise<ReferencePreflightReport> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const variant = input.variant ?? "operator";
  const timeoutMs = input.timeoutMs ?? 60_000;
  const pollMs = input.pollMs ?? 1_000;
  const probePrompt =
    input.probePrompt ??
    "Please respond with one concise sentence confirming this runtime can answer a normal user message.";
  const routes: ReferencePreflightRoute[] = [];

  const requestAuth = buildReferenceRequestAuth(input.referenceToken);

  const modelRoute = await fetchRoute(baseUrl, "GET", "/models", undefined, requestAuth);
  routes.push(modelRoute);
  const modelCatalog = parseRouteJson(modelRoute);
  const modelConfigured = hasConfiguredModel(modelCatalog);
  const adapterDiagnostics = buildAdapterDiagnostics(modelCatalog);

  const bootstrapRoute = await fetchRoute(baseUrl, "POST", "/threads/bootstrap-demo", { variant }, requestAuth);
  routes.push(bootstrapRoute);
  const bootstrapJson = parseRouteJson(bootstrapRoute);
  const threadId = readThreadId(bootstrapJson);

  let messageAccepted = false;
  let messages: unknown[] = [];
  let finalText = "";
  if (threadId) {
    const messageRoute = await fetchRoute(baseUrl, "POST", "/messages", { threadId, content: probePrompt }, requestAuth);
    routes.push(messageRoute);
    messageAccepted = messageRoute.ok && messageRoute.json;

    const pollResult = await pollMessages({
      baseUrl,
      threadId,
      timeoutMs,
      pollMs,
      requestAuth,
      routes,
    });
    messages = pollResult.messages;
    finalText = pollResult.finalText;

    const browserRoute = await fetchRoute(
      baseUrl,
      "GET",
      `/browser-sessions?threadId=${encodeURIComponent(threadId)}`,
      undefined,
      requestAuth
    );
    routes.push(browserRoute);
  }

  const transcriptText = JSON.stringify(messages);
  const promptObservedInTranscript = transcriptContainsPrompt(messages, probePrompt);
  const adapterFallbackObserved = /Unexpected token '<'|<!DOCTYPE|adapterName["']?\s*:\s*["']?heuristic|fallbackReason/i.test(
    transcriptText
  );
  const harnessEchoObserved = /operating as|close the flow with|use the browser worker|please consolidate this update/i.test(
    finalText
  );
  const delegationOnlyFinalObserved = isDelegationOnlyReferenceText(finalText);
  const browserSessionsRouteReachable = routes.some((route) => route.route.startsWith("/browser-sessions") && route.ok);
  const checks = {
    modelCatalogJson: modelRoute.ok && modelRoute.json,
    modelConfigured,
    bootstrapJson: bootstrapRoute.ok && bootstrapRoute.json,
    threadIdCaptured: Boolean(threadId),
    messageAccepted,
    promptObservedInTranscript,
    assistantFinalCaptured: Boolean(finalText),
    browserSessionsRouteReachable,
    noAdapterFallback: !adapterFallbackObserved,
    noHarnessEcho: !harnessEchoObserved,
    noDelegationOnlyFinal: !delegationOnlyFinalObserved,
  };
  const rootCauseBuckets = buildRootCauseBuckets({ checks, routes, transcriptText, finalText, adapterDiagnostics });
  const findings = buildFindings(checks, routes, adapterDiagnostics, finalText);
  return {
    kind: "turnkeyai.real-llm-ab-reference-preflight.report",
    status: findings.length === 0 ? "passed" : "failed",
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    baseUrl,
    variant,
    checks,
    routes,
    adapterDiagnostics,
    rootCauseBuckets,
    findings,
    ...(threadId ? { threadId } : {}),
    ...(finalText ? { finalText } : {}),
  };
}

async function pollMessages(input: {
  baseUrl: string;
  threadId: string;
  timeoutMs: number;
  pollMs: number;
  requestAuth?: ReferenceRequestAuth;
  routes: ReferencePreflightRoute[];
}): Promise<{ messages: unknown[]; finalText: string }> {
  const startedAt = Date.now();
  let messages: unknown[] = [];
  let finalText = "";
  while (Date.now() - startedAt <= input.timeoutMs) {
    const route = await fetchRoute(
      input.baseUrl,
      "GET",
      `/messages?threadId=${encodeURIComponent(input.threadId)}`,
      undefined,
      input.requestAuth
    );
    input.routes.push(route);
    const json = parseRouteJson(route);
    messages = Array.isArray(json) ? json : Array.isArray((json as { messages?: unknown }).messages) ? (json as { messages: unknown[] }).messages : [];
    finalText = readLatestAssistantText(messages);
    if (finalText && !isDelegationOnlyReferenceText(finalText)) break;
    await sleep(input.pollMs);
  }
  return { messages, finalText };
}

async function fetchRoute(
  baseUrl: string,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  requestAuth?: ReferenceRequestAuth
): Promise<ReferencePreflightRoute> {
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: buildReferenceHeaders(body !== undefined, requestAuth),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const bodyJson = parseJsonText(text);
    return {
      route,
      method,
      ok: response.ok,
      status: response.status,
      contentType,
      bodySnippet: text.replace(/\s+/g, " ").trim().slice(0, 500),
      ...(bodyJson !== null ? { bodyJson } : {}),
      json: bodyJson !== null,
    };
  } catch (error) {
    return {
      route,
      method,
      ok: false,
      status: 0,
      contentType: "",
      bodySnippet: "",
      json: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface ReferenceRequestAuth {
  authorization: string;
}

function buildReferenceRequestAuth(token: string | undefined): ReferenceRequestAuth | undefined {
  const trimmed = token?.trim();
  return trimmed ? { authorization: `Bearer ${trimmed}` } : undefined;
}

function buildReferenceHeaders(hasJsonBody: boolean, requestAuth: ReferenceRequestAuth | undefined): HeadersInit | undefined {
  const headers: Record<string, string> = {};
  if (hasJsonBody) {
    headers["content-type"] = "application/json";
  }
  if (requestAuth) {
    headers.authorization = requestAuth.authorization;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseRouteJson(route: ReferencePreflightRoute): unknown {
  return route.bodyJson ?? null;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function buildRootCauseBuckets(input: {
  checks: ReferencePreflightReport["checks"];
  routes: ReferencePreflightRoute[];
  transcriptText: string;
  finalText: string;
  adapterDiagnostics: ReferenceAdapterDiagnostic[];
}): string[] {
  const buckets = new Set<string>();
  for (const route of input.routes) {
    if (!route.ok) buckets.add("reference_route_unavailable");
    if (route.ok && !route.json) buckets.add("reference_non_json_response");
    if (/<!DOCTYPE|<html/i.test(route.bodySnippet)) buckets.add("reference_endpoint_or_auth");
  }
  if (!input.checks.modelConfigured) buckets.add("model_config_unproven");
  if (!input.checks.promptObservedInTranscript) buckets.add("prompt_mismatch");
  if (!input.checks.assistantFinalCaptured) buckets.add("missing_final_answer");
  if (!input.checks.browserSessionsRouteReachable) buckets.add("browser_route_unavailable");
  if (!input.checks.noAdapterFallback) buckets.add("model_adapter_fallback");
  if (!input.checks.noAdapterFallback && input.adapterDiagnostics.some((diagnostic) => diagnostic.basePathDropRisk)) {
    buckets.add("openai_compatible_base_path_risk");
  }
  if (!input.checks.noHarnessEcho) buckets.add("prompt_harness_echo");
  if (!input.checks.noDelegationOnlyFinal) buckets.add("delegation_not_executed");
  if (!input.checks.noDelegationOnlyFinal && hasNonDispatchableTextHandoff(input.finalText)) {
    buckets.add("delegation_text_not_dispatchable");
  }
  if (/page\.evaluate|ReferenceError|__name is not defined/i.test(input.transcriptText)) {
    buckets.add("browser_evaluate_error");
  }
  if (/Browser worker failed/i.test(input.transcriptText)) buckets.add("browser_worker_failed");
  if (/Unexpected token '<'|<!DOCTYPE/i.test(input.transcriptText)) buckets.add("reference_endpoint_or_auth");
  return [...buckets].sort();
}

function buildFindings(
  checks: ReferencePreflightReport["checks"],
  routes: ReferencePreflightRoute[],
  adapterDiagnostics: ReferenceAdapterDiagnostic[],
  finalText: string
): string[] {
  const findings: string[] = [];
  if (!checks.modelCatalogJson) findings.push("model catalog route did not return JSON");
  if (!checks.modelConfigured) findings.push("configured model was not proven");
  if (!checks.bootstrapJson) findings.push("thread bootstrap route did not return JSON");
  if (!checks.threadIdCaptured) findings.push("thread id was not captured");
  if (!checks.messageAccepted) findings.push("message route did not accept a JSON request");
  if (!checks.promptObservedInTranscript) findings.push("probe prompt was not observed in transcript");
  if (!checks.assistantFinalCaptured) findings.push("assistant final text was not captured");
  if (!checks.browserSessionsRouteReachable) findings.push("browser sessions route was not reachable");
  if (!checks.noAdapterFallback) findings.push("model adapter fallback was observed");
  if (!checks.noAdapterFallback && adapterDiagnostics.some((diagnostic) => diagnostic.basePathDropRisk)) {
    findings.push("configured OpenAI-compatible model base URL has a path that may be dropped by absolute-path URL joining");
  }
  if (!checks.noHarnessEcho) findings.push("assistant final text looks like harness/process echo");
  if (!checks.noDelegationOnlyFinal) findings.push("assistant final text is delegation-only and no delegated result was observed");
  if (!checks.noDelegationOnlyFinal && hasNonDispatchableTextHandoff(finalText)) {
    findings.push("assistant final text names a role in prose rather than a dispatchable role mention");
  }
  for (const route of routes) {
    if (!route.ok) findings.push(`${route.method} ${route.route} returned ${route.status}${route.error ? ` (${route.error})` : ""}`);
    if (route.ok && !route.json) findings.push(`${route.method} ${route.route} returned non-JSON content`);
  }
  return [...new Set(findings)];
}

function isDelegationOnlyReferenceText(text: string): boolean {
  if (!text.trim()) return false;
  return (
    /\b(next role|delegate to|delegating to|i will delegate|let me delegate|handoff to|assign(?:ing)? this to)\b/i.test(text) &&
    !/\b(completed with|what was verified|verified findings|recommendation:|result:|i found|the page shows|the source shows)\b/i.test(text)
  );
}

function hasNonDispatchableTextHandoff(text: string): boolean {
  const roleIdMatch = text.match(/\b(?:next role|delegate to|delegate to role|handoff to|assign(?:ing)? this to)\s*:?\s*`?\*{0,2}(role-[a-z0-9_-]+)\b/i);
  if (roleIdMatch) {
    return !new RegExp(`@\\{${escapeRegExp(roleIdMatch[1] ?? "")}\\}`, "i").test(text);
  }
  return /\b(?:next role|delegate to|delegating to|i will delegate|let me delegate|handoff to|assign(?:ing)? this to)\b/i.test(text) && !/@\{[^}]+}/.test(text);
}

function transcriptContainsPrompt(messages: unknown[], prompt: string): boolean {
  const normalizedPrompt = normalizePromptForAudit(prompt);
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    const record = message as { role?: unknown; content?: unknown; text?: unknown };
    if (readString(record.role) !== "user") return false;
    const text = readMessageText(record.content) ?? readString(record.text) ?? "";
    return normalizePromptForAudit(text) === normalizedPrompt;
  });
}

function normalizePromptForAudit(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  return prompt
    .replace(/\b(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])):\d+/gi, "$1:<loopback-port>")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildAdapterDiagnostics(modelCatalog: unknown): ReferenceAdapterDiagnostic[] {
  return readConfiguredModelRecords(modelCatalog).flatMap((model) => {
    const protocol = readString(model.protocol) ?? "";
    const baseURL = readString(model.baseURL) ?? readString(model.baseUrl);
    const modelId = readString(model.model) ?? readString(model.modelId) ?? readString(model.id) ?? "unknown";
    const providerId = readString(model.providerId) ?? readString(model.provider) ?? "unknown";
    if (!baseURL) {
      return [
        {
          modelId,
          providerId,
          protocol,
          configured: model.configured === true,
          basePathDropRisk: false,
        },
      ];
    }
    try {
      const parsed = new URL(baseURL);
      const baseUrlPath = normalizeUrlPath(parsed.pathname);
      const safeChatCompletionsUrl = appendPathToBaseUrl(parsed, "chat/completions");
      const absolutePathChatCompletionsUrl = new URL("/chat/completions", ensureTrailingSlash(parsed.toString())).toString();
      const basePathDropRisk =
        /openai-compatible/i.test(protocol) &&
        baseUrlPath !== "/" &&
        safeChatCompletionsUrl !== absolutePathChatCompletionsUrl;
      return [
        {
          modelId,
          providerId,
          protocol,
          configured: model.configured === true,
          baseURL,
          baseUrlPath,
          safeChatCompletionsUrl,
          absolutePathChatCompletionsUrl,
          basePathDropRisk,
        },
      ];
    } catch {
      return [
        {
          modelId,
          providerId,
          protocol,
          configured: model.configured === true,
          baseURL,
          basePathDropRisk: false,
        },
      ];
    }
  });
}

function readConfiguredModelRecords(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => readConfiguredModelRecords(item));
  const record = value as Record<string, unknown>;
  const direct = record.configured === true ? [record] : [];
  const nested = Array.isArray(record.models) ? record.models.flatMap((item) => readConfiguredModelRecords(item)) : [];
  return [...direct, ...nested];
}

function appendPathToBaseUrl(baseUrl: URL, suffix: string): string {
  const copy = new URL(baseUrl.toString());
  const basePath = copy.pathname.replace(/\/+$/g, "");
  copy.pathname = `${basePath}/${suffix}`.replace(/\/+/g, "/");
  return copy.toString();
}

function normalizeUrlPath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/g, "");
  return normalized ? normalized : "/";
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function hasConfiguredModel(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => hasConfiguredModel(item));
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.models)) {
    return record.models.some((model) => {
      if (typeof model !== "object" || model === null) return false;
      const modelRecord = model as Record<string, unknown>;
      return (
        modelRecord.configured === true &&
        hasKnownString(modelRecord.providerId ?? modelRecord.provider) &&
        hasKnownString(modelRecord.model ?? modelRecord.modelId ?? modelRecord.id)
      );
    });
  }
  return Object.values(record).some((item) => hasConfiguredModel(item));
}

function readThreadId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { thread?: { threadId?: unknown }; threadId?: unknown };
  return readString(record.thread?.threadId) ?? readString(record.threadId);
}

function readLatestAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; content?: unknown; text?: unknown };
    if (readString(record.role) !== "assistant") continue;
    const text = readMessageText(record.content) ?? readString(record.text);
    if (text) return text;
  }
  return "";
}

function readMessageText(value: unknown): string | null {
  if (typeof value === "string") return readString(value);
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const text = readString((part as { text?: unknown }).text);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/g, "");
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
  return value;
}

function readPositiveInteger(value: string, arg: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${arg} must be a positive integer`);
  return parsed;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasKnownString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !/^(unknown|n\/a|null|undefined)$/i.test(value.trim());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRealLlmAbReferencePreflightCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
