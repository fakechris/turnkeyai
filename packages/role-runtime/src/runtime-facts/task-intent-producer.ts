import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type {
  EvidenceEnvelope,
  EvidenceProvenance,
  RuntimeFactInput,
  TaskIntentFacts,
} from "./types";

type TaskIntentInput = Pick<
  RuntimeFactInput,
  "taskPrompt" | "activation" | "messages"
>;

export function produceTaskIntentEnvelope(
  input: TaskIntentInput,
): EvidenceEnvelope<"task_intent", TaskIntentFacts> {
  const taskAndContext = buildTaskFactTextContext(input);
  const taskAndContextText = taskAndContext.join("\n");
  return {
    kind: "task_intent",
    schemaVersion: 1,
    facts: {
      requestedTableColumns: resolveRequestedTableColumns(taskAndContext),
      providerSupportSchemaRequested: taskAndContext.some(
        explicitlyRequestsProviderSupportSchema,
      ),
      durableMemoryLookupProtocol: readDurableMemoryLookupProtocol(
        input.taskPrompt,
      ),
      browserVisibleEvidenceRequired:
        taskFactRequiresBrowserVisibleEvidence(taskAndContextText),
      productSignalDashboardEvidenceRequested:
        taskFactRequestsProductSignalDashboardEvidence(taskAndContextText),
      timeoutRecoveryRequested:
        taskFactRequestsTimeoutRecovery(taskAndContextText),
      sourceCheckContinuationRequested:
        taskFactLooksLikeSourceCheckContinuation(input.taskPrompt),
      awaitingContextSetupOnly: taskPromptRequestsAwaitingContextSetup(
        input.taskPrompt,
      ),
      requiredIndependentEvidenceStreams:
        inferTaskFactIndependentEvidenceStreamCount(input.taskPrompt),
      permissionToolsAllowed: taskFactAllowsPermissionTools(input.taskPrompt),
      approvalAlreadyApplied: taskFactApprovalAlreadyApplied(input.taskPrompt),
      approvalGatedBrowserActionRequested:
        taskFactRequestsApprovalGatedBrowserAction(input.taskPrompt),
      approvalWaitTimeoutCloseoutRequested:
        taskFactRequestsApprovalWaitTimeoutCloseout(input.taskPrompt),
      stopAtPendingApprovalAllowed:
        taskFactAllowsStoppingAtPendingApproval(input.taskPrompt),
      appliedApprovalBrowserContinuation:
        taskFactIsAppliedApprovalBrowserContinuation(input.taskPrompt),
      coverageCriticalDelegation:
        taskFactIsCoverageCriticalDelegation(input.taskPrompt),
      providerSearchPricingResearch:
        taskFactIsProviderSearchPricingResearch(input.taskPrompt),
      explicitSessionContinuationRequested:
        taskFactLooksLikeExplicitSessionContinuation(input.taskPrompt),
      exactFinalAnswerShapeExpected:
        taskFactExpectsExactFinalAnswerShape(input.taskPrompt),
    },
    provenance: buildTaskIntentProvenance(input),
  };
}

function buildTaskIntentProvenance(
  input: TaskIntentInput,
): EvidenceProvenance[] {
  const provenance: EvidenceProvenance[] = [
    {
      source: "task_prompt",
      toolName: null,
      toolCallId: null,
      roundIndex: null,
      traceIndex: null,
      messageIndex: null,
    },
  ];
  if (input.activation?.handoff.payload.intent) {
    provenance.push({
      source: "activation",
      toolName: null,
      toolCallId: null,
      roundIndex: null,
      traceIndex: null,
      messageIndex: null,
    });
  }
  input.messages.forEach((message, index) => {
    if (message.role !== "user") return;
    if (!readTaskFactMessageContentText(message.content).trim()) return;
    provenance.push({
      source: "message",
      toolName: null,
      toolCallId: null,
      roundIndex: null,
      traceIndex: null,
      messageIndex: index,
    });
  });
  return provenance;
}

