import {
  getInstructions,
  getRecentMessages,
  getRelayBrief,
} from "@turnkeyai/core-types/team";
import type {
  BrowserBridge,
  BrowserPageResult,
  TransportExecutionAudit,
  TransportKind,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
  WorkerSessionHistoryEntry,
} from "@turnkeyai/core-types/team";

interface ExploreWorkerHandlerOptions {
  browserBridge?: Pick<BrowserBridge, "inspectPublicPage">;
  fetchFn?: typeof fetch;
  allowLoopbackHosts?: boolean;
}

export class ExploreWorkerHandler implements WorkerHandler {
  readonly kind = "explore" as const;
  private readonly browserBridge: Pick<BrowserBridge, "inspectPublicPage"> | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly allowLoopbackHosts: boolean;

  constructor(options: ExploreWorkerHandlerOptions = {}) {
    this.browserBridge = options.browserBridge;
    this.fetchFn = options.fetchFn ?? fetch;
    this.allowLoopbackHosts = options.allowLoopbackHosts === true;
  }

  async canHandle(input: WorkerInvocationInput): Promise<boolean> {
    if (input.packet.preferredWorkerKinds?.includes("explore")) {
      return true;
    }

    const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
    if (!role) {
      return false;
    }

    const capabilities = new Set(role.capabilities ?? []);
    return capabilities.has("explore") || /explore|research|analyst/i.test(role.name);
  }

