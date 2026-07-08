import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateMissionGoalSlotCoverage,
  missionGoalSlotIssueDetail,
} from "./mission-goal-slot-coverage";

describe("evaluateMissionGoalSlotCoverage", () => {
  it("requires no slots for a goal with no inferable requirements", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Say hello and introduce yourself.",
      finalText: "Hello, I am the assistant.",
    });
    assert.deepEqual(coverage.required, []);
    assert.deepEqual(coverage.issues, []);
  });

  it("does not infer risk slots from tool and formatting prohibitions", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Prepare a follow-up-only durable memory recall acceptance test.",
        "Do not use tools. Reply with one Markdown bullet containing TURNKEYAI_MISSION_MEMORY_SETUP_OK and the word setup.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
      finalText: "- TURNKEYAI_MISSION_MEMORY_SETUP_OK setup",
    });

    assert.deepEqual(coverage.required, []);
    assert.deepEqual(coverage.issues, []);
  });

  it("does not infer rendered browser slots from browser-tool prohibitions", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Use mission task tools to prove the agent can keep product-visible work state current.",
        "Call tasks_list, tasks_create, and tasks_update exactly once.",
        "Do not call sessions_spawn, sessions_send, sessions_history, sessions_list, browser tools, permission tools, or memory tools.",
      ].join("\n"),
      finalText: [
        "## Task tracking",
        "- task lifecycle: TURNKEYAI_MISSION_TASK_TRACKING_OK; tool result evidence shows tasks_list checked existing work, tasks_create created the item, and tasks_update completed it.",
        "- tracked item: Verify Helios-47 rollout note is done with progress 1.",
        "- residual risk: this validates local mission task state only, not external project delivery.",
      ].join("\n"),
    });

    assert.equal(coverage.required.includes("rendered_browser"), false);
    assert.deepEqual(coverage.issues, []);
  });

  it("does not infer pricing slots from external-pricing prohibitions", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Prepare a decision-grade product brief for the next agent workbench release.",
        "Use the available session tools. Do not answer from memory.",
        "The final answer must state what to build next, why, what not to over-emphasize, and what risk remains.",
        "Do not claim a native Electron/Tauri shell is already shipped.",
        "Do not infer market adoption, external outages, customer counts, or external pricing beyond the local fixture text.",
      ].join("\n"),
      finalText: [
        "evidence",
        "- orchestration evidence: TURNKEYAI_PRODUCT_ORCHESTRATION_OK; product lead starts one mission and specialist agents watch work until a decision-ready brief is produced.",
        "- bridge evidence: TURNKEYAI_PRODUCT_BRIDGE_OK; bridge controls browser pages, rendered DOM, approved forms, screenshots, console output, and artifacts.",
        "- browser signal evidence: TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK; Stuck missions: 6, Weak answer rate: 24%; recommended next action is Mission Control as the entry point.",
        "decision",
        "- recommendation: TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK - make Mission Control the default entry.",
        "- residual risk: all evidence is bounded to local fixtures and does not validate market adoption or external pricing.",
      ].join("\n"),
    });

    assert.equal(coverage.required.includes("pricing"), false);
    assert.deepEqual(coverage.issues, []);
  });

  it("does not infer pricing slots from literal permission token instructions", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Run the approval-gated browser E2E.",
        "Do not paraphrase the literal tokens permission.query, permission.result, permission.applied, or browser.form.submit.",
        "Use the exact final answer shape after the browser worker result returns.",
      ].join("\n"),
      finalText: [
        "## Evidence",
        "- Approval request: TURNKEYAI_MISSION_APPROVAL_OK; permission.query blocked browser.form.submit before browser work started.",
        "- Approval decision/application: permission.result approved the request and permission.applied cached it for the runtime gate.",
        "- Browser fixture evidence: source approval-gated-browser-e2e; sessions_spawn(browser) verified TURNKEYAI_APPROVAL_FIXTURE_OK on the local fixture and no external mutation was performed.",
        "- Residual risk: this validates the approval gate and local fixture path, not a real external submit.",
      ].join("\n"),
    });

    assert.equal(coverage.required.includes("pricing"), false);
    assert.deepEqual(coverage.issues, []);
  });

  it("passes a pricing goal when the final answer carries a concrete price", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Find the pricing for the Acme plan.",
      finalText: "Acme Pro costs $42 per seat per month, billed annually.",
    });
    assert.ok(coverage.required.includes("pricing"));
    assert.equal(coverage.issues.length, 0);
  });

  it("flags a pricing goal as missing when no concrete price is present", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Find the pricing for the Acme plan.",
      finalText: "Acme has several plans aimed at teams of different sizes.",
    });
    const pricing = coverage.issues.find((issue) => issue.slot === "pricing");
    assert.ok(pricing, "expected a pricing issue");
    assert.equal(pricing.reason, "missing");
  });

  it("flags a pricing claim the answer itself marks unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Find the pricing for the Acme plan.",
      finalText: "Pricing is not verified; the pricing page did not load.",
    });
    const pricing = coverage.issues.find((issue) => issue.slot === "pricing");
    assert.ok(pricing, "expected a pricing issue");
    assert.equal(pricing.reason, "unverified");
  });

  it("requires the delegated-research slot to meet the inferred stream count", () => {
    const goalText =
      "Delegate to two independent researchers to separately gather evidence and report back.";
    const missing = evaluateMissionGoalSlotCoverage({
      goalText,
      finalText: "One researcher gathered evidence on the topic.",
      evidence: { completedSessionResultCount: 1 },
    });
    assert.ok(missing.required.includes("delegated_independent_research"));
    assert.ok(
      missing.issues.some(
        (issue) => issue.slot === "delegated_independent_research" && issue.reason === "missing"
      )
    );

    const covered = evaluateMissionGoalSlotCoverage({
      goalText,
      finalText: "Two independent researchers each gathered and reported evidence.",
      evidence: { completedSessionResultCount: 2 },
    });
    assert.equal(
      covered.issues.some((issue) => issue.slot === "delegated_independent_research"),
      false
    );
  });

  it("accepts AsiaWalk readiness as conditional when all delegated streams are evidenced", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Use three separate evidence streams: route shape, budget, and live readiness.",
        "If a stream is unavailable, say what was verified, what remains unverified, and how to continue.",
        "The final answer must include route shape, budget, readiness risks, go/no-go recommendation, and next action.",
      ].join("\n"),
      finalText: [
        "## AsiaWalk Pilot Brief",
        "### Route Shape",
        "- Leg 1: Seoul orientation walk.",
        "- Leg 2: Taipei food-and-transit loop.",
        "- Leg 3: Tokyo neighborhood finale.",
        "- Not verified: exact trip duration, per-person pricing, group size, booking mechanism, individual leg dates.",
        "### Budget",
        "- Pilot budget: $1,280; contingency buffer: $180.",
        "- Not verified: whether the $180 is embedded in or additive to the $1,280.",
        "### Readiness Risks",
        "- Overall readiness status: Yellow (conditional, not confirmed).",
        "- Rain risk in Taipei; metro maintenance in Tokyo.",
        "### Go / No-Go Recommendation",
        "- Conditional Go after guide availability and indoor alternates are confirmed.",
        "### Next Action",
        "- Re-score the live readiness dashboard after completing the confirmations.",
        "### Evidence / Sources",
        "- AsiaWalk Route Stream - verified route shape and transfer policy.",
        "- AsiaWalk Budget Stream - verified pilot budget and contingency.",
        "- AsiaWalk Live Readiness Stream - verified yellow readiness status and readiness risks.",
      ].join("\n"),
      evidence: { completedSessionResultCount: 3, sessionSpawnCount: 3 },
    });

    assert.ok(coverage.required.includes("delegated_independent_research"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts AsiaWalk readiness risks when only operator follow-up confirmations remain unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Route source: http://127.0.0.1/asiawalk-route",
        "Budget source: http://127.0.0.1/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1/asiawalk-live",
        "Treat route, budget, and live readiness as separate evidence streams.",
        "Inspect the live readiness dashboard as rendered browser evidence.",
        "The final brief should cover the route shape, budget, readiness risks, go/no-go recommendation, and next action.",
      ].join("\n"),
      finalText: [
        "## AsiaWalk Pilot Brief",
        "Route: Seoul orientation walk, Taipei food-and-transit loop, and Tokyo neighborhood finale.",
        "Budget: $1,280 total with a $180 contingency buffer.",
        "Readiness risks: verified yellow readiness, rain risk in Taipei, and metro maintenance in Tokyo.",
        "Unverified: guide availability and indoor alternates.",
        "Recommendation: conditional go.",
        "Next action: confirm guide availability and indoor alternates before deposits.",
      ].join("\n"),
      evidence: { completedSessionResultCount: 3 },
    });

    assert.ok(coverage.required.includes("rendered_browser"));
    assert.ok(coverage.required.includes("delegated_independent_research"));
    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("still flags an unavailable required AsiaWalk evidence stream", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Use three separate evidence streams: route shape, budget, and live readiness.",
      ].join("\n"),
      finalText: [
        "Route and budget streams returned evidence.",
        "AsiaWalk Live Readiness Stream was unavailable; live readiness evidence was not verified.",
        "Recommendation remains blocked until the live readiness page can be retrieved.",
      ].join("\n"),
      evidence: { completedSessionResultCount: 3, sessionSpawnCount: 3 },
    });

    assert.deepEqual(
      coverage.issues.filter((issue) => issue.slot === "delegated_independent_research"),
      [
        {
          slot: "delegated_independent_research",
          label: "delegated research",
          reason: "unverified",
        },
      ]
    );
  });

  it("evaluates a Chinese-language goal and answer (not English-marker-only)", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "请调研 Acme 套餐的价格，并指出主要风险。",
      finalText: "价格：Acme 专业版每席位 $42/月。风险：该来源未覆盖企业级合规要求。",
    });
    assert.ok(coverage.required.includes("pricing"));
    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts a concrete residual-risk fact even when the risk item is unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Continue from the long Aurora-19 launch handoff in this mission.",
        "Use durable memory lookup, then recover the launch window, owner, hard constraint, and residual risk if available.",
      ].join("\n"),
      finalText: [
        "**AURORA-19 - INTERNAL CONTINUITY NOTE**",
        "",
        "| Field | Value | Source |",
        "|---|---|---|",
        "| Project codename | Aurora-19 | thread-memory |",
        "| Launch window | Friday 14:15 | thread-memory |",
        "| Owner | Field Ops Lead | thread-memory |",
        "| Hard constraint | External announcement BLOCKED - conditional until Legal Review confirms the data-processing addendum | thread-memory |",
        "| Residual risk | Vendor dry-run note unverified - all external commitments stay conditional | thread-memory |",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.deepEqual(coverage.issues, []);
  });

  it("still flags a risk slot when the answer only says the risk itself is unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Recover the main residual risk for Aurora-19.",
      finalText: "Risk status: unverified; I do not know what it is.",
    });

    assert.deepEqual(coverage.issues, [
      { slot: "risk_or_limitation", label: "risk or limitation", reason: "unverified" },
    ]);
  });

  it("flags a Chinese answer that leaves a required slot unfilled", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "请调研 Acme 套餐的价格。",
      finalText: "Acme 提供多种面向团队的套餐。",
    });
    assert.ok(
      coverage.issues.some((issue) => issue.slot === "pricing" && issue.reason === "missing")
    );
  });

  it("does not couple to specific vendor names or fixture prices", () => {
    // A real, non-fixture vendor with an arbitrary price must satisfy the
    // pricing slot — the gate must infer from structure, not memorized strings.
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Compare the pricing of Globex and Initech model APIs.",
      finalText:
        "Globex charges $1.37 per million input tokens; Initech charges $2.05 per million input tokens.",
    });
    assert.ok(coverage.required.includes("pricing"));
    assert.equal(
      coverage.issues.some((issue) => issue.slot === "pricing"),
      false
    );
  });

  it("accepts source-bounded provider residual scope after concrete provider search pricing evidence", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Identify which providers are listed, whether each provider supports search, and the input/output token pricing for each provider.",
      finalText: [
        "**Providers listed:** OpenRouter, Together, Fireworks — all running model `deepseek-v4-flash`.",
        "| Provider | Search support | Input price | Output price |",
        "|---|---|---|---|",
        "| OpenRouter | Yes — via `web_search` option | $0.28 / 1M tokens | $0.42 / 1M tokens |",
        "| Together | No | $0.20 / 1M tokens | $0.40 / 1M tokens |",
        "| Fireworks | No | $0.25 / 1M tokens | $0.45 / 1M tokens |",
        "**What remains unverified:** whether additional providers beyond the three listed on this page exist elsewhere.",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("provider"));
    assert.ok(coverage.required.includes("search"));
    assert.ok(coverage.required.includes("pricing"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts provider pricing tables with production cross-checks left as residual scope", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Identify which providers are listed, whether each provider supports search, and the input/output token pricing for each provider.",
      finalText: [
        "**Mission 状态：done** Final synthesis unavailable; this local evidence fallback preserves the source-backed requested provider/search/pricing columns. Source labels covered: DeepSeek Provider Pricing Research; DeepSeek V4 Flash API provider pricing.",
        "| provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| OpenRouter | 是（页面含模型与价格） | 是 - via `web_search` option | $0.28/1M | $0.42/1M | 未验证 | Provider name: OpenRouter Model: deepseek-v4-flash Search capability: Supported through the `web_search` option Input token pricing: $0.28 per 1M tokens Output token pricing: $0.42 per 1M tokens |",
        "| Together | 是（页面含模型与价格） | 否 - not supported | $0.20/1M | $0.40/1M | 未验证 | Provider name: Together Model: deepseek-v4-flash Search capability: Not supported Input token pricing: $0.20 per 1M tokens Output token pricing: $0.40 per 1M tokens |",
        "| Fireworks | 是（页面含模型与价格） | 否 - search must be supplied externally | $0.25/1M | $0.45/1M | 未验证 | Provider name: Fireworks Model: deepseek-v4-flash Search capability: Good latency profile; search must be supplied externally Input token pricing: $0.25 per 1M tokens Output token pricing: $0.45 per 1M tokens |",
        "Lowest-cost option: Together.",
        "Option that supports search: OpenRouter.",
        "Residual scope: provider/search/pricing facts are source-bounded to the completed evidence rows above; broader real-world freshness remains outside this run.",
      ].join(" "),
    });

    assert.ok(coverage.required.includes("search"));
    assert.ok(coverage.required.includes("pricing"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts source-bounded local fixture pricing residual after concrete comparison prices", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Compare Vendor Alpha and Vendor Beta. Report pricing, strength, and risk, then state residual risk for the two local fixture sources.",
      finalText: [
        "## Source coverage",
        "- Alpha evidence: TURNKEYAI_VENDOR_ALPHA_OK; $19 per seat; browser automation and traceable screenshots; risk is limited API integration catalog.",
        "- Beta evidence: TURNKEYAI_VENDOR_BETA_OK; $29 per workspace; approval workflow and team handoff history; risk is separate connector for browser control.",
        "- comparison conclusion: TURNKEYAI_MISSION_COMPARISON_OK; Alpha fits browser-centric lower-cost work, while Beta fits approval-heavy team handoff work.",
        "- residual risk: source-bounded to two local fixture sources; pricing and feature depth are not verified elsewhere.",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("pricing"));
    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts verified core pricing and risk while extra pricing and risk dimensions remain unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Use the provided source to prepare a decision note for a product lead. Include pricing, strengths, risks or limitations, and a recommendation.",
      finalText: [
        "## Decision Note: Vendor Alpha",
        "",
        "| Dimension | Value | Source |",
        "|---|---|---|",
        "| Price per seat | $19 | http://127.0.0.1:57592/vendor-alpha |",
        "| Model | Seat-based | http://127.0.0.1:57592/vendor-alpha |",
        "| Tiers / plans | not verified | — |",
        "| Free tier or trial | not verified | — |",
        "| Enterprise pricing | not verified | — |",
        "",
        "### Risks / Limitations",
        "- Limited API integration catalog — \"API integration catalog is still limited.\"",
        "",
        "### Residual Risk",
        "- Pricing completeness: Tiers/plans, free tier/trial, and enterprise pricing are not present in the source page.",
        "- No additional risk or limitation details are present in the page. Further risk slots cannot be verified from this source without additional documentation.",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("pricing"));
    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts Vendor Alpha profile pricing when only comparison-readiness dimensions are unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Start a source-backed review of Vendor Alpha for a product lead. Focus on pricing, strength, and risk.",
      finalText: [
        "## Vendor Alpha — Product Lead Review",
        "",
        "### Pricing",
        "- **$19 / seat** (flat per-seat model; plan tier count, billing period, and enterprise tiers not verified) — [source: vendor-alpha]",
        "",
        "### Strengths",
        "- **Browser automation** — confirmed by vendor page — [source: vendor-alpha]",
        "- **Traceable screenshots** — confirmed by vendor page — [source: vendor-alpha]",
        "",
        "### Risks",
        "- **Limited API integration catalog** — vendor uses \"still limited\" language; specific missing integrations and expansion roadmap not verified — [source: vendor-alpha]",
        "",
        "### Comparison-Ready Gaps",
        "| Dimension | Status |",
        "|-----------|--------|",
        "| Pricing period (monthly / annual) | not verified |",
        "| Plan tiers | not verified |",
        "| Volume discounts | not verified |",
        "| Free trial or free tier | not verified |",
        "| Enterprise pricing | not verified |",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("pricing"));
    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts terse Vendor Alpha residual API-catalog risk from source-bounded evidence", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Start a source-backed review of Vendor Alpha for a product lead.",
        "Source: http://127.0.0.1:54881/vendor-alpha",
        "Keep the work useful for a likely follow-up comparison rather than writing a one-off trivia answer.",
        "Focus on pricing, strength, and risk, and keep source labels visible in the answer.",
      ].join("\n"),
      finalText: [
        "Verified: Source 1: Vendor Alpha Product Lead Review Evidence.",
        "Pricing: $19 per seat observed from source excerpt.",
        "Strength: browser automation and traceable screenshots.",
        "Risks: limited API catalog remains unverified.",
      ].join("\n"),
      evidence: { completedSessionResultCount: 1 },
    });

    assert.ok(coverage.required.includes("pricing"));
    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts a verified core risk when a blocked closeout only marks additional risk dimensions unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Use the provided source to prepare a decision note for a product lead. Include risks or limitations and a recommendation.",
      finalText: [
        "### Risks / Limitations",
        "- Limited API integration catalog — \"API integration catalog is still limited.\" *(Source: http://127.0.0.1:57592/vendor-alpha)*",
        "",
        "**Blocked closeout (risk/limitation slot — evidence exhausted):**",
        "Two sub-agent sessions and two direct continuations confirmed the source page contains the single risk line.",
        "No additional risk or limitation details are present in the page.",
        "Further risk slots cannot be verified from this source without access to additional pages or documentation not provided in the original task.",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts a verified release risk when only risks beyond that risk remain unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Recover the cancelled release-risk follow-up and include source-backed risk or limitation evidence.",
      finalText: [
        "## Release-Risk Note: Source Check Completed (Resume Success)",
        "",
        "Verified risk: runbook gap before launch approval.",
        "Mitigation: complete rollback rehearsal before release gate.",
        "",
        "| Dimension | Value | Evidence |",
        "|---|---|---|",
        '| Identified risk | Runbook gap before launch approval | "Verified risk: runbook gap before launch approval." |',
        "",
        "### Unverified Items",
        "| Additional risks beyond runbook gap | not verified |",
        "",
        "### Residual Risk",
        "- Primary risk: Runbook gap before launch approval.",
        "- Mitigation: Rollback rehearsal must complete before the release gate.",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts product workbench residual risk bounded to local fixtures after concrete risk evidence", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Mission route product workbench brief E2E",
        "",
        "Prepare a decision-grade product brief for the next agent workbench release.",
        "Use the available session tools. Do not answer from memory.",
        "Gather evidence from three independent child sessions before finalizing:",
        '- Orchestration: use an explore session with label "Orchestration research" to fetch http://127.0.0.1:60672/product-orchestration and extract marker TURNKEYAI_PRODUCT_ORCHESTRATION_OK, primary user story, strength, and gap.',
        '- Bridge capability: use an explore session with label "Bridge capability research" to fetch http://127.0.0.1:60672/product-bridge and extract marker TURNKEYAI_PRODUCT_BRIDGE_OK, controls, boundary, and risk.',
        '- Product signals: use a browser session with label "Product signals browser", not direct fetch, to open http://127.0.0.1:60672/product-signals; inspect the JavaScript-rendered dashboard and extract marker TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK, Stuck missions: 6, Weak answer rate: 24%, and the recommended next action.',
        "Each sessions_spawn input must include the exact label named above for that source.",
        "Do not finalize until all three child session tool results have returned and all three markers are present in tool evidence.",
        "The final answer must be useful to a product lead. It must state what to build next, why, what not to over-emphasize, and what risk remains.",
        "Do not frame browser control as the product itself; frame it as one capability inside a larger multi-agent workbench.",
        "Do not claim a native Electron/Tauri shell is already shipped.",
        "Do not infer market adoption, external outages, customer counts, or external pricing beyond the local fixture text.",
        "Never write assume, assumed, estimate, probably, maybe, to be confirmed, or pending confirmation in the final answer.",
        "The bridge evidence bullet must keep the phrase browser bridge controls unless doing so would duplicate the source label awkwardly.",
        'The recommendation bullet must start with "- recommendation: TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK" and state the release decision.',
        "Keep the final answer concise, under 230 words.",
        "Use exactly this section skeleton for the final answer, with no preamble before it and no closing note after it:",
        "The first non-empty line of the final answer must be exactly: evidence",
        "Do not write any completion/status sentence before the first section label.",
        "evidence",
        "- orchestration evidence: Orchestration research; TURNKEYAI_PRODUCT_ORCHESTRATION_OK; include primary user story, multi-agent decomposition, durable sub-session history, and gap.",
        "- bridge evidence: Bridge capability research; TURNKEYAI_PRODUCT_BRIDGE_OK; browser bridge controls; include browser-only boundary and first-run setup risk.",
        "- browser signal evidence: Product signals browser; TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK; include Stuck missions: 6, Weak answer rate: 24%, and that the evidence came from browser-rendered JavaScript or client-rendered DOM.",
        "decision",
        "- recommendation: TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK - make Mission Control the default entry and gate release on real LLM scenario quality before expanding native shell work.",
        "- next actions: list exactly three concrete build actions for onboarding, mission completion quality, and bridge/runtime diagnostics.",
        "- residual risk: state what remains source-bounded to local fixtures and what still needs real-world validation.",
        "Do not include source URLs in the final answer; cite source names and markers instead.",
        "Use plain section labels or plain Markdown headings only; do not wrap section labels in ** or __.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
      finalText: [
        "evidence",
        "- orchestration evidence: Orchestration research; TURNKEYAI_PRODUCT_ORCHESTRATION_OK; primary user story confirms a product lead starts one mission and specialist agents produce a decision-ready brief; strength is multi-agent decomposition with durable sub-session history; gap is users need clearer entry points than a developer command line.",
        "- bridge evidence: Bridge capability research; TURNKEYAI_PRODUCT_BRIDGE_OK; browser bridge controls include opening pages, inspecting rendered DOM, acting on coordinates and forms after approval, and collecting screenshots and artifacts; boundary is browser-only scope with no desktop control outside the browser; risk is first-run adoption blocked by command-line setup and provider configuration.",
        "- browser signal evidence: Product signals browser; TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK; Stuck missions: 6, Weak answer rate: 24%; recommended next action extracted from browser-rendered JavaScript or client-rendered DOM is to make Mission Control the default entry and gate release on real LLM scenario quality.",
        "decision",
        "- recommendation: TURNKEYAI_MISSION_PRODUCT_WORKBENCH_OK - make Mission Control the default entry and gate release on real LLM scenario quality before expanding native shell work.",
        "- next actions: (1) Build a guided onboarding flow to reduce the developer command-line barrier. (2) Address mission completion quality to clear the 6 stuck missions and lower the 24% weak answer rate. (3) Add bridge and runtime diagnostics to surface first-run setup failures early.",
        "- residual risk: all signals are source-bounded to local fixtures; real-world LLM scenario quality and actual user onboarding friction remain unvalidated outside the local environment.",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts rendered dashboard facts with a bounded unverified rendered-page sub-scope heading", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Review the operations dashboard as a user would see it in the browser. Include rendered dashboard facts, escalation action, owner, residual risk, and what remains unverified.",
      finalText: [
        "## Operational State - Dashboard Evidence Report",
        "Source: http://127.0.0.1:49308/ops-dashboard",
        "Render method: browser-rendered (client-side rendering completed)",
        "Evidence label: ops-dashboard-read",
        "### Verified Dashboard Facts",
        "| Slot | Verified Value |",
        "|---|---|",
        "| Triage status | TURNKEYAI_DASHBOARD_TRIAGE_OK |",
        "| Queue depth | 11 |",
        "| SLA breaches | 3 |",
        "| Escalation action | Pages the on-call |",
        "| Recommended owner | Incident Commander |",
        "Residual risk: this is a local dynamic dashboard fixture only; production paging and service-level root cause remain outside this check.",
        "### Still Unverified on This Rendered Page",
        "- Per-service health breakdown",
        "- Escalation policy ID or tier structure",
        "- On-call contact name or handle",
        "Evidence / Sources: ops-dashboard-full (completed delegated evidence).",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("rendered_browser"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts browser-rendered dashboard facts with extra unverified operational dimensions", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText:
        "Review the operations dashboard as a user would see it in the browser. Include rendered dashboard facts, escalation action, owner, residual risk, and what remains unverified.",
      finalText: [
        "**Operational State - Browser-Rendered Evidence**",
        "- **Queue depth:** 11",
        "- **SLA breach count:** 3",
        "- **Triage/status badge:** `TURNKEYAI_DASHBOARD_TRIAGE_OK`",
        '- **Escalation threshold:** "queue depth above 5 or SLA breaches above 0 pages the on-call"',
        "- **Owner:** Incident Commander",
        "",
        "**Residual Risk / Unverified Scope:**",
        "| Item | Status |",
        "|---|---|",
        "| Interactive controls | not verified - not rendered in this browser view |",
        "| Escalation notification delivery confirmation | not verified - page describes the action but does not confirm delivery |",
        "| Historical trend data or charts | not verified - not rendered in this view |",
        "| Downstream system dependencies | not verified - no service map or dependency panel visible |",
        "| Owner contact information | not verified - role name shown only; no phone/email/channel |",
        "| Live production connection | confirmed: this is a local dynamic fixture only, not a live system |",
      ].join("\n"),
    });

    assert.ok(coverage.required.includes("rendered_browser"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("accepts complex browser facts with bounded unverified frame shadow and popup sub-scopes", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: [
        "Review this complex browser page as an operator would see it.",
        "Page: http://127.0.0.1:49196/complex-browser.",
        "The page combines an embedded source frame, a shadow-style review component, and a details popup workflow.",
        "Open the details popup, then summarize the visible operational state, owner, approval requirement, and residual risk.",
        "Use only what the browser-visible page state actually shows. If a section is unavailable, say what was and was not verified.",
      ].join(" "),
      finalText: [
        "## Complex Browser Workbench Fixture - Operator Review",
        "Browser session: browser-session-1783464026470 (resumed cold).",
        "Operational state: embedded source frame backlog 7.",
        "Owner: Frame Captain.",
        "Approval requirement: shadow review says risk desk approval required; details popup opened with packet P-42 requiring manager acknowledgement.",
        "Residual risk: local complex browser fixture only.",
        "What was not verified: full shadow DOM internal structure, complete embedded frame content beyond backlog 7 and owner Frame Captain, popup form controls or additional popup fields.",
      ].join("\n"),
      evidence: { completedSessionResultCount: 1 },
    });

    assert.ok(coverage.required.includes("rendered_browser"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("renders a human-readable detail string for issues and for clean coverage", () => {
    assert.match(missionGoalSlotIssueDetail([]), /All goal-critical slots/);
    assert.match(
      missionGoalSlotIssueDetail([{ slot: "pricing", label: "pricing", reason: "missing" }]),
      /pricing \(missing\)/
    );
  });
});
