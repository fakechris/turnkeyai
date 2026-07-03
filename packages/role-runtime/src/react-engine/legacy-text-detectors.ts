// Stage 8 engine cleanup — legacy text detector registry.
//
// Authority: hold text-fallback detectors for facts that are not yet produced as
// structured fields. These detectors are compatibility debt, not policy owners.
// Every row states the typed field that should eventually replace the text read,
// its producer, feasibility class, inventory row, and fixtures.
//
// HARD INVARIANT: detectors return facts only. They must not authorize,
// retroactively validate, or execute side-effect tools.
export const LEGACY_TEXT_DETECTORS_MODULE = "legacy-text-detectors" as const;

export type LegacyDetectorFeasibilityClass =
  | "already_structured"
  | "present_only_as_text"
  | "missing_from_producer";

export interface LegacyTextDetectorDefinition {
  id: string;
  targetTypedField: string;
  producer: string;
  feasibilityClass: LegacyDetectorFeasibilityClass;
  inventoryRow: string;
  positiveFixture: string;
  negativeFixture: string;
  detect(text: string): null | string;
}

export interface LegacyTextDetectorResult {
  id: string;
  matched: boolean;
  fact: string | null;
}

export const LEGACY_TEXT_DETECTORS: readonly LegacyTextDetectorDefinition[] = [
  {
    id: "approval_wait_timeout_text",
    targetTypedField: "EvidenceSnapshot.permission.waitTimeout",
    producer: "permission_result tool output and runtime progress text",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "approval_wait_timeout",
    positiveFixture:
      "permission_result: approval_wait_timeout and still pending",
    negativeFixture: "permission_result: approved and applied",
    detect: (text) =>
      /\bapproval_wait_timeout\b|\bwait[- ]timeout\b/i.test(text)
        ? "approval_wait_timeout"
        : null,
  },
  {
    id: "approval_applied_text",
    targetTypedField: "EvidenceSnapshot.permission.appliedApproval",
    producer: "permission_result tool output and runtime progress text",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "approval_applied_denied",
    positiveFixture:
      "permission.applied: approval applied for browser action",
    negativeFixture: "permission_result: approval is still pending",
    detect: (text) =>
      /\bpermission[._-]?applied\b|\bapproval applied\b|\bstatus["']?\s*:\s*["']?applied\b/i.test(
        text,
      )
        ? "approval_applied"
        : null,
  },
  {
    id: "approval_denied_text",
    targetTypedField: "EvidenceSnapshot.permission.deniedApproval",
    producer: "permission_result tool output",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "approval_applied_denied",
    positiveFixture: "permission_result: denied by the operator",
    negativeFixture: "permission_result: approval applied",
    detect: (text) =>
      /\bpermission[._-]?denied\b|\bapproval denied\b|\bstatus["']?\s*:\s*["']?denied\b|\bdenied by the operator\b/i.test(
        text,
      )
        ? "approval_denied"
        : null,
  },
  {
    id: "browser_visible_requirement_text",
    targetTypedField: "TaskFactsSnapshot.browserVisibleEvidenceRequired",
    producer: "task prompt, activation, and recent user messages",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "browser_visible_requirement",
    positiveFixture:
      "Inspect the browser-visible rendered page and report exact visible values.",
    negativeFixture: "Fetch the static HTML only; no browser-rendered evidence is needed.",
    detect: (text) =>
      /\b(?:browser-visible|browser rendered|browser-rendered|rendered page|rendered DOM|visible values?|in the browser|browser session|shadow DOM|iframe)\b/i.test(
        text,
      ) &&
      !/\b(?:no|without)\s+(?:browser-rendered|browser rendered|browser-visible|rendered DOM)\b/i.test(
        text,
      )
        ? "browser_visible_required"
        : null,
  },
  {
    id: "product_signal_dashboard_text",
    targetTypedField:
      "TaskFactsSnapshot.productSignalDashboardEvidenceRequested",
    producer: "task prompt, activation, and recent user messages",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "browser_visible_requirement",
    positiveFixture:
      "Review the product-signals live signal dashboard with rendered browser evidence.",
    negativeFixture: "Summarize the product roadmap document.",
    detect: (text) =>
      /\b(?:product-signals|product signal dashboard|live signal dashboard)\b/i.test(
        text,
      )
        ? "product_signal_dashboard_requested"
        : null,
  },
  {
    id: "independent_evidence_streams_text",
    targetTypedField: "TaskFactsSnapshot.requiredIndependentEvidenceStreams",
    producer: "task prompt",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "independent_evidence_streams",
    positiveFixture:
      "Compare three independent evidence streams before finalizing.",
    negativeFixture: "Use the existing completed session evidence.",
    detect: (text) =>
      /\b(?:two|2|three|3)\b[\s\S]{0,80}\b(?:independent|separate|distinct)\b[\s\S]{0,80}\bevidence streams?\b/i.test(
        text,
      )
        ? "independent_evidence_streams_required"
        : null,
  },
  {
    id: "timeout_recovery_intent_text",
    targetTypedField: "TaskFactsSnapshot.timeoutRecoveryRequested",
    producer: "task prompt and recent user messages",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "timeout_recovery_intent",
    positiveFixture: "Continue the timed-out slow-source session.",
    negativeFixture: "Summarize the completed source session.",
    detect: (text) =>
      (/\b(?:continue|resume|retry|recover|recovery|follow-?up)\b|继续|恢复|重试/i.test(
        text,
      ) &&
        /\b(?:timeout|timed[- ]out|bounded attempt|slow[- ]source|source[- ]check)\b|超时/i.test(
          text,
        ))
        ? "timeout_recovery_requested"
        : null,
  },
  {
    id: "awaiting_context_setup_text",
    targetTypedField: "TaskFactsSnapshot.awaitingContextSetupOnly",
    producer: "task prompt",
    feasibilityClass: "present_only_as_text",
    inventoryRow: "awaiting_context_setup",
    positiveFixture: "Wait for context setup; do not call tools yet.",
    negativeFixture: "Recall the previous memory after context setup.",
    detect: (text) =>
      /\b(?:awaiting|wait for|pending)\s+(?:context|setup)\b|\bdo not call tools yet\b/i.test(
        text,
      )
        ? "awaiting_context_setup_only"
        : null,
  },
  {
    id: "pseudo_tool_call_markup_text",
    targetTypedField: "FutureModelTextFacts.pseudoToolCallMarkup",
    producer: "model final text",
    feasibilityClass: "missing_from_producer",
    inventoryRow: "legacy_fallbacks",
    positiveFixture: "I will call <tool_call>{\"name\":\"web_fetch\"}</tool_call>",
    negativeFixture: "I used the available evidence and will now answer.",
    detect: (text) =>
      /<tool_call\b|\btool_use\b|\bfunction_call\b/i.test(text)
        ? "pseudo_tool_call_markup"
        : null,
  },
];

export function runLegacyTextDetector(
  id: string,
  text: string,
): LegacyTextDetectorResult {
  const detector = LEGACY_TEXT_DETECTORS.find((item) => item.id === id);
  if (!detector) {
    return { id, matched: false, fact: null };
  }
  const fact = detector.detect(text);
  return { id, matched: fact !== null, fact };
}