export function resolveRequestedTableColumns(texts: string[]): string[] {
  const inferred = inferRequestedTableColumns(texts);
  const providerColumns = inferEvidenceSensitiveProviderTableColumns(texts);
  if (providerColumns.length === 0) {
    return inferred;
  }
  if (inferred.length === 0) {
    return providerColumns;
  }
  const normalized = inferred.map((column) => column.toLowerCase());
  const hasProvider = normalized.some((column) => column.includes("provider"));
  const hasSearch = normalized.some((column) =>
    /search|web_search|搜索/.test(column),
  );
  const hasPrice =
    normalized.some((column) =>
      /price|pricing|价格|定价|输入|input/.test(column),
    ) &&
    normalized.some((column) =>
      /price|pricing|价格|定价|输出|output/.test(column),
    );
  const hasEvidence =
    normalized.some((column) => /url|证据|source/.test(column)) &&
    normalized.some((column) => /摘录|quote|excerpt|原文/.test(column));
  if (
    inferred.length < 5 ||
    !hasProvider ||
    !hasSearch ||
    !hasPrice ||
    !hasEvidence
  ) {
    return providerColumns;
  }
  return inferred;
}

function buildTaskFactTextContext(input: TaskIntentInput): string[] {
  return [
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ].filter((text) => text.trim().length > 0);
}

function readDurableMemoryLookupProtocol(
  taskPrompt: string,
): TaskIntentFacts["durableMemoryLookupProtocol"] {
  const lookupRequested =
    /\b(?:memory_search|durable memory lookup)\b|\b(?:use|check|search|query|retrieve|consult|look up|read)\b[\s\S]{0,40}\b(?:durable|long[- ]term) memory\b|\b(?:durable|long[- ]term) memory\b[\s\S]{0,40}\b(?:lookup|search|query|retrieval)\b|(?:使用|查询|检索|检查|读取|查看)[^\n。]{0,24}(?:持久化记忆|持久记忆|长期记忆|长程记忆)|(?:持久化记忆|持久记忆|长期记忆|长程记忆)(?:查询|检索)/i.test(
      taskPrompt,
    );
  if (!lookupRequested) return "none";
  const candidateInspectionRequested =
    /\b(?:memory_get|inspect (?:any|the|a) candidate memory(?: entry)?|inspect (?:the )?(?:matching|selected|specific) memory(?: entry)?|fetch (?:the )?(?:matching|selected|specific) memory(?: entry)?|verify (?:the )?(?:candidate|matching|selected) memory(?: entry)?)\b|(?:检查|查看|读取|核验)(?:候选|匹配|选中|具体)?(?:的)?(?:持久化|长期|长程)?记忆(?:条目)?/i.test(
      taskPrompt,
    );
  return candidateInspectionRequested ? "search_and_get" : "search";
}

function taskFactRequestsProductSignalDashboardEvidence(text: string): boolean {
  return /\b(?:product-signals|live signal dashboard|product signal dashboard)\b/i.test(
    text,
  );
}

function taskFactRequiresBrowserVisibleEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (
    !normalized ||
    taskFactExplicitlyDisclaimsBrowserRenderedEvidence(normalized)
  ) {
    return false;
  }
  return (
    /\b(?:browser-visible|browser rendered|browser-rendered|browser-observed|as (?:a|an) (?:user|operator) would see|user-visible|visible page|rendered page|rendered DOM|client[- ]side|JavaScript-rendered|JS-rendered|dynamic dashboard|live dashboard)\b/i.test(
      normalized,
    ) ||
    /\b(?:rendered browser page|browser page rendered|fully render(?:ed)?|rendered values?|visible values?|exact visible text|exact visible values?)\b/i.test(
      normalized,
    ) ||
    /\b(?:in (?:the )?browser|browser session|browser worker)\b/i.test(
      normalized,
    ) ||
    /\b(?:live signal|signal dashboard|real-time indicators?|visible metrics?|metrics? dashboards?)\b/i.test(
      normalized,
    ) ||
    /\b(?:dashboards?|metrics?|signal values?)\b[\s\S]{0,120}\bshown on (?:the )?page\b/i.test(
      normalized,
    ) ||
    /\b(?:iframe|embedded source frame|frame content|shadow(?:-style)? component|shadow DOM|details popup|popup workflow|open the details popup)\b/i.test(
      normalized,
    )
  );
}

