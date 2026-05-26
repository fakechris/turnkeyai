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
} from "@turnkeyai/core-types/team";

interface ExploreWorkerHandlerOptions {
  browserBridge?: Pick<BrowserBridge, "inspectPublicPage">;
  fetchFn?: typeof fetch;
}

export class ExploreWorkerHandler implements WorkerHandler {
  readonly kind = "explore" as const;
  private readonly browserBridge: Pick<BrowserBridge, "inspectPublicPage"> | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: ExploreWorkerHandlerOptions = {}) {
    this.browserBridge = options.browserBridge;
    this.fetchFn = options.fetchFn ?? fetch;
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
    const target = resolveExploreTarget(input);
    if (!target) {
      return null;
    }

    const preferredOrder = resolvePreferredTransportOrder(input);
    const apiAttempt = {
      apiName: target.label,
      operation: target.kind === "search" ? "web_search_results" : "fetch_public_page",
      transport: (target.kind === "search" ? "business_tool" : "official_api") as TransportKind,
      credentialState: "present" as const,
    };
    let safeUrl: string;

    try {
      safeUrl = validatePublicHttpUrl(target.url);
    } catch (error) {
      return {
        workerType: this.kind,
        status: "failed",
        summary: `Explore worker failed to fetch ${target.label}: ${error instanceof Error ? error.message : "invalid target URL"}`,
        payload: {
          trace: [],
          transportAudit: buildTransportAudit({
            preferredOrder,
            attemptedTransports: [],
            fallbackReason: error instanceof Error ? error.message : "invalid target URL",
            trustLevel: "observational",
          }),
          apiAttempt: {
            ...apiAttempt,
            errorMessage: error instanceof Error ? error.message : "invalid target URL",
          },
        },
      };
    }

    try {
      const { response, finalUrl } = await fetchWithValidation(this.fetchFn, safeUrl, input.signal);
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
              attemptedTransports: ["official_api"],
              finalTransport: "official_api",
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
              attemptedTransports: ["official_api"],
              finalTransport: "official_api",
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
            attemptedTransports: ["official_api"],
            finalTransport: "official_api",
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
              attemptedTransports: ["official_api"],
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
            attemptedTransports: ["official_api"],
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
          attemptedTransports: ["official_api", "browser"],
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

function resolveExploreTarget(input: WorkerInvocationInput): ExploreTarget | null {
  const sourceText = [
    input.packet.taskPrompt,
    getInstructions(input.activation.handoff.payload),
    getRelayBrief(input.activation.handoff.payload),
    ...getRecentMessages(input.activation.handoff.payload).map((item) => item.content),
  ]
    .filter(Boolean)
    .join("\n");

  const explicitUrl = sourceText.match(/https?:\/\/[^\s)]+/i)?.[0]?.replace(/["'`,;。，“”‘’]+$/g, "");
  if (explicitUrl) {
    return {
      kind: "page",
      url: explicitUrl,
      label: explicitUrl,
    };
  }

  if (/openai/i.test(sourceText) && /pricing|price|api/i.test(sourceText)) {
    return {
      kind: "page",
      url: "https://openai.com/api/pricing/",
      label: "openai-pricing",
    };
  }

  const searchQuery = extractExploreSearchQuery(sourceText);
  if (searchQuery) {
    return {
      kind: "search",
      url: `https://duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`,
      label: `search:${searchQuery}`,
      query: searchQuery,
    };
  }

  return null;
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
    .replace(/["'`,;。，“”‘’]+$/g, "")
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
    const title = stripHtml(titleMatch[2] ?? "");
    if (!title) {
      continue;
    }
    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";
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

    const nextUrl = validatePublicHttpUrl(new URL(location, inputUrl).toString());
    return fetchWithValidation(fetchFn, nextUrl, signal, redirectCount + 1);
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

function validatePublicHttpUrl(inputUrl: string): string {
  const parsed = new URL(inputUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported explore URL protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "169.254.169.254" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
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
