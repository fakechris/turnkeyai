export type MissionGoalSlot =
  | "provider"
  | "search"
  | "pricing"
  | "rendered_browser"
  | "delegated_independent_research"
  | "risk_or_limitation"
  | "quoted_evidence"
  | "final_conclusion";

export interface MissionGoalSlotIssue {
  slot: MissionGoalSlot;
  label: string;
  reason: "missing" | "unverified";
}

export interface MissionGoalSlotCoverage {
  required: MissionGoalSlot[];
  issues: MissionGoalSlotIssue[];
}

const SLOT_LABELS: Record<MissionGoalSlot, string> = {
  provider: "provider support",
  search: "search support",
  pricing: "pricing",
  rendered_browser: "rendered browser evidence",
  delegated_independent_research: "delegated research",
  risk_or_limitation: "risk or limitation",
  quoted_evidence: "quoted evidence",
  final_conclusion: "final conclusion",
};

/**
 * True when the mission EXPLICITLY permits an honest partial/blocked outcome —
 * e.g. "mark the conclusion as blocked/partial", "write 'not verified'",
 * "do not dress it up as complete", and their Chinese equivalents. When a
 * mission authorizes this, an honest answer that surfaces unverified/missing
 * items is the REQUESTED outcome, not a goal-slot failure: the completion
 * evaluator must let it settle to a tagged non-success terminal instead of
 * looping recovery. (Without this, the slot guard penalizes the agent for
 * obeying the instruction to write "未验证" / "not verified".)
 *
 * Bilingual on purpose — the prior implementation only recognized an
 * English "bounded attempt/timeout" framing and missed Chinese tasks.
 */