function taskFactExplicitlyDisclaimsBrowserRenderedEvidence(
  text: string,
): boolean {
  return (
    /\b(?:not|never)\s+(?:a\s+)?(?:browser-visible|browser-rendered|browser rendered|browser-observed|user-visible)\b/i.test(
      text,
    ) ||
    /\b(?:no|without)\s+(?:client[- ]side|JavaScript-rendered|JS-rendered|rendered DOM|browser-rendered|browser rendered|browser-visible)\s+(?:rendering|content|evidence|required|needed)?\b/i.test(
      text,
    ) ||
    /\bstatic HTML only\b[\s\S]{0,80}\b(?:no|without)\s+(?:JavaScript|JS|client[- ]side|browser-rendered|browser rendered)\b/i.test(
      text,
    )
  );
}

function taskFactRequestsTimeoutRecovery(text: string): boolean {
  return (
    /\b(?:continue|resume|retry|recover|recovered|recovery|follow-?up)\b|继续|恢复|重试/i.test(
      text,
    ) &&
    /\b(?:timeout|timed[- ]out|bounded attempt|slow[- ]source|source[- ]check)\b|超时/i.test(
      text,
    )
  );
}

function taskFactLooksLikeSourceCheckContinuation(taskPrompt: string): boolean {
  return (
    /\b(?:slow-source|slow source|slow-fixture|slow fixture|source-check|source check)\b/i.test(
      taskPrompt,
    ) &&
    /\b(?:continue|retry|resume|recovered|recovery|follow-?up|same source-check context|same source check context|existing source-check context|existing source check context)\b/i.test(
      taskPrompt,
    ) &&
    /\b(?:timeout|timed out|bounded attempt|release-risk|release risk|risk note|residual risk)\b/i.test(
      taskPrompt,
    )
  );
}

function taskFactAllowsPermissionTools(taskPrompt: string): boolean {
  if (taskFactDisclaimsApprovalGatedBrowserAction(taskPrompt)) {
    return false;
  }
  return (
    /\b(?:permission_(?:query|result|applied)|permission\.(?:query|result|applied)|approval_id|approval id|pending approval|operator approval|operator decision|approval (?:gate|request|decision|granted|approved|denied|applied)|approved action|denied action)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:approve|approved|approval|permission|operator review)\b[\s\S]{0,180}\b(?:submit|submission|form|click|mutat(?:e|ion)|side[- ]effects?|browser\.form\.submit|apply|execute|dry[- ]run)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:submit|submission|form|click|mutat(?:e|ion)|side[- ]effects?|browser\.form\.submit|apply|execute|dry[- ]run)\b[\s\S]{0,180}\b(?:approve|approved|approval|permission|operator review)\b/i.test(
      taskPrompt,
    )
  );
}

function taskFactApprovalAlreadyApplied(taskPrompt: string): boolean {
  return /\b(?:runtime\s+)?permission cache\b[\s\S]{0,120}\balready applied\b|\bpermission\.applied\b|\bpermission_applied\b/i.test(
    taskPrompt,
  );
}

function taskFactRequestsApprovalGatedBrowserAction(
  taskPrompt: string,
): boolean {
  if (taskFactDisclaimsApprovalGatedBrowserAction(taskPrompt)) {
    return false;
  }
  return (
    /\bapproval\b/i.test(taskPrompt) &&
    /\bbrowser\b/i.test(taskPrompt) &&
    taskFactLooksApprovalGatedBrowserSideEffect(taskPrompt) &&
    taskFactBrowserSpawnPerformsMutatingAction(taskPrompt)
  );
}

function taskFactDisclaimsApprovalGatedBrowserAction(
  taskPrompt: string,
): boolean {
  if (
    /\b(?:not\s+(?:a\s+)?form submission|not\s+(?:a\s+)?browser mutation|do not mutate|don't mutate|without mutat(?:ing|ion)|no browser mutation|no form submission)\b/i.test(
      taskPrompt,
    )
  ) {
    return true;
  }
  if (!/\bread[- ]only\b/i.test(taskPrompt)) {
    return false;
  }
  return (
    /\bno\b[^.\n]{0,180}\b(?:browser\s+)?(?:form|click|navigation|submit|submission|mutation|side[- ]effect|approval[- ]gated action)\b[^.\n]{0,120}\b(?:needed|required|necessary|will be performed|should run|is needed)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:do\s+not|don't|never)\b[^.\n]{0,180}\b(?:click|submit|submission|form|deposit|purchase|buy|order|book|reserve|save|update|delete|remove|archive|mutat(?:e|ion)|side[- ]effect|request approval|approval)\b/i.test(
      taskPrompt,
    )
  );
}