  async run(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null> {
    throwIfAborted(input.signal);
    const preferredOrder = resolvePreferredTransportOrder(input);
    if (shouldSynthesizeFromExistingExploreEvidence(input)) {
      const priorEvidence = extractPriorExploreEvidence(input);
      if (priorEvidence) {
        return buildExploreContinuationSynthesis(input, priorEvidence, preferredOrder);
      }
    }

    const targets = resolveExploreTargets(input);
    if (targets.length === 0) {
      return null;
    }

    if (targets.length > 1 && targets.every((target) => target.kind === "page")) {
      return this.runMultiplePageTargets(input, targets, preferredOrder);
    }

    const target = targets[0]!;
    const apiAttempt = {
      apiName: target.label,
      operation: target.kind === "search" ? "web_search_results" : "fetch_public_page",
      transport: (target.kind === "search" ? "business_tool" : "official_api") as TransportKind,
      credentialState: "present" as const,
    };
    let safeUrl: string;

    try {
      safeUrl = validatePublicHttpUrl(target.url, { allowLoopbackHosts: this.allowLoopbackHosts });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "invalid target URL";
      const browserFallbackAllowed = canUseBrowserFallback(input);
      if (isBlockedExploreHostError(errorMessage) && this.browserBridge && browserFallbackAllowed) {
        return this.runBrowserFallback(
          input,
          target,
          apiAttempt,
          { errorMessage },
          preferredOrder
        );
      }

      if (isBlockedExploreHostError(errorMessage) && this.browserBridge && !browserFallbackAllowed) {
        return {
          workerType: this.kind,
          status: "failed",
          summary: `Explore worker failed to fetch ${target.label}: browser fallback is not allowed for this activation`,
          payload: {
            trace: [],
            transportAudit: buildTransportAudit({
              preferredOrder,
              attemptedTransports: [],
              fallbackReason: "browser fallback blocked by capability inspection",
              trustLevel: "observational",
            }),
            apiAttempt: {
              ...apiAttempt,
              errorMessage,
            },
          },
        };
      }

      return {
        workerType: this.kind,
        status: "failed",
        summary: `Explore worker failed to fetch ${target.label}: ${errorMessage}`,
        payload: {
          trace: [],
          transportAudit: buildTransportAudit({
            preferredOrder,
            attemptedTransports: [],
            fallbackReason: errorMessage,
            trustLevel: "observational",
          }),
          apiAttempt: {
            ...apiAttempt,
            errorMessage,
          },
        },
      };
    }

    try {
      const { response, finalUrl } = await fetchWithValidation(this.fetchFn, safeUrl, input.signal, {
        allowLoopbackHosts: this.allowLoopbackHosts,
      });
      throwIfAborted(input.signal);
      const html = await response.text();
      const page = toPageResult(target.url, finalUrl, response.status, html);
      if (target.kind === "search" && response.ok && !looksBlocked(page)) {
        const searchResults = extractDuckDuckGoResults(html);
        if (searchResults.length === 0) {
          return {
            workerType: this.kind,
            status: "failed",
            summary: `Explore worker search returned no usable results for ${target.query}.`,
            payload: {
              page,
              searchResults: [],
              findings: [],
              trace: [],
              transportAudit: buildTransportAudit({
                preferredOrder,
                attemptedTransports: ["business_tool"],
                finalTransport: "business_tool",
                fallbackReason: "search provider returned no parseable results",
                trustLevel: "observational",
              }),
              apiAttempt: {
                ...apiAttempt,
                statusCode: response.status,
                responseBody: {
                  title: page.title,
                  excerpt: page.textExcerpt,
                },
                errorMessage: "search provider returned no parseable results",
              },
            },
          };
        }
        const findings = searchResults.map((item) => `${item.title} — ${item.url}${item.snippet ? ` — ${item.snippet}` : ""}`);
        return {
          workerType: this.kind,
          status: "completed",
          summary: [
            `Explore worker searched ${target.query}.`,
            ...findings.slice(0, 5).map((item, index) => `${index + 1}. ${item}`),
          ].join("\n"),
          payload: {
            page,
            searchResults,
            findings,
            trace: [
              {
                stepId: `${input.activation.handoff.taskId}:explore-search`,
                kind: "open",
                startedAt: Date.now(),
                completedAt: Date.now(),
                status: "ok",
                input: { query: target.query, url: target.url },
                output: {
                  finalUrl: page.finalUrl,
                  resultCount: searchResults.length,
                },
              },
            ],
            transportAudit: buildTransportAudit({
              preferredOrder,
              attemptedTransports: ["business_tool"],
              finalTransport: "business_tool",
              trustLevel: "observational",
            }),
            apiAttempt: {
              ...apiAttempt,
              statusCode: response.status,
              responseBody: {
                title: page.title,
                excerpt: findings.slice(0, 5).join("\n"),
              },
            },
          },
        };
      }
      const browserFallbackAllowed = canUseBrowserFallback(input);
      const fallbackReason = response.ok
        ? "direct fetch returned blocked content"
        : `direct fetch returned HTTP ${response.status}`;

      if ((!response.ok || looksBlocked(page)) && this.browserBridge && browserFallbackAllowed) {
        return this.runBrowserFallback(input, target, apiAttempt, {
          statusCode: response.status,
          responseBody: {
            title: page.title,
            excerpt: page.textExcerpt,
          },
          errorMessage: fallbackReason,
        }, preferredOrder);
      }

      if ((!response.ok || looksBlocked(page)) && this.browserBridge && !browserFallbackAllowed) {
        return {
          workerType: this.kind,
          status: "failed",
          summary: `Explore worker could not fetch ${target.label}: browser fallback is not allowed for this activation`,
          payload: {
            page,
            trace: [],
            transportAudit: buildTransportAudit({
              preferredOrder,
              attemptedTransports: [apiAttempt.transport],
              finalTransport: apiAttempt.transport,
              fallbackReason: "browser fallback blocked by capability inspection",
              trustLevel: "observational",
            }),
            apiAttempt: {
              ...apiAttempt,
              statusCode: response.status,
              responseBody: {
                title: page.title,
                excerpt: page.textExcerpt,
              },
              errorMessage: fallbackReason,
            },
          },
        };
      }

      if (looksBlocked(page)) {
        return {
          workerType: this.kind,
          status: "failed",
          summary: `Explore worker could not fetch ${target.label}: direct fetch returned blocked content`,
          payload: {
            page,
            trace: [],
            transportAudit: buildTransportAudit({
              preferredOrder,
              attemptedTransports: [apiAttempt.transport],
              finalTransport: apiAttempt.transport,
              fallbackReason: "direct fetch returned blocked content",
              trustLevel: "observational",
            }),
            apiAttempt: {
              ...apiAttempt,
              statusCode: response.status,
              responseBody: {
                title: page.title,
                excerpt: page.textExcerpt,
              },
              errorMessage: "direct fetch returned blocked content",
            },
          },
        };
      }

      if (!response.ok) {
        return {
          workerType: this.kind,
          status: "failed",
          summary: `Explore worker could not fetch ${target.label}: HTTP ${response.status}`,
          payload: {
            page,
            trace: [],
            transportAudit: buildTransportAudit({
              preferredOrder,
              attemptedTransports: [apiAttempt.transport],
              finalTransport: apiAttempt.transport,
              fallbackReason,
              trustLevel: "observational",
            }),
            apiAttempt: {
              ...apiAttempt,
              statusCode: response.status,
              responseBody: {
                title: page.title,
                excerpt: page.textExcerpt,
              },
            },
          },
        };
      }

      const findings = extractPriceLines(page.textExcerpt);

      return {
        workerType: this.kind,
        status: "completed",
        summary: [
          `Explore worker fetched ${target.label}.`,
          `Final URL: ${page.finalUrl}.`,
          `Title: ${page.title || "(none)"}.`,
          findings.length > 0 ? `Price lines: ${findings.join(" | ")}` : `Excerpt: ${page.textExcerpt}`,
        ].join("\n"),
        payload: {
          page,
          findings,
          trace: [
            {
              stepId: `${input.activation.handoff.taskId}:explore-fetch`,
              kind: "open",
              startedAt: Date.now(),
              completedAt: Date.now(),
              status: "ok",
              input: { url: target.url },
              output: {
                finalUrl: page.finalUrl,
                statusCode: page.statusCode,
              },
            },
          ],
          transportAudit: buildTransportAudit({
            preferredOrder,
            attemptedTransports: [apiAttempt.transport],
            finalTransport: apiAttempt.transport,
            trustLevel: "promotable",
          }),
          apiAttempt: {
            ...apiAttempt,
            statusCode: response.status,
            responseBody: {
              title: page.title,
              excerpt: page.textExcerpt,
            },
          },
        },
      };
    } catch (error) {
      const browserFallbackAllowed = canUseBrowserFallback(input);
      if (this.browserBridge && browserFallbackAllowed) {
        return this.runBrowserFallback(input, target, apiAttempt, {
          errorMessage: error instanceof Error ? error.message : "fetch failed",
        }, preferredOrder);
      }

      if (this.browserBridge && !browserFallbackAllowed) {
        return {
          workerType: this.kind,
          status: "failed",
          summary: `Explore worker failed to fetch ${target.label}: browser fallback is not allowed for this activation`,
          payload: {
            trace: [],
            transportAudit: buildTransportAudit({
              preferredOrder,
              attemptedTransports: [apiAttempt.transport],
              fallbackReason: "browser fallback blocked by capability inspection",
              trustLevel: "observational",
            }),
            apiAttempt: {
              ...apiAttempt,
              errorMessage: error instanceof Error ? error.message : "fetch failed",
            },
          },
        };
      }

      return {
        workerType: this.kind,
        status: "failed",
        summary: `Explore worker failed to fetch ${target.label}: ${error instanceof Error ? error.message : "unknown error"}`,
        payload: {
          trace: [],
          transportAudit: buildTransportAudit({
            preferredOrder,
            attemptedTransports: [apiAttempt.transport],
            fallbackReason: error instanceof Error ? error.message : "fetch failed",
            trustLevel: "observational",
          }),
          apiAttempt: {
            ...apiAttempt,
            errorMessage: error instanceof Error ? error.message : "fetch failed",
          },
        },
      };
    }
  }

  private async runMultiplePageTargets(
    input: WorkerInvocationInput,
    targets: Array<Extract<ExploreTarget, { kind: "page" }>>,
    preferredOrder: TransportKind[]
  ): Promise<WorkerExecutionResult> {
    const sourceResults: Array<{
      url: string;
      label: string;
      status: "completed" | "partial" | "failed";
      page?: BrowserPageResult;
      findings: string[];
      errorMessage?: string;
      transport?: TransportKind;
    }> = [];
    const apiAttempts: Array<Record<string, unknown>> = [];
    const trace: Array<Record<string, unknown>> = [];
    const attemptedTransports = new Set<TransportKind>();

    for (const [index, target] of targets.entries()) {
      throwIfAborted(input.signal);
      const apiAttempt = {
        apiName: target.label,
        operation: "fetch_public_page",
        transport: "official_api" as TransportKind,
        credentialState: "present" as const,
      };

      let safeUrl: string;
      try {
        safeUrl = validatePublicHttpUrl(target.url, { allowLoopbackHosts: this.allowLoopbackHosts });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "invalid target URL";
        const browserFallbackAllowed = canUseBrowserFallback(input);
        if (isBlockedExploreHostError(errorMessage) && this.browserBridge && browserFallbackAllowed) {
          attemptedTransports.add(apiAttempt.transport);
          attemptedTransports.add("browser");
          const fallback = await this.runBrowserFallback(
            input,
            target,
            apiAttempt,
            { errorMessage },
            preferredOrder
          );
          const payload = fallback.payload as {
            page?: BrowserPageResult;
            findings?: string[];
            trace?: Array<Record<string, unknown>>;
            apiAttempt?: Record<string, unknown>;
          };
          sourceResults.push({
            url: target.url,
            label: target.label,
            status: "partial",
            ...(payload.page ? { page: payload.page } : {}),
            findings: payload.findings ?? [],
            transport: "browser",
          });
          if (payload.trace) trace.push(...payload.trace);
          if (payload.apiAttempt) apiAttempts.push(payload.apiAttempt);
          continue;
        }

        sourceResults.push({
          url: target.url,
          label: target.label,
          status: "failed",
          findings: [],
          errorMessage,
          transport: apiAttempt.transport,
        });
        apiAttempts.push({ ...apiAttempt, errorMessage });
        continue;
      }

      attemptedTransports.add(apiAttempt.transport);
      try {
        const { response, finalUrl } = await fetchWithValidation(this.fetchFn, safeUrl, input.signal, {
          allowLoopbackHosts: this.allowLoopbackHosts,
        });
        throwIfAborted(input.signal);
        const html = await response.text();
        const page = toPageResult(target.url, finalUrl, response.status, html);
        const fallbackReason = response.ok
          ? "direct fetch returned blocked content"
          : `direct fetch returned HTTP ${response.status}`;

        if ((!response.ok || looksBlocked(page)) && this.browserBridge && canUseBrowserFallback(input)) {
          attemptedTransports.add("browser");
          const fallback = await this.runBrowserFallback(
            input,
            target,
            apiAttempt,
            {
              statusCode: response.status,
              responseBody: {
                title: page.title,
                excerpt: page.textExcerpt,
              },
              errorMessage: fallbackReason,
            },
            preferredOrder
          );
          const payload = fallback.payload as {
            page?: BrowserPageResult;
            findings?: string[];
            trace?: Array<Record<string, unknown>>;
            apiAttempt?: Record<string, unknown>;
          };
          sourceResults.push({
            url: target.url,
            label: target.label,
            status: "partial",
            ...(payload.page ? { page: payload.page } : {}),
            findings: payload.findings ?? [],
            transport: "browser",
          });
          if (payload.trace) trace.push(...payload.trace);
          if (payload.apiAttempt) apiAttempts.push(payload.apiAttempt);
          continue;
        }

        if (!response.ok || looksBlocked(page)) {
          sourceResults.push({
            url: target.url,
            label: target.label,
            status: "failed",
            page,
            findings: [],
            errorMessage: fallbackReason,
            transport: apiAttempt.transport,
          });
          apiAttempts.push({
            ...apiAttempt,
            statusCode: response.status,
            responseBody: {
              title: page.title,
              excerpt: page.textExcerpt,
            },
            errorMessage: fallbackReason,
          });
          continue;
        }

        const findings = extractPriceLines(page.textExcerpt);
        sourceResults.push({
          url: target.url,
          label: target.label,
          status: "completed",
          page,
          findings,
          transport: apiAttempt.transport,
        });
        trace.push({
          stepId: `${input.activation.handoff.taskId}:explore-fetch-${index + 1}`,
          kind: "open",
          startedAt: Date.now(),
          completedAt: Date.now(),
          status: "ok",
          input: { url: target.url },
          output: {
            finalUrl: page.finalUrl,
            statusCode: page.statusCode,
          },
        });
        apiAttempts.push({
          ...apiAttempt,
          statusCode: response.status,
          responseBody: {
            title: page.title,
            excerpt: page.textExcerpt,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "fetch failed";
        if (this.browserBridge && canUseBrowserFallback(input)) {
          attemptedTransports.add("browser");
          const fallback = await this.runBrowserFallback(input, target, apiAttempt, { errorMessage }, preferredOrder);
          const payload = fallback.payload as {
            page?: BrowserPageResult;
            findings?: string[];
            trace?: Array<Record<string, unknown>>;
            apiAttempt?: Record<string, unknown>;
          };
          sourceResults.push({
            url: target.url,
            label: target.label,
            status: "partial",
            ...(payload.page ? { page: payload.page } : {}),
            findings: payload.findings ?? [],
            transport: "browser",
          });
          if (payload.trace) trace.push(...payload.trace);
          if (payload.apiAttempt) apiAttempts.push(payload.apiAttempt);
          continue;
        }

        sourceResults.push({
          url: target.url,
          label: target.label,
          status: "failed",
          findings: [],
          errorMessage,
          transport: apiAttempt.transport,
        });
        apiAttempts.push({ ...apiAttempt, errorMessage });
      }
    }

    const completedCount = sourceResults.filter((item) => item.status === "completed" || item.status === "partial").length;
    const failedResults = sourceResults.filter((item) => item.status === "failed");
    const status: WorkerExecutionResult["status"] =
      completedCount === targets.length && failedResults.length === 0
        ? "completed"
        : completedCount > 0
          ? "partial"
          : "failed";
    const pages = sourceResults.flatMap((item) => (item.page ? [item.page] : []));
    const findings = sourceResults.flatMap((item) =>
      item.findings.map((finding) => `${item.label}: ${finding}`)
    );

    return {
      workerType: this.kind,
      status,
      summary: [
        `Explore worker fetched ${completedCount} of ${targets.length} sources.`,
        ...sourceResults.map((item, index) => {
          if (item.page) {
            const evidence = item.findings.length > 0
              ? `Price lines: ${item.findings.join(" | ")}`
              : `Excerpt: ${item.page.textExcerpt}`;
            return [
              `${index + 1}. ${item.label}`,
              `Final URL: ${item.page.finalUrl}.`,
              `Title: ${item.page.title || "(none)"}.`,
              evidence,
            ].join(" ");
          }
          return `${index + 1}. ${item.label} failed: ${item.errorMessage ?? "unknown error"}`;
        }),
      ].join("\n"),
      payload: {
        ...(pages[0] ? { page: pages[0] } : {}),
        pages,
        findings,
        sourceResults,
        trace,
        transportAudit: buildTransportAudit({
          preferredOrder,
          attemptedTransports: Array.from(attemptedTransports),
          finalTransport: attemptedTransports.has("browser") ? "browser" : "official_api",
          ...(failedResults.length > 0
            ? { fallbackReason: `failed sources: ${failedResults.map((item) => item.label).join(", ")}` }
            : {}),
          trustLevel: status === "completed" && !attemptedTransports.has("browser") ? "promotable" : "observational",
        }),
        ...(apiAttempts[0] ? { apiAttempt: apiAttempts[0] } : {}),
        apiAttempts,
      },
    };
  }

  private async runBrowserFallback(
    input: WorkerInvocationInput,
    target: { url: string; label: string },
    apiAttempt: {
      apiName: string;
      operation: string;
      transport: TransportKind;
      credentialState: "present";
    },
    failureContext: Record<string, unknown>,
    preferredOrder: TransportKind[]
  ): Promise<WorkerExecutionResult> {
    throwIfAborted(input.signal);
    const browserPage = await raceAbort(
      this.browserBridge!.inspectPublicPage(target.url),
      input.signal,
      "explore worker cancelled"
    );
    return {
      workerType: this.kind,
      status: "partial",
      summary: [
        `Explore worker fell back to browser for ${target.label}.`,
        `Final URL: ${browserPage.finalUrl}.`,
        `Title: ${browserPage.title || "(none)"}.`,
        `Excerpt: ${browserPage.textExcerpt}`,
      ].join("\n"),
      payload: {
        page: browserPage,
        findings: extractPriceLines(browserPage.textExcerpt),
        transportAudit: buildTransportAudit({
          preferredOrder,
          attemptedTransports: [apiAttempt.transport, "browser"],
          finalTransport: "browser",
          fallbackReason:
            typeof failureContext.errorMessage === "string"
              ? failureContext.errorMessage
              : "direct transport could not complete the request",
          trustLevel: "observational",
        }),
        trace: [
          {
            stepId: `${input.activation.handoff.taskId}:explore-browser-fallback`,
            kind: "open",
            startedAt: Date.now(),
            completedAt: Date.now(),
            status: "ok",
            input: { url: target.url },
            output: {
              finalUrl: browserPage.finalUrl,
              statusCode: browserPage.statusCode,
            },
          },
        ],
        apiAttempt: {
          ...apiAttempt,
          ...failureContext,
        },
      },
    };
  }
}

type ExploreTarget =
  | { kind: "page"; url: string; label: string }
  | { kind: "search"; url: string; label: string; query: string };

function resolveExploreTargets(input: WorkerInvocationInput): ExploreTarget[] {
  const sourceText = [
    input.packet.taskPrompt,
    getInstructions(input.activation.handoff.payload),
    getRelayBrief(input.activation.handoff.payload),
    ...getRecentMessages(input.activation.handoff.payload).map((item) => item.content),
  ]
    .filter(Boolean)
    .join("\n");

  const explicitUrls = extractExplicitUrls(sourceText);
  if (explicitUrls.length > 0) {
    return explicitUrls.map((explicitUrl) => ({
      kind: "page",
      url: explicitUrl,
      label: explicitUrl,
    }));
  }

  if (/openai/i.test(sourceText) && /pricing|price|api/i.test(sourceText)) {
    return [{
      kind: "page",
      url: "https://openai.com/api/pricing/",
      label: "openai-pricing",
    }];
  }

  const searchQuery = extractExploreSearchQuery(sourceText);
  if (searchQuery) {
    return [{
      kind: "search",
      url: `https://duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`,
      label: `search:${searchQuery}`,
      query: searchQuery,
    }];
  }

  return [];
}

function extractExplicitUrls(sourceText: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of sourceText.matchAll(/https?:\/\/[^\s<>)]+/gi)) {
    const rawCandidate = match[0] ?? "";
    if (/…|%E2%80%A6|\.\.\./i.test(rawCandidate)) {
      continue;
    }
    const candidate = rawCandidate.replace(/["'`\],;:.!?。，“”‘’！？：]+$/g, "");
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    try {
      const parsed = new URL(candidate);
      if (isEvidenceSummaryPseudoUrl(parsed)) {
        continue;
      }
    } catch {
      continue;
    }
    seen.add(candidate);
    urls.push(candidate);
  }
  return urls;
}

interface PriorExploreEvidence {
  pages: BrowserPageResult[];
  sourceResults: Array<{
    url: string;
    label: string;
    status: "completed" | "partial" | "failed";
    page?: BrowserPageResult;
    findings: string[];
    errorMessage?: string;
    transport?: TransportKind;
  }>;
  findings: string[];
}

function shouldSynthesizeFromExistingExploreEvidence(input: WorkerInvocationInput): boolean {
  if (input.packet.continuityMode !== "resume-existing" || !input.sessionState) {
    return false;
  }

  const currentTask = stripContinuationContext(input.packet.taskPrompt);
  return /revisit|notes?|decision note|synthesi[sz]e|turn the evidence|previous work|same .*research thread|source-bounded/i.test(currentTask);
}

function stripContinuationContext(taskPrompt: string): string {
  return taskPrompt.split(/\n\s*Continuation context:/i)[0] ?? taskPrompt;
}

function extractPriorExploreEvidence(input: WorkerInvocationInput): PriorExploreEvidence | null {
  const evidence: PriorExploreEvidence = { pages: [], sourceResults: [], findings: [] };
  const seenPages = new Set<string>();
  const seenSources = new Set<string>();
  const seenFindings = new Set<string>();

  const addFinding = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || seenFindings.has(trimmed)) return;
    seenFindings.add(trimmed);
    evidence.findings.push(trimmed);
  };

  const addPage = (value: unknown): BrowserPageResult | null => {
    const page = asBrowserPageResult(value);
    if (!page) return null;
    const key = `${page.finalUrl || page.requestedUrl}:${page.title}:${page.textExcerpt.slice(0, 80)}`;
    if (!seenPages.has(key)) {
      seenPages.add(key);
      evidence.pages.push(page);
    }
    return page;
  };

  const addSourceResult = (value: unknown) => {
    if (!isRecord(value)) return;
    const url = typeof value.url === "string" ? value.url : undefined;
    const label = typeof value.label === "string" ? value.label : url;
    if (!url || !label) return;
    const status = value.status === "partial" || value.status === "failed" ? value.status : "completed";
    const page = addPage(value.page);
    const findings = Array.isArray(value.findings)
      ? value.findings.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    for (const finding of findings) addFinding(`${label}: ${finding}`);
    const key = `${url}:${label}:${status}`;
    if (seenSources.has(key)) return;
    seenSources.add(key);
    evidence.sourceResults.push({
      url,
      label,
      status,
      ...(page ? { page } : {}),
      findings,
      ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
      ...(isTransportKind(value.transport) ? { transport: value.transport } : {}),
    });
  };

  const collectPayload = (payload: unknown) => {
    if (!isRecord(payload)) return;
    addPage(payload.page);
    if (Array.isArray(payload.pages)) {
      for (const page of payload.pages) addPage(page);
    }
    if (Array.isArray(payload.sourceResults)) {
      for (const sourceResult of payload.sourceResults) addSourceResult(sourceResult);
    }
    if (Array.isArray(payload.findings)) {
      for (const finding of payload.findings) addFinding(finding);
    }
  };

  collectPayload(input.sessionState?.lastResult?.payload);
  for (const entry of input.sessionState?.history ?? []) {
    collectPayload(entry.payload);
    collectEvidenceFromHistoryContent(entry, addFinding);
  }

  if (evidence.pages.length === 0 && evidence.sourceResults.length === 0 && evidence.findings.length === 0) {
    return null;
  }

  return evidence;
}

function collectEvidenceFromHistoryContent(
  entry: WorkerSessionHistoryEntry,
  addFinding: (value: unknown) => void
): void {
  if (entry.role !== "tool" || !entry.content) return;
  const priceMatch = entry.content.match(/Pricing:\s*\$[^\n.]+(?:\.)?/i);
  if (priceMatch) addFinding(priceMatch[0]);
  const strengthMatch = entry.content.match(/Strength:\s*[^\n.]+(?:\.)?/i);
  if (strengthMatch) addFinding(strengthMatch[0]);
  const riskMatch = entry.content.match(/Risk:\s*[^\n.]+(?:\.)?/i);
  if (riskMatch) addFinding(riskMatch[0]);
}

function buildExploreContinuationSynthesis(
  input: WorkerInvocationInput,
  evidence: PriorExploreEvidence,
  preferredOrder: TransportKind[]
): WorkerExecutionResult {
  const sourceBlocks = evidence.sourceResults.length > 0
    ? evidence.sourceResults.map((source, index) => formatSourceEvidenceBlock(index + 1, source))
    : evidence.pages.map((page, index) => formatPageEvidenceBlock(index + 1, page));
  const findingLines = evidence.findings.length > 0
    ? evidence.findings.slice(0, 10).map((finding) => `- ${finding}`)
    : ["- No structured finding lines were available; use the page excerpts below as the evidence boundary."];
  const content = [
    "Reused evidence from the existing research session (no new sources fetched this turn):",
    "Evidence used:",
    ...findingLines,
    "Source boundary:",
    ...sourceBlocks,
    "Residual risk: this synthesis reuses only the already-captured sources above; treat any dimension not present in that evidence as unverified by this session, and draw the decision from the evidence rather than from prior assumptions.",
  ].join("\n");

  return {
    workerType: "explore",
    status: "completed",
    summary: [
      "Explore worker reused prior evidence from the existing session instead of fetching sources again.",
      content,
    ].join("\n"),
    payload: {
      content,
      pages: evidence.pages,
      sourceResults: evidence.sourceResults,
      findings: evidence.findings,
      trace: [
        {
          stepId: `${input.activation.handoff.taskId}:explore-continuation-synthesis`,
          kind: "synthesize",
          startedAt: Date.now(),
          completedAt: Date.now(),
          status: "ok",
          input: { continuityMode: input.packet.continuityMode },
          output: {
            pageCount: evidence.pages.length,
            sourceCount: evidence.sourceResults.length,
            findingCount: evidence.findings.length,
          },
        },
      ],
      transportAudit: buildTransportAudit({
        preferredOrder,
        attemptedTransports: [],
        trustLevel: "promotable",
      }),
    },
  };
}

function formatSourceEvidenceBlock(
  index: number,
  source: PriorExploreEvidence["sourceResults"][number]
): string {
  const page = source.page;
  const excerpt = page?.textExcerpt ? ` Excerpt: ${page.textExcerpt}` : "";
  const findings = source.findings.length > 0 ? ` Findings: ${source.findings.join(" | ")}` : "";
  return `${index}. ${source.label} (${source.status}) URL: ${page?.finalUrl ?? source.url}.${findings}${excerpt}`;
}

function formatPageEvidenceBlock(index: number, page: BrowserPageResult): string {
  return `${index}. ${page.title || page.finalUrl} URL: ${page.finalUrl}. Excerpt: ${page.textExcerpt}`;
}

function asBrowserPageResult(value: unknown): BrowserPageResult | null {
  if (!isRecord(value)) return null;
  if (typeof value.requestedUrl !== "string" || typeof value.finalUrl !== "string") return null;
  return {
    requestedUrl: value.requestedUrl,
    finalUrl: value.finalUrl,
    title: typeof value.title === "string" ? value.title : "",
    textExcerpt: typeof value.textExcerpt === "string" ? value.textExcerpt : "",
    statusCode: typeof value.statusCode === "number" ? value.statusCode : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTransportKind(value: unknown): value is TransportKind {
  return value === "official_api" || value === "business_tool" || value === "browser";
}

function isEvidenceSummaryPseudoUrl(url: URL): boolean {
  return /\/n(?:Page|Final|Title|Excerpt|Source)\b/i.test(url.pathname);
}

function extractExploreSearchQuery(sourceText: string): string | null {
  const quotedSearch = sourceText.match(/search queries? to try:\s*(?:[-*]\s*)?["“]([^"”]+)["”]/i)?.[1]?.trim();
  if (quotedSearch) return stripSearchNoise(quotedSearch);

  const explicitSearch = sourceText.match(/\bsearch:\s*(https?:\/\/\S+|[^.\n]+)/i)?.[1]?.trim();
  if (explicitSearch) return stripSearchNoise(explicitSearch);

  const quotedEntity = Array.from(sourceText.matchAll(/["“]([^"”]{2,120})["”]/g))
    .map((match) => stripSearchNoise(match[1] ?? ""))
    .find((value) => value && !/^https?:\/\//i.test(value) && !/^(not verified|completed|failed)$/i.test(value));
  if (quotedEntity) return quotedEntity;

  const searchFor = sourceText.match(/\bsearch(?:\s+for)?\s+["“]?([^"”.\n]+)["”]?/i)?.[1]?.trim();
  if (searchFor) return stripSearchNoise(searchFor);

  const research = sourceText.match(/\bresearch\s+([^.\n]+?)(?:\s+-|\s+what\b|\s+and\b|$)/i)?.[1]?.trim();
  if (research) return stripSearchNoise(research);

  return null;
}

function stripSearchNoise(value: string): string {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/["'`,;:.!?。，“”‘’！？：]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePreferredTransportOrder(input: WorkerInvocationInput): TransportKind[] {
  const explicit = input.packet.capabilityInspection?.transportPreferences.find(
    (entry) => entry.capability === "explore" || entry.capability === "research"
  );

  if (explicit?.orderedTransports?.length) {
    return explicit.orderedTransports;
  }

  return ["official_api", "business_tool", "browser"];
}

function canUseBrowserFallback(input: WorkerInvocationInput): boolean {
  const availableWorkers = input.packet.capabilityInspection?.availableWorkers;
  if (!Array.isArray(availableWorkers)) {
    return true;
  }

  return availableWorkers.includes("browser");
}

function isBlockedExploreHostError(message: string): boolean {
  return /\bblocked explore URL host:/i.test(message);
}

function buildTransportAudit(input: {
  preferredOrder: TransportKind[];
  attemptedTransports: TransportKind[];
  finalTransport?: TransportKind;
  fallbackReason?: string;
  trustLevel: TransportExecutionAudit["trustLevel"];
}): TransportExecutionAudit {
  const preferredTransport = input.preferredOrder[0];
  return {
    capability: "explore",
    preferredOrder: input.preferredOrder,
    attemptedTransports: input.attemptedTransports,
    ...(input.finalTransport ? { finalTransport: input.finalTransport } : {}),
    downgraded:
      preferredTransport != null &&
      input.finalTransport != null &&
      preferredTransport !== input.finalTransport,
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    trustLevel: input.trustLevel,
  };
}

function toPageResult(requestedUrl: string, finalUrl: string, statusCode: number, html: string): BrowserPageResult {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const textExcerpt = stripHtml(html).slice(0, 800);

  return {
    requestedUrl,
    finalUrl,
    title: titleMatch?.[1]?.trim() ?? "",
    textExcerpt,
    statusCode,
  };
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<(?:p|div|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractPriceLines(text: string): string[] {
  return text
    .split(/\n+|(?<=\.)\s+|\s{2,}/)
    .map((line) => line.trim())
    .filter((line) => /\$|\/1m|tokens?/i.test(line))
    .slice(0, 6);
}

function looksBlocked(page: BrowserPageResult): boolean {
  return (
    page.statusCode >= 400 ||
    /enable javascript|cookies to continue|captcha|access denied|please click here if you are not redirected|trouble accessing google search/i.test(
      page.textExcerpt
    )
  );
}

function extractDuckDuckGoResults(html: string): Array<{ title: string; url: string; snippet?: string }> {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];
  const blocks = html.split(/<div[^>]+class=["'][^"']*result[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) {
      continue;
    }
    const decodedUrl = decodeDuckDuckGoResultUrl(decodeHtmlEntities(titleMatch[1] ?? ""));
    if (!decodedUrl) {
      continue;
    }
    const title = decodeHtmlEntities(stripHtml(titleMatch[2] ?? ""));
    if (!title) {
      continue;
    }
    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch ? decodeHtmlEntities(stripHtml(snippetMatch[1] ?? "")) : "";
    results.push({
      title,
      url: decodedUrl,
      ...(snippet ? { snippet } : {}),
    });
    if (results.length >= 8) {
      break;
    }
  }
  return results;
}

function decodeDuckDuckGoResultUrl(href: string): string | null {
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const parsed = new URL(absolute);
    const uddg = parsed.searchParams.get("uddg");
    const candidate = uddg ?? absolute;
    return validatePublicHttpUrl(candidate);
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchWithValidation(
  fetchFn: typeof fetch,
  inputUrl: string,
  signal?: AbortSignal,
  options: { allowLoopbackHosts?: boolean } = {},
  redirectCount = 0
): Promise<{ response: Response; finalUrl: string }> {
  throwIfAborted(signal);
  const requestInit: RequestInit = {
    redirect: "manual",
    headers: {
      "user-agent": "turnkeyai/0.1",
    },
    ...(signal ? { signal } : {}),
  };
  const response = await fetchFn(inputUrl, requestInit);

  if (response.status >= 300 && response.status < 400) {
    if (redirectCount >= 3) {
      throw new Error(`too many redirects for ${inputUrl}`);
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`redirect without location for ${inputUrl}`);
    }

    const nextUrl = validatePublicHttpUrl(new URL(location, inputUrl).toString(), options);
    return fetchWithValidation(fetchFn, nextUrl, signal, options, redirectCount + 1);
  }

  return {
    response,
    finalUrl: inputUrl,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw new Error(abortReason(signal, "worker cancelled"));
}

async function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, fallbackReason: string): Promise<T> {
  work.catch(() => {
    // If cancellation wins the race, the underlying transport may still
    // reject while unwinding. Observe it so a late browser/fetch failure
    // cannot become a process-level unhandled rejection.
  });
  if (!signal) {
    return work;
  }
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(new Error(abortReason(signal, fallbackReason)));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function abortReason(signal: AbortSignal, fallback: string): string {
  return typeof signal.reason === "string" && signal.reason.trim() ? signal.reason : fallback;
}

function validatePublicHttpUrl(inputUrl: string, options: { allowLoopbackHosts?: boolean } = {}): string {
  const parsed = new URL(inputUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported explore URL protocol: ${parsed.protocol}`);
  }

  const hostname = normalizeHostnameForPrivateRangeChecks(parsed.hostname);
  const loopbackHost =
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.startsWith("127.");
  if (loopbackHost && options.allowLoopbackHosts === true) {
    return parsed.toString();
  }
  if (
    loopbackHost ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "169.254.169.254" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith("169.254.") ||
    hostname.startsWith("fe80:") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd")
  ) {
    throw new Error(`blocked explore URL host: ${hostname}`);
  }

  return parsed.toString();
}

function normalizeHostnameForPrivateRangeChecks(hostname: string): string {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return parseIpv4MappedIpv6Host(normalized) ?? normalized;
}

function parseIpv4MappedIpv6Host(hostname: string): string | null {
  const dotted = hostname.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    return dotted[1];
  }

  const hex = hostname.match(/^(?:::ffff:|::ffff:0:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) {
    return null;
  }

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return null;
  }
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}