export function missionAuthorizesPartialCloseout(goalText: string): boolean {
  const authorizesPartial =
    /\b(?:blocked\s*\/\s*partial|partial\s*\/\s*blocked)\b/i.test(goalText) ||
    /\b(?:mark|set|label|report|return|leave|treat|flag)\b[\s\S]{0,48}\b(?:as\s+)?(?:blocked|partial)\b/i.test(goalText) ||
    /\b(?:conclusion|status|result|mission)\b[\s\S]{0,32}\b(?:blocked|partial)\b/i.test(goalText) ||
    /(?:标记?|设|记)\s*(?:为|成)?[\s\S]{0,12}(?:blocked|partial|阻塞|部分(?:完成|验证)?|未完成)/u.test(goalText) ||
    /(?:结论|状态|结果|mission)[\s\S]{0,16}(?:标|设|记|定)\s*(?:为|成)?[\s\S]{0,12}(?:blocked|partial|阻塞|部分|未完成)/u.test(goalText);
  const requiresUnverifiedLabel =
    /\b(?:write|mark|label|state|note)\b[\s\S]{0,48}["'“]?\s*(?:not verified|unverified)\b/i.test(goalText) ||
    /(?:必须|需要?|应当?|请)[\s\S]{0,24}(?:写|标注?|标记|注明|说明)[\s\S]{0,12}["'“]?\s*(?:未验证|未确认|无法验证)/u.test(goalText) ||
    /\b(?:do\s*not|don['’]t)\b[\s\S]{0,40}\b(?:dress(?:ed)?\s*up|fake|pretend|present)\b[\s\S]{0,24}\b(?:complete|completion|done)\b/i.test(goalText) ||
    /不要[\s\S]{0,16}(?:包装成完成|当作完成|伪装成完成|算作完成|当成完成|说成完成)/u.test(goalText);
  return authorizesPartial || requiresUnverifiedLabel;
}

/**
 * True when an answer honestly reports a partial/blocked outcome: it both
 * declares blocked/partial AND surfaces what is unverified/missing. Requiring
 * BOTH halves keeps a fabricated "done" from passing — a fake completion does
 * not declare itself blocked/partial. Only meaningful in combination with
 * missionAuthorizesPartialCloseout().
 */
export function looksLikeHonestPartialBlockedAnswer(finalText: string): boolean {
  const declaresPartialOrBlocked =
    /\b(?:blocked|partial|partially verified|partially complete|incomplete)\b/i.test(finalText) ||
    /(?:部分(?:验证|完成)?|未完成|阻塞|未全部验证)/u.test(finalText);
  const surfacesGaps =
    /\b(?:not verified|unverified|could not verify|unable to verify|remains? unverified|not confirmed|still missing|to be verified|missing)\b/i.test(
      finalText
    ) || /(?:未验证|未确认|无法验证|无法确认|待验证|仍?缺(?:失|口)?|尚未验证)/u.test(finalText);
  return declaresPartialOrBlocked && surfacesGaps;
}

export function evaluateMissionGoalSlotCoverage(input: {
  goalText: string;
  finalText: string;
  evidence?: {
    sessionSpawnCount?: number;
    completedSessionResultCount?: number;
  };
}): MissionGoalSlotCoverage {
  const required = inferRequiredGoalSlots(input.goalText);
  const evidence = {
    ...input.evidence,
    requiredIndependentStreamCount: requiredIndependentStreamCount(input.goalText),
  };
  const issues = required
    .map((slot): MissionGoalSlotIssue | null => {
      if (slotHasUnverifiedCoreClaim(slot, input.finalText, input.goalText)) {
        return { slot, label: SLOT_LABELS[slot], reason: "unverified" };
      }
      if (!slotIsCovered(slot, input.finalText, evidence)) {
        return { slot, label: SLOT_LABELS[slot], reason: "missing" };
      }
      return null;
    })
    .filter((issue): issue is MissionGoalSlotIssue => Boolean(issue));
  return { required, issues };
}

export function missionGoalSlotIssueDetail(issues: MissionGoalSlotIssue[]): string {
  if (issues.length === 0) {
    return "All goal-critical slots inferred from the user request are covered by the final answer.";
  }
  return `Goal-critical slot(s) are incomplete: ${issues
    .map((issue) => `${issue.label} (${issue.reason})`)
    .join(", ")}.`;
}

function inferRequiredGoalSlots(goalText: string): MissionGoalSlot[] {
  const required: MissionGoalSlot[] = [];
  if (mentionsProvider(goalText)) required.push("provider");
  if (mentionsSearch(goalText)) required.push("search");
  if (mentionsPricing(goalText)) required.push("pricing");
  if (mentionsRenderedBrowserEvidence(goalText)) required.push("rendered_browser");
  if (mentionsDelegatedIndependentResearch(goalText)) required.push("delegated_independent_research");
  if (mentionsRiskOrLimitationRequest(goalText)) required.push("risk_or_limitation");
  if (mentionsQuotedEvidenceRequest(goalText)) required.push("quoted_evidence");
  if (mentionsFinalConclusionRequest(goalText)) required.push("final_conclusion");
  return required;
}

function slotIsCovered(
  slot: MissionGoalSlot,
  text: string,
  evidence?: {
    sessionSpawnCount?: number;
    completedSessionResultCount?: number;
    requiredIndependentStreamCount?: number;
  }
): boolean {
  switch (slot) {
    case "provider":
      return (
        mentionsProvider(text) ||
        /\b[A-Z][A-Za-z0-9 ._-]{1,40}\b[\s\S]{0,120}\b(?:provider|platform|model|API|supports?|not support|available|unavailable)\b/i.test(text)
      );
    case "search":
      return mentionsSearch(text);
    case "pricing":
      return hasConcretePricingEvidence(text);
    case "rendered_browser":
      return (
        mentionsRenderedBrowserEvidence(text) ||
        hasConcreteRenderedDashboardFacts(text) ||
        /https?:\/\/\S+|证据\s*URL|evidence\s*URL|最终可见文本|visible text|页面显示|page shows|screenshot|snapshot|截图|快照/iu.test(text)
      );
    case "delegated_independent_research":
      return (
        evidence?.completedSessionResultCount ??
        evidence?.sessionSpawnCount ??
        0
      ) >= (evidence?.requiredIndependentStreamCount ?? 2);
    case "risk_or_limitation":
      return mentionsRiskOrLimitationAnswer(text);
    case "quoted_evidence":
      return mentionsQuotedEvidenceAnswer(text);
    case "final_conclusion":
      return mentionsFinalConclusionAnswer(text);
  }
}

function slotHasUnverifiedCoreClaim(slot: MissionGoalSlot, text: string, goalText: string): boolean {
  for (const segment of splitClaimSegments(text)) {
    const renderedBrowserUnverified =
      slot === "rendered_browser" && isRenderedBrowserEvidenceUnverifiedClaim(segment);
    if (!mentionsUnverified(segment) && !renderedBrowserUnverified) continue;
    if (looksLikeResidualUpdateBoundary(segment)) continue;
    if (looksLikeBoundedUnverifiedSubScope(slot, text, segment)) continue;
    if (looksLikeRenderedBrowserResidualSubScope(slot, text, segment)) continue;
    if (looksLikeSourceBoundedRiskSubScope(slot, text, segment)) continue;
    if (
      slot === "risk_or_limitation" &&
      looksLikeMissionAuthorizedBoundedPartialCloseout(goalText, text)
    ) {
      continue;
    }
    if (
      slot === "delegated_independent_research" &&
      isRequiredEvidenceStreamUnverifiedClaim(goalText, segment)
    ) {
      return true;
    }
    if (!renderedBrowserUnverified && !isExplicitUnverifiedSlotClaim(slot, segment)) continue;
    return true;
  }
  return false;
}

function splitClaimSegments(text: string): string[] {
  return text
    .split(/(?:\r?\n|[。；;]|(?<=[.!?])\s+)/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function mentionsProvider(text: string): boolean {
  return /\bproviders?\b|\bapi\s*(?:platforms?|providers?)\b|\bmodel\s*(?:providers?|platforms?)\b|模型(?:供应商|提供商|平台)|API\s*(?:供应商|提供商|平台)/iu.test(text);
}

function mentionsSearch(text: string): boolean {
  return /\bweb\s*search\b|\bsearch\b|搜索|联网|检索/iu.test(text);
}

function mentionsPricing(text: string): boolean {
  return /\bpric(?:e|ing)\b|\bcosts?\b|\bfees?\b|\btokens?\b|价格|价钱|费用|收费|计费|token/iu.test(text);
}

function mentionsRenderedBrowserEvidence(text: string): boolean {
  return /\b(?:browser|rendered|rendering|screenshot|snapshot|DOM|client[- ]side|javascript|JS)\b|\bvisible\s+(?:text|page|content|element|panel|dashboard|screen|view|UI)\b|\b(?:page|browser|dashboard|DOM|client[- ]side|screen|UI)\b[\s\S]{0,40}\bvisible\b|浏览器|渲染|页面显示|截图|快照|(?:页面|网页|看板|仪表盘|元素|文本|屏幕|界面)[\s\S]{0,20}可见/iu.test(
    text
  );
}

function mentionsDelegatedIndependentResearch(text: string): boolean {
  return (
    /(?:交给|委派|派给|让|请|安排|delegat(?:e|ed|ion)|assign(?:ed)?)[\s\S]{0,80}(?:研究员|researchers?|agents?|sub[- ]?agents?|角色|roles?|streams?)(?:\s*[A-ZＡ-Ｚ])?/iu.test(text) ||
    /(?:交给|委派|派给|delegat(?:e|ed|ion)|assign(?:ed)?)[\s\S]{0,80}(?:独立|independent|separate|分别|多路|multiple|两个|两名|2\s*(?:个|名)?)[\s\S]{0,80}(?:研究员|researchers?|agents?|sub[- ]?agents?|角色|roles?|streams?|取证|evidence)/iu.test(text) ||
    /(?:两个|两名|2\s*(?:个|名)?|multiple|independent|separate)[\s\S]{0,80}(?:独立)?[\s\S]{0,40}(?:研究员|researchers?|agents?|sub[- ]?agents?|角色|roles?|streams?)[\s\S]{0,80}(?:分别|独立|取证|evidence|check|检查)/iu.test(text) ||
    /\b(?:separate|independent|multiple|three|two|3|2)\b[\s\S]{0,80}\b(?:evidence\s+streams?|streams?)\b|\b(?:evidence\s+streams?|streams?)\b[\s\S]{0,80}\b(?:separate|independent|multiple|three|two|3|2)\b/iu.test(
      text
    )
  );
}

function requiredIndependentStreamCount(text: string): number {
  const labeledResearcherCount = countLabeledResearchers(text);
  if (labeledResearcherCount >= 2) return labeledResearcherCount;
  if (mentionsEvidenceStreamCount(text, /(?:three|3)/iu)) return 3;
  if (mentionsEvidenceStreamCount(text, /(?:two|2)/iu)) return 2;
  if (mentionsAgentCount(text, /(?:三个|三名|3\s*(?:个|名)|three)/iu)) return 3;
  if (mentionsAgentCount(text, /(?:两个|两名|2\s*(?:个|名)|two)/iu)) return 2;
  return 1;
}

function countLabeledResearchers(text: string): number {
  const labels = new Set<string>();
  for (const match of text.matchAll(/(?:研究员|researcher)\s*([A-ZＡ-Ｚ])/giu)) {
    labels.add(match[1]!.normalize("NFKC").toUpperCase());
  }
  return labels.size;
}

function mentionsAgentCount(text: string, countPattern: RegExp): boolean {
  const agentPattern = /(?:研究员|researchers?|agents?|sub[- ]?agents?|角色|roles?|streams?)/iu;
  return text
    .split(/[。；;，,\n]/u)
    .some((segment) => countPattern.test(segment) && agentPattern.test(segment));
}

function mentionsEvidenceStreamCount(text: string, countPattern: RegExp): boolean {
  const streamPattern = /(?:evidence\s+streams?|streams?)/iu;
  return text
    .split(/[。；;，,\n]/u)
    .some((segment) => countPattern.test(segment) && streamPattern.test(segment));
}

function mentionsRiskOrLimitationRequest(text: string): boolean {
  return /\b(?:risk|risks|limitation|limitations|constraint|constraints|caveat|caveats|avoid|do not use|don't use)\b|风险|限制|局限|缺口|注意事项|不要用于|不得用于|避免用于|使用时最重要/iu.test(
    text
  );
}

function mentionsRiskOrLimitationAnswer(text: string): boolean {
  return /\b(?:risk|risks|limitation|limitations|constraint|constraints|caveat|caveats|avoid use in operations|avoid|do not use|don't use|not for|must not)\b|风险|限制|局限|缺口|注意事项|不要用于|不得用于|避免用于|运营环境|真实环境|生产环境/iu.test(
    text
  );
}

function mentionsQuotedEvidenceRequest(text: string): boolean {
  return /\b(?:quote|quoted|excerpt|citation|cite|source text|verbatim)\b|引用|原文|摘录|关键原文/iu.test(
    text
  );
}

function mentionsQuotedEvidenceAnswer(text: string): boolean {
  return /(?:^|\n)\s*>|["“][^"”]{12,}["”]|\b(?:quote|quoted excerpt|excerpt|citation|evidence|source)\b|引用|原文|摘录|证据|关键原文/iu.test(
    text
  );
}

function mentionsFinalConclusionRequest(text: string): boolean {
  return /(?:最后|最终|末尾|再|另)\s*(?:再)?\s*(?:给|写|输出|补充)?[\s\S]{0,40}(?:一句话|一[个条]简短|简短|one[-\s]?sentence|brief)[\s\S]{0,40}(?:结论|总结|conclusion|summary)|(?:结论|总结|conclusion|summary)[\s\S]{0,40}(?:一句话|one[-\s]?sentence|brief)/iu.test(
    text
  );
}

function mentionsFinalConclusionAnswer(text: string): boolean {
  return /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[*_]{1,3}\s*)?(?:结论|一句话结论|最终结论|总结|Conclusion|Summary)\s*[:：]?\s*(?:[*_]{1,3})?/iu.test(text);
}

function mentionsUnverified(text: string): boolean {
  return /未完成|未验证|未确认|无法验证|无法确认|没有验证|待确认|待补充|待验证|不确定|\b(?:incomplete|not completed|unverified|not verified|not confirmed|unknown|blocked|tbd)\b|\b(?:could not|unable to|cannot)\s+verif(?:y|ied)\b|\bno\b[\s\S]{0,160}\bverif(?:y|ied)\b|\bneeds?\s+(?:confirmation|verification)\b/i.test(
    text
  );
}

function isRenderedBrowserEvidenceUnverifiedClaim(text: string): boolean {
  return /\bnot\s+rendered\b|\brendered\s+page\s+content\s+is\s+unavailable\b|(?:rendered|rendering|browser-visible|visible text|DOM|client[- ]side|javascript|JS|screenshot|snapshot|page content|页面显示|可见|截图|快照|渲染)[\s\S]{0,100}(?:未完成|未验证|未确认|未获取|无法验证|无法确认|unavailable|not rendered|unverified|not verified|missing|blocked|not confirmed|unknown)|(?:未完成|未验证|未确认|未获取|无法验证|无法确认|unavailable|not rendered|unverified|not verified|missing|blocked|not confirmed|unknown)[\s\S]{0,100}(?:rendered|rendering|browser-visible|visible text|DOM|client[- ]side|javascript|JS|screenshot|snapshot|page content|页面显示|可见|截图|快照|渲染)/iu.test(
    text
  );
}

function isRequiredEvidenceStreamUnverifiedClaim(goalText: string, text: string): boolean {
  if (!mentionsDelegatedIndependentResearch(goalText)) return false;
  const streamPatterns = requiredEvidenceStreamPatterns(goalText);
  if (streamPatterns.length === 0) return false;
  const streamUnavailable =
    /\b(?:not verified|unverified|not confirmed|missing|unavailable|pruned before retrieval|before retrieval|could not retrieve|could not be retrieved|not captured|no structural data|no source data)\b/i.test(
      text
    ) || /未验证|未确认|未获取|无法验证|无法确认|缺失|不可用/u.test(text);
  if (!streamUnavailable) return false;
  const streamScope =
    /\b(?:stream|source|page|evidence|shape|structure|structural|data|status|retriev(?:e|al|ed)?|pruned|captured)\b/i.test(
      text
    ) || /证据流|来源|页面|证据|结构|数据|状态/u.test(text);
  if (!streamScope) return false;
  return streamPatterns.some((pattern) => pattern.test(text));
}

function requiredEvidenceStreamPatterns(goalText: string): RegExp[] {
  const patterns: RegExp[] = [];
  const hasRoute = /\broute\b|路线|行程/iu.test(goalText);
  const hasBudget = /\bbudget\b|预算/iu.test(goalText);
  const hasReadiness = /\b(?:live\s+readiness|readiness)\b|就绪/iu.test(goalText);
  if (hasRoute && hasBudget && hasReadiness) {
    patterns.push(/\broute\b|路线|行程/iu);
    patterns.push(/\bbudget\b|预算/iu);
    patterns.push(/\b(?:live\s+readiness|readiness|dashboard|live)\b|就绪|看板|仪表盘/iu);
  }
  return patterns;
}

function isExplicitUnverifiedSlotClaim(slot: MissionGoalSlot, text: string): boolean {
  if (slot === "rendered_browser") {
    return isRenderedBrowserEvidenceUnverifiedClaim(text);
  }
  const unavailable = /未完成|未验证|未确认|无法验证|无法确认|没有验证|待确认|待补充|待验证|不确定|\b(?:incomplete|not completed|unverified|not verified|not confirmed|unknown|blocked|tbd|missing)\b|\b(?:could not|unable to|cannot)\s+verif(?:y|ied)\b|\bneeds?\s+(?:confirmation|verification)\b/i;
  const slotPattern = explicitSlotPattern(slot);
  const slotSource = `(?:${slotPattern.source})`;
  const unavailableSource = `(?:${unavailable.source})`;
  return (
    new RegExp(`${slotSource}[\\s\\S]{0,80}${unavailableSource}`, "iu").test(text) ||
    new RegExp(`${unavailableSource}[\\s\\S]{0,80}${slotSource}`, "iu").test(text)
  );
}

function explicitSlotPattern(slot: MissionGoalSlot): RegExp {
  switch (slot) {
    case "provider":
      return /\bproviders?\b|\bmodel\s*(?:providers?|platforms?)\b|模型(?:供应商|提供商|平台)|API\s*(?:供应商|提供商|平台)/iu;
    case "search":
      return /\bweb\s*search\b|\bsearch\b|搜索|联网|检索/iu;
    case "pricing":
      return /\bpric(?:e|ing)\b|\bcosts?\b|\bfees?\b|\binput\s+price\b|\boutput\s+price\b|价格|价钱|费用|收费|计费|输入价格|输出价格/iu;
    case "risk_or_limitation":
      return /\b(?:risk|risks|limitation|limitations|constraint|constraints|caveat|caveats)\b|风险|限制|局限|缺口|注意事项/iu;
    case "quoted_evidence":
      return /\b(?:quote|quoted|excerpt|citation|cite|source text|verbatim)\b|引用|原文|摘录|关键原文/iu;
    case "final_conclusion":
      return /\b(?:conclusion|recommendation|summary|answer)\b|结论|总结|建议|答案/iu;
    case "delegated_independent_research":
      return /\b(?:delegated|independent|researchers?|agents?|streams?)\b|委派|独立|研究员|角色|取证/iu;
    case "rendered_browser":
      return /\b(?:browser|rendered|rendering|visible|visual|screenshot|snapshot|DOM|client[- ]side|javascript|JS)\b|浏览器|渲染|可见|页面显示|截图|快照/iu;
  }
}

function looksLikeResidualUpdateBoundary(text: string): boolean {
  return /residual risk|剩余风险|后续|未来|之后|更新|变动|\b(?:later|future|updates?|after this run|source updates?)\b/i.test(
    text
  );
}

function looksLikeBoundedUnverifiedSubScope(
  slot: MissionGoalSlot,
  fullText: string,
  text: string
): boolean {
  if (slot === "provider" || slot === "search") {
    if (!hasConcreteProviderSearchEvidence(fullText)) return false;
    return /\b(?:source[- ]bounded|local fixture|production|production freshness|external availability|outside (?:the )?source|not verified elsewhere|not verified from (?:the )?source|source updates?|provider docs?|official docs?)\b|生产|线上|外部|来源之外|后续更新|官方文档/iu.test(
      text
    ) ||
      /\b(?:single|same|captured|local|test)\s+source\b[\s\S]{0,120}\b(?:not (?:been )?(?:independently |cross[- ]?)?(?:confirmed|verified)|not cross[- ]verified|not independently confirmed|not independently verified)|\b(?:not (?:been )?(?:independently |cross[- ]?)?(?:confirmed|verified)|not cross[- ]verified|not independently confirmed|not independently verified)\b[\s\S]{0,120}\b(?:single|same|captured|local|test)\s+source\b/i.test(
        text
      );
  }
  if (slot !== "pricing") return false;
  if (
    hasConcretePricingEvidence(fullText) &&
    /\b(?:live|current|production|prod(?:uction)?|route[- ]level|provider(?:'s)? production|official)\b[\s\S]{0,120}\b(?:pricing|price|search enablement|route[- ]level search)\b[\s\S]{0,120}\b(?:not (?:been )?independently verified|not verified|unverified|not confirmed|needs verification)\b|\b(?:pricing|price|search enablement|route[- ]level search)\b[\s\S]{0,120}\b(?:live|current|production|prod(?:uction)?|route[- ]level|provider(?:'s)? production|official)\b[\s\S]{0,120}\b(?:not (?:been )?independently verified|not verified|unverified|not confirmed|needs verification)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (
    hasConcretePricingEvidence(text) &&
    /\b(?:source[- ]bounded|local fixture|not live production|external availability|outside (?:the )?source|not verified elsewhere|not verified from (?:the )?source)\b|来源之外|生产|线上|官方文档|后续更新|新鲜度/iu.test(
      text
    )
  ) {
    return true;
  }
  if (
    /\b(?:source[- ]bounded|local fixture|outside (?:the )?source|not verified elsewhere|not verified from (?:the )?source)\b|来源之外|生产|线上|官方文档|后续更新|新鲜度/iu.test(
      text
    ) &&
    /\b(?:external availability|deeper pricing tiers|enterprise|annual plans?|usage tiers?|feature[- ]gated tiers?|seat minimums?|minimums?|billing cycles?|billing periods?|trial terms?)\b|企业|年度|年付|阶梯|计费周期|套餐|生产决策|生产使用|官方文档|文档新鲜度/iu.test(
      text
    )
  ) {
    return true;
  }
  return /\b(?:only confirmed pricing|only confirmed pricing detail|only confirmed price|no enterprise|annual(?: plans?)?|volume(?: discounts?)?|enterprise(?: tier| pricing)?|anything else|usage tiers?|feature[- ]gated tiers?|seat minimums?|minimums?|seat[- ]count equivalence|equivalence not confirmed|billing cycles?|billing periods?|billing model|trial terms?)\b/i.test(
      text
    ) ||
    (hasConcretePricingEvidence(fullText) &&
      /\b(?:enterprise(?:\s*\/\s*custom)? pricing|custom pricing|pricing tiers?|free trials?|free tiers?)\b[\s\S]{0,100}\b(?:not verified|unverified|not confirmed|unknown|missing)\b|\b(?:not verified|unverified|not confirmed|unknown|missing)\b[\s\S]{0,100}\b(?:enterprise(?:\s*\/\s*custom)? pricing|custom pricing|pricing tiers?|free trials?|free tiers?)\b/i.test(
        text,
      )) ||
    /(?:仅|只)(?:确认|验证)[\s\S]{0,40}(?:价格|输入价格|输出价格|计费)|(?:企业|年度|年付|阶梯|计费周期|套餐|官方文档|生产决策|生产使用|文档新鲜度)[\s\S]{0,80}(?:未验证|未确认|待验证|需要验证)/u.test(
      text
    ) ||
    /\b(?:not directly comparable|cannot be directly compared|not apples-to-apples|team size context|seat[- ]based|workspace[- ]based|per[- ]unit comparison|cost difference per unit)\b/i.test(
      text
    );
}

function hasConcreteProviderSearchEvidence(text: string): boolean {
  return (
    (mentionsProvider(text) || /\b(?:provider|platform|API|model host|model router)\b/i.test(text)) &&
    /\b(?:model|target model|requested model|API)\b/i.test(text) &&
    (/\b(?:web_search|web search|search)\b/i.test(text) || /搜索|检索|联网/u.test(text)) &&
    (/\b(?:support|supported|supports|not support|does not support)\b/i.test(text) || /支持|不支持/u.test(text))
  );
}

function hasConcretePricingEvidence(text: string): boolean {
  return /[$￥¥]\s*\d|\b\d+(?:\.\d+)?\s*(?:usd|cny|rmb)\b|\b(?:free tier|free plan|no charge|included at no extra cost)\b/i.test(
    text
  );
}

function looksLikeRenderedBrowserResidualSubScope(
  slot: MissionGoalSlot,
  fullText: string,
  segment: string
): boolean {
  if (slot !== "rendered_browser") return false;
  if (!hasConcreteRenderedBrowserFacts(fullText)) return false;
  if (looksLikeBoundedRenderedBrowserLimitation(segment)) return true;
  return (
    /\b(?:residual risk|unverified scope|could not be verified|not verified|unverified|unknown|could not confirm|cannot confirm)\b/i.test(
      segment
    ) &&
    /\b(?:local fixture|production|real production|prod(?:uction)? incident|on-call notification|notification was actually dispatched|downstream dependencies|downstream paging|paging workflow|interactive controls?|operator action|historical trend|upstream services|source updates?|changed after|outside (?:the )?browser check|outside (?:the )?captured page|external mutation|external side[- ]effects?|external network call|downstream system mutation|distances?|segment durations?|detailed waypoint steps?|waypoints?|route details?|turn-by-turn details?|not visible in (?:the )?(?:rendered )?(?:source|page|dashboard))\b/i.test(
      segment
    )
  );
}

function looksLikeBoundedRenderedBrowserLimitation(segment: string): boolean {
  const boundedFailure =
    /\b(?:not captured|not verified|unverified|not confirmed|blocked|missing|cannot confirm|could not confirm|could not be verified|unable to verify|timeout|timed out|failed)\b/i.test(
      segment
    );
  if (!boundedFailure) return false;
  return /\b(?:screenshot artifact|screenshot|snapshot|full DOM|DOM\/tree|tree traversal|layout|CSS styling|hidden panels?|additional widgets?|charts?|drill[- ]down tables?|lazy[- ]loaded panels?|below the initial viewport|full page structure|standalone numeric (?:metric|tile|KPI)|metric value|numeric Mission Control tile)\b/i.test(
    segment
  );
}

function hasConcreteRenderedBrowserFacts(text: string): boolean {
  const browserEvidenceVisible = mentionsRenderedBrowserEvidence(text) || /\b(?:browser-visible|page shows|observed via browser|captured|screenshot|snapshot)\b/i.test(text);
  const operationalFactsVisible = hasConcreteRenderedDashboardFacts(text) || hasConcreteRenderedApprovalFacts(text);
  return browserEvidenceVisible && operationalFactsVisible;
}

function hasConcreteRenderedDashboardFacts(text: string): boolean {
  return (
    /\bqueue depth\b[\s\S]{0,80}\b\d+\b/i.test(text) ||
    /\bSLA breaches?\b[\s\S]{0,80}\b\d+\b/i.test(text) ||
    /\b(?:owner|commander|responsible|assignee|on[- ]call)\b[\s\S]{0,80}\b[A-Z][A-Za-z0-9 _-]{2,80}\b/i.test(text) ||
    /\bescalation\b[\s\S]{0,80}\b(?:triggered|fires?|threshold|policy)\b/i.test(text) ||
    /\b(?:readiness|status|health|state|dashboard|panel|metric|counter|rate)\b[\s\S]{0,120}\b(?:green|yellow|amber|red|risk|warning|maintenance|blocked|degraded|healthy|\d+(?:\.\d+)?%?)\b/i.test(
      text
    ) ||
    /\b(?:browser-visible|page shows|rendered browser|rendered dashboard|visible dashboard|live dashboard|signal dashboard)\b[\s\S]{0,160}\b(?:\d+(?:\.\d+)?%?|\b(?:green|yellow|amber|red|risk|warning|degraded|healthy)\b)\b/i.test(
      text
    )
  );
}

function hasConcreteRenderedApprovalFacts(text: string): boolean {
  return (
    /\bpost[- ]submit(?:ted)?\s+(?:page\s+)?state\b/i.test(text) ||
    /\bpost[- ]submission\s+state\b/i.test(text) ||
    /\bPage evidence\b[\s\S]{0,240}\b(?:Source URL|Page title|Post-submission state|form|approval|submit)\b/i.test(text) ||
    /\bdry[- ]run submitted locally after approval\b/i.test(text) ||
    /\bapproval[- ]form page\b/i.test(text) ||
    /\bbrowser\.form\.submit\b[\s\S]{0,120}\b(?:submitted|completed|executed|success|approved)\b/i.test(text)
  );
}

function looksLikeSourceBoundedRiskSubScope(
  slot: MissionGoalSlot,
  fullText: string,
  segment: string
): boolean {
  if (slot !== "risk_or_limitation") return false;
  if (
    hasConcreteSourceBoundedRiskFacts(fullText) &&
    /\b(?:whether|if)\b[\s\S]{0,80}\b(?:risk|risks|runbook gap|limitation|limitations|constraint|constraints|caveat|caveats|gap)\b[\s\S]{0,120}\b(?:resolved|addressed|mitigated|executed|closed|fixed)\b[\s\S]{0,120}\b(?:not verified|unverified|not confirmed|unknown|absent from (?:the )?fixture)\b/i.test(
      segment,
    )
  ) {
    return true;
  }
  if (
    hasConcreteSourceBoundedRiskFacts(fullText) &&
    /\b(?:runbook completeness|runbook content|mitigation execution readiness|rollback rehearsal|production[- ]endpoint behavior|live endpoint behavior|applicability beyond fixture|real endpoint contract|availability profile)\b[\s\S]{0,160}\b(?:not verified|unverified|not confirmed|unknown|not inspected|unconfirmed|outside (?:the )?scope|fixture-level|not live endpoint)\b|\b(?:not verified|unverified|not confirmed|unknown|not inspected|unconfirmed|outside (?:the )?scope|fixture-level|not live endpoint)\b[\s\S]{0,160}\b(?:runbook completeness|runbook content|mitigation execution readiness|rollback rehearsal|production[- ]endpoint behavior|live endpoint behavior|applicability beyond fixture|real endpoint contract|availability profile)\b/i.test(
      segment,
    )
  ) {
    return true;
  }
  if (!/\b(?:residual risk|risk dimension|source ledger|source[- ]bounded|evidence state)\b/i.test(fullText)) {
    return looksLikeGenericSourceBoundedRiskCaveat(fullText, segment);
  }
  if (!/[|]/.test(segment) && !hasConcreteSourceBoundedRiskFacts(fullText)) return false;
  return /\b(?:unverified|not verified|not explicitly described|outside (?:the )?scope|local fixture|fixture evidence|not live production|not audited production|production freshness|fixture-data|source pages?|evidence)\b|未验证|未确认|来源之外|证据|官方文档|生产|线上|新鲜度/iu.test(
    segment
  ) && /\b(?:local fixture|fixture evidence|not live production|not audited production|production|prod(?:uction)?|production freshness|customer impact|customer adoption|adoption|real users?|production telemetry|post[- ]run|source updates?|outside (?:the )?scope|outside (?:the )?captured sources?|external validation)\b|生产|线上|官方文档|来源之外|后续更新|新鲜度|外部验证/iu.test(segment);
}

function looksLikeGenericSourceBoundedRiskCaveat(fullText: string, segment: string): boolean {
  if (!hasConcreteSourceBoundedRiskFacts(fullText)) return false;
  return (
    /\b(?:risk|risks|limitation|tradeoff|caveat|note)\b/i.test(fullText) &&
    /\b(?:not directly comparable|cannot be directly compared|not apples-to-apples|team size context|not verified from (?:(?:the|this|that) )?source|not provided by (?:(?:the|this|that) )?source|outside (?:(?:the|this|that) )?source|source[- ]bounded|local fixture|not live production|not audited production|production freshness|customer impact|customer adoption|production telemetry|post[- ]run|source updates?)\b/i.test(
      segment
    )
  );
}

function hasConcreteSourceBoundedRiskFacts(text: string): boolean {
  return (
    /\b(?:evidence streams?|source[- ]backed|source ledger|verified evidence|browser evidence|rendered evidence|dashboard evidence|provider evidence|pricing evidence)\b/i.test(text) ||
    /\b(?:risk|risks|limitation|limitations|constraint|constraints|caveat|tradeoff|gap)\b[\s\S]{0,160}\b(?:verified|source|evidence|browser|dashboard|pricing|provider|metric|owner|runbook|transport)\b/i.test(text) ||
    /\b(?:queue depth|SLA breaches?|escalation|readiness|status|health|owner|price|pricing|input price|output price)\b[\s\S]{0,100}\b(?:\d+(?:\.\d+)?%?|[$￥¥]\s*\d|\bverified\b|\bevidence\b)\b/i.test(text) ||
    /(?:风险|限制|局限|缺口|权衡)[\s\S]{0,80}(?:证据|来源|已验证|价格|看板|指标|负责人|浏览器)/u.test(text)
  );
}

function looksLikeMissionAuthorizedBoundedPartialCloseout(
  goalText: string,
  finalText: string
): boolean {
  if (!/\bbounded\b[\s\S]{0,120}\b(?:attempt|try|window|timeout)\b/i.test(goalText)) {
    return false;
  }
  if (
    !/\bif\b[\s\S]{0,180}\b(?:source|endpoint|page|service)\b[\s\S]{0,180}\b(?:does not return|doesn't return|fails? to return|times? out|timed out|timeout)\b[\s\S]{0,220}\b(?:close out|closeout|available evidence|verified facts?|unverified items?|how to continue)\b/i.test(
      goalText
    )
  ) {
    return false;
  }
  return (
    /\b(?:partial evidence closeout|partial closeout|source evaluation|closeout|release-risk note|bounded attempt)\b/i.test(finalText) &&
    /\b(?:timed out|timeout|no response received|no HTTP response)\b/i.test(finalText) &&
    hasBoundedTimeoutAttemptEvidence(finalText) &&
    hasBoundedTimeoutUnavailableScope(finalText) &&
    /\b(?:how to continue|recommendation|next action|retry|increase the timeout|check the service|confirm whether)\b/i.test(
      finalText
    )
  );
}

function hasBoundedTimeoutAttemptEvidence(text: string): boolean {
  return (
    /\b(?:verified facts?|what was verified|evidence gathered|available evidence|connection status|attempt result|result)\b/i.test(
      text
    ) ||
    /\b(?:source|target URL|URL)\b[\s\S]{0,120}\bhttps?:\/\/[^\s)`|]+/i.test(text) ||
    /\b(?:status|attempt result|outcome|content received)\b[\s\S]{0,120}\b(?:timed out|timeout|no response|none|no HTTP response)\b/i.test(
      text
    )
  );
}

function hasBoundedTimeoutUnavailableScope(text: string): boolean {
  return (
    /\b(?:unverified(?:\s*\/\s*unknown)? items?|what remains unverified|source[- ]bounded gaps?|missing slots?|evidence gathered\s*[:：]?\s*(?:none|no usable evidence)|none\s*[—-]\s*session paused)\b/i.test(
      text
    ) ||
    /\b(?:before returning|without returning|before retrieving|without retrieving)\b[\s\S]{0,160}\b(?:HTTP status|status|headers?|body text|response body|source content)\b/i.test(
      text
    ) ||
    /\b(?:no|not any|no usable)\b[\s\S]{0,120}\b(?:HTTP status|headers?|body text|response body|source content|release-risk content)\b/i.test(
      text
    )
  );
}