function taskFactLooksApprovalGatedBrowserSideEffect(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const hasApprovalContext =
    /\b(?:approval|approve|approved|permission|authorize|authorized|operator\s+review|gate|gated|dry-?run)\b/i.test(
      normalized,
    ) || /\bbrowser\.[a-z0-9_.-]+\b/i.test(normalized);
  const hasBrowserMutation =
    /\b(?:submit|click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in|form)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    );
  return hasApprovalContext && hasBrowserMutation;
}

function taskFactBrowserSpawnPerformsMutatingAction(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:submit|submission|form\.submit)\b[\s\S]{0,80}\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b/i.test(
      normalized,
    ) ||
    /\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b[\s\S]{0,80}\b(?:submit|submission|form\.submit)\b/i.test(
      normalized,
    ) ||
    /\b(?:click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    )
  );
}

function taskFactRequestsApprovalWaitTimeoutCloseout(
  taskPrompt: string,
): boolean {
  return (
    /\b(?:operator decision|approval|permission)\b[\s\S]{0,180}\b(?:does not arrive|doesn't arrive|does not come through|doesn't come through|no decision arrives|no approval arrives|wait timeout|wait-timeout|timed out|timeout|during this attempt|attempt cycle)\b/i.test(
      taskPrompt,
    ) ||
    /\bif\b[\s\S]{0,120}\b(?:decision|approval|permission)\b[\s\S]{0,120}\b(?:not arrive|pending|timeout|timed out|wait)\b/i.test(
      taskPrompt,
    )
  );
}

function taskFactAllowsStoppingAtPendingApproval(taskPrompt: string): boolean {
  return /\bstop\b[\s\S]{0,80}\b(?:approval request|permission request)\b[\s\S]{0,120}\b(?:wait|operator decision|approval|decision)\b|\bwait for (?:the )?operator decision\b[\s\S]{0,160}\bdo not (?:apply|submit|execute|proceed)/i.test(
    taskPrompt,
  );
}

function taskFactIsAppliedApprovalBrowserContinuation(
  taskPrompt: string,
): boolean {
  return (
    taskFactApprovalAlreadyApplied(taskPrompt) &&
    /\b(?:browser\.form\.submit|approved scoped action|approved point|operator approved|call sessions_spawn|agent_id="?browser"?|browser result|form submission|dry[- ]run)\b/i.test(
      taskPrompt,
    )
  );
}

function taskFactIsCoverageCriticalDelegation(taskPrompt: string): boolean {
  if (taskFactIsProviderSearchPricingResearch(taskPrompt)) {
    return true;
  }
  const text = taskPrompt.toLowerCase();
  const sourceCount = [
    (taskPrompt.match(/https?:\/\/\S+/g) ?? []).length,
    (text.match(/\b(?:source|evidence stream|child session|marker)\b/g) ?? [])
      .length,
  ].filter((count) => count >= 3).length;
  if (sourceCount === 0) {
    return false;
  }
  return (
    /\bdo not finalize until\b/i.test(taskPrompt) ||
    /\ball (?:three|3|\d+) (?:child session tool results|sources|source checks|evidence streams|markers)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:three|3|\d+) independent evidence streams\b/i.test(taskPrompt) ||
    /\bsource coverage\b/i.test(taskPrompt)
  );
}

function taskFactIsProviderSearchPricingResearch(taskPrompt: string): boolean {
  return (
    /\bproviders?\b|\bvendors?\b|\bplatforms?\b|供应商|服务商|厂商|平台/iu.test(
      taskPrompt,
    ) &&
    /\bweb\s*search\b|\bsearch\b|搜索|联网|检索/iu.test(taskPrompt) &&
    /\bpric(?:e|ing)\b|\bcosts?\b|\bfees?\b|\btokens?\b|价格|价钱|费用|收费|计费|token/iu.test(
      taskPrompt,
    )
  );
}

function taskFactLooksLikeExplicitSessionContinuation(
  taskPrompt: string,
): boolean {
  return (
    taskFactRequestsTimeoutFollowupContinuation(taskPrompt) ||
    /\b(?:continue|resume|retry|follow[- ]?up)\b[\s\S]{0,180}\b(?:existing|same|previous|prior|earlier|source[- ]check|source check|session|attempt|context)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:existing|same|previous|prior|earlier)\b[\s\S]{0,180}\b(?:continue|resume|retry|follow[- ]?up)\b/i.test(
      taskPrompt,
    )
  );
}

function taskFactRequestsTimeoutFollowupContinuation(
  taskPrompt: string,
): boolean {
  return /\b(?:slow source|bounded attempt|source does not return|doesn't return|timed out|timeout|earlier timeout|previous timeout|prior timeout)\b/i.test(
    taskPrompt,
  );
}

function taskFactExpectsExactFinalAnswerShape(taskPrompt: string): boolean {
  return /\b(?:respond with only|output only|answer only|final answer must|answer must be|use this exact final answer|exact final answer shape|valid json|json object|json array|csv only|markdown table only)\b|(?:只|仅|只需|仅需)(?:用|以)?(?:回答|输出|返回|给出)[^\n。；;]{0,24}(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*(?:行|条|句)|^\s*Final Answer\s*:/im.test(
    taskPrompt,
  );
}

function inferTaskFactIndependentEvidenceStreamCount(
  taskPrompt: string,
): number {
  if (isTaskFactTwoSourceComparisonTask(taskPrompt)) {
    return Math.min(6, uniqueTaskFactHttpUrlCount(taskPrompt));
  }
  if (/\b(?:three|3) independent evidence streams\b/i.test(taskPrompt)) {
    return 3;
  }
  if (
    /\b(?:three|3)\b[\s\S]{0,80}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:route|budget|live readiness)\b[\s\S]{0,120}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  if (
    /\bgather evidence from (?:three|3) independent child sessions\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  const sourceLineCount = taskPrompt
    .split(/\r?\n/)
    .filter((line) =>
      /^\s*(?:[-*]\s*)?(?:Research source|Capability source|Route source|Budget source|Live signal dashboard|Live readiness dashboard|[A-Z][\w -]{2,30}: use (?:an? )?(?:explore|browser) session)\b/i.test(
        line,
      ),
    ).length;
  return sourceLineCount >= 3 ? sourceLineCount : 0;
}

function isTaskFactTwoSourceComparisonTask(taskPrompt: string): boolean {
  if (uniqueTaskFactHttpUrlCount(taskPrompt) !== 2) return false;
  return (
    /\b(?:compare|comparison|between|versus|vs\.?|tradeoff|recommendation)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:review|check|inspect|fetch|extract)\b[\s\S]{0,120}\b(?:two|2)\b[\s\S]{0,80}\b(?:source pages?|sources?|urls?)\b/i.test(
      taskPrompt,
    ) ||
    /比较|对比|两个来源|两个页面|两个\s*URL/i.test(taskPrompt)
  );
}

function uniqueTaskFactHttpUrlCount(text: string): number {
  const candidates = Array.from(
    text.matchAll(/\bhttps?:\/\/[^\s"'`<>]+/gi),
    (match) => match[0].replace(/[),.;，。；]+$/, ""),
  );
  const completeUrls = candidates.filter((url) => !url.endsWith("…"));
  return new Set(
    candidates.filter((url) => {
      if (!url.endsWith("…")) {
        return true;
      }
      const visiblePrefix = url.slice(0, -1);
      return !completeUrls.some((completeUrl) =>
        completeUrl.startsWith(visiblePrefix),
      );
    }),
  ).size;
}

function buildRequestedTableColumnActivationContext(
  activation?: RoleActivationInput,
): string[] {
  const intent = activation?.handoff.payload.intent;
  if (!intent) return [];
  return [
    intent.relayBrief ?? "",
    intent.instructions ?? "",
    ...(intent.recentMessages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    ),
  ];
}

function requestedTableColumnMessageContext(messages: LLMMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => readTaskFactMessageContentText(message.content));
}

function explicitlyRequestsProviderSupportSchema(text: string): boolean {
  const normalized = normalizeColumnDetectionText(text);
  return (
    /\bprovider\b|供应商|提供商/.test(normalized) &&
    /search\/web_search|web_search|web search|搜索/.test(normalized) &&
    /目标模型|model support|deepseek|输入价格|input price|output price|输出价格|per-token/.test(
      normalized,
    )
  );
}

function inferRequestedTableColumns(texts: string[]): string[] {
  const columns: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(
      /表格(?:列出|包含|字段|栏位|列)?\s*[:：]\s*([^\n。；;]+)/g,
    )) {
      const rawColumns = match[1] ?? "";
      for (const column of rawColumns.split(/[、,，|]+/)) {
        const normalized = normalizeRequestedTableColumn(column);
        if (!normalized) continue;
        columns.push(normalized);
      }
    }
    for (const match of text.matchAll(
      /table(?:\s+(?:with|containing|columns?))?\s*[:：]\s*([^\n.；;]+)/gi,
    )) {
      const rawColumns = match[1] ?? "";
      for (const column of rawColumns.split(/[、,，|]+/)) {
        const normalized = normalizeRequestedTableColumn(column);
        if (!normalized) continue;
        columns.push(normalized);
      }
    }
  }
  return Array.from(new Set(columns)).slice(0, 12);
}

function inferEvidenceSensitiveProviderTableColumns(
  texts: string[],
): string[] {
  const context = texts.join("\n");
  if (
    !/(?:provider|供应商|提供商)/i.test(context) ||
    !/(?:price|pricing|价格|定价|input|output|输入|输出)/i.test(context) ||
    !/(?:search|web_search|web search|搜索)/i.test(context)
  ) {
    return [];
  }
  const targetModelName = inferRequestedTargetModelName(context);
  return [
    "provider",
    targetModelName ? `是否明确支持 ${targetModelName}` : "是否明确支持目标模型",
    "是否明确支持 search/web_search",
    "输入价格",
    "输出价格",
    "证据 URL",
    "关键原文摘录",
  ];
}

function inferRequestedTargetModelName(context: string): string | null {
  const apiModel = context.match(
    /\b([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6})\s+API\b/,
  )?.[1];
  if (apiModel) {
    return apiModel.trim();
  }
  const providerResearchModel = context.match(
    /\b(?:research|supports?|supporting|for|about|调研)\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6}?)\s+(?:provider|providers|support|search|pricing|price|model|api|API|供应商|提供商|支持|搜索|价格|定价)\b/i,
  )?.[1];
  if (providerResearchModel) {
    return providerResearchModel.trim();
  }
  const supportsModel = context.match(
    /\bsupports?\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6}?)(?:,|;|\.|\s+and\b|\s+whether\b)/i,
  )?.[1];
  if (supportsModel) {
    return supportsModel.trim();
  }
  const targetModel = context.match(
    /\b(?:target model|model|模型)\s*[:：]\s*([A-Za-z0-9._-]+(?:\s+[A-Za-z0-9._-]+){0,6})\b/i,
  )?.[1];
  return targetModel?.trim() || null;
}

function normalizeRequestedTableColumn(column: string): string | null {
  const normalized = column
    .replace(/^[\s`"'“”‘’]+|[\s`"'“”‘’]+$/g, "")
    .trim();
  if (!normalized) return null;
  if (normalized.length > 80) return null;
  if (/[|]/.test(normalized)) return null;
  if (/[。；;]/.test(normalized)) return null;
  if (/\.{3}|…|[*]{2,}|^---+$/.test(normalized)) return null;
  if (
    /(?:mission|status|状态|blocked|partial|final answer|source bounded)/i.test(
      normalized,
    )
  ) {
    return null;
  }
  return normalized;
}

function normalizeColumnDetectionText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function taskPromptRequestsAwaitingContextSetup(taskPrompt: string): boolean {
  if (
    /\b(?:durable memory|memory_search|memory_get|check durable memory|inspect any candidate memory|recover the launch window|launch window|residual risk|previously captured)\b/i.test(
      taskPrompt,
    )
  ) {
    return false;
  }
  return (
    /\bno research (?:is )?(?:needed|required)\b|\bno action (?:is )?(?:needed|required)\b/i.test(
      taskPrompt,
    ) &&
    /\bbriefly acknowledge\b|\backnowledge\b/i.test(taskPrompt) &&
    /\b(?:continue|resume|proceed)\b[\s\S]{0,120}\b(?:context|details?|available|provided)\b/i.test(
      taskPrompt,
    )
  );
}

function readTaskFactMessageContentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "tool_result") return block.content;
      if (block.type === "text") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
