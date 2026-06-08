import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { chromium } from "playwright-core";
import type { Browser, BrowserContextOptions, Page } from "playwright-core";

const args = process.argv.slice(2);
let explicitBrowserPath: string | undefined;
let headful = false;
let allowMissingBrowser = false;
let artifactDir: string | undefined = process.env.TURNKEYAI_CONTROL_CENTER_SMOKE_ARTIFACT_DIR;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--browser-path") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --browser-path");
    }
    explicitBrowserPath = value;
    index += 1;
    continue;
  }
  if (arg === "--artifact-dir") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --artifact-dir");
    }
    artifactDir = value;
    index += 1;
    continue;
  }
  if (arg === "--headed") {
    headful = true;
    continue;
  }
  if (arg === "--allow-missing-browser") {
    allowMissingBrowser = true;
    continue;
  }
  throw new Error(`unknown argument: ${arg}`);
}

const distDir = path.resolve(process.cwd(), "packages/control-center/dist");
const indexHtmlPath = path.join(distDir, "index.html");
await access(indexHtmlPath).catch(() => {
  throw new Error("Control Center dist is missing. Run `npm run build:control-center` before control-center:smoke.");
});

const missionId = "msn.ui-smoke.1";
const threadId = "thr.ui-smoke.1";
const requestedPaths: string[] = [];
const postedMissions: unknown[] = [];
const postedMessages: unknown[] = [];
const postedContextSources: unknown[] = [];
const postedRecoveryActions: string[] = [];
const postedMissionReconciles: string[] = [];
const postedMissionArchives: string[] = [];
const postedToolCancellations: unknown[] = [];
const savedModelCatalogContents: string[] = [];
let onboardingState = onboardingStateFixture();
const browserConsoleErrors: string[] = [];
const browserPageErrors: string[] = [];
const smokeArtifactDir = artifactDir?.trim() ? path.resolve(process.cwd(), artifactDir.trim()) : undefined;
const port = await resolveFreePort();
const sockets = new Set<net.Socket>();
const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error: unknown) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  });
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
});

let browser;
try {
  const browserPath = await resolveChromePath(explicitBrowserPath ?? process.env.TURNKEYAI_BROWSER_PATH).catch((error) => {
    if (allowMissingBrowser) {
      console.log(`control-center-ui-smoke: skipped (${error.message})`);
      return null;
    }
    throw error;
  });
  if (!browserPath) {
    process.exitCode = 0;
  } else {
    await runHumanProductSmoke(browserPath);
    const runLegacySmoke = false;
    if (runLegacySmoke) {
    browser = await chromium.launch({
      executablePath: browserPath,
      headless: !headful,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const noTokenPage = await newSmokePage(browser, { viewport: { width: 1100, height: 760 } });
    await noTokenPage.goto(`http://127.0.0.1:${port}/app#/missions`, {
      waitUntil: "domcontentloaded",
    });
    await noTokenPage.waitForSelector(".launch-command-list");
    assert(
      await noTokenPage.locator("text=Auth token required").isVisible(),
      "no-token page should explain that a daemon token is required"
    );
    assert(
      await noTokenPage.locator("text=npx @turnkeyai/cli app").isVisible(),
      "no-token page should include the no-install launcher"
    );
    assert(
      await noTokenPage.locator("text=launchers/TurnkeyAI Mission Control.command").isVisible(),
      "no-token page should include the bundled source-checkout launcher"
    );
    assert(
      await noTokenPage.locator("text=npm run app:install-launcher").isVisible(),
      "no-token page should include the source-checkout launcher installer"
    );
    assert(
      await noTokenPage.locator("text=npm run install:local-cli").isVisible(),
      "no-token page should include the local CLI linker"
    );
    assert(
      await noTokenPage.locator("text=npm run app -- --no-open").isVisible(),
      "no-token page should include the source-checkout launcher"
    );
    assert(
      await noTokenPage.locator("text=npm run daemon:status").isVisible(),
      "no-token page should include the source-checkout daemon status fallback"
    );
    assert(
      await noTokenPage.locator("text=turnkeyai daemon service install").isVisible(),
      "no-token page should include the persistent daemon service installer"
    );
    assert(
      await noTokenPage
        .locator(".launch-command", { hasText: "Reload service config" })
        .locator("code", { hasText: "turnkeyai daemon service restart" })
        .isVisible(),
      "no-token page should include the persistent daemon service restart command"
    );
    assert(
      await noTokenPage.locator("text=turnkeyai daemon service status").isVisible(),
      "no-token page should include the persistent daemon service status command"
    );
    await noTokenPage.close();

    const operatorRuntimePage = await newSmokePage(browser, { viewport: { width: 1100, height: 760 } });
    await operatorRuntimePage.addInitScript(() => {
      sessionStorage.setItem("turnkeyai.controlCenter.token", "ui-smoke-operator-token");
      sessionStorage.setItem("turnkeyai.controlCenter.scope", "operator");
    });
    await operatorRuntimePage.goto(`http://127.0.0.1:${port}/app#/runtime`, {
      waitUntil: "domcontentloaded",
    });
    await operatorRuntimePage.waitForSelector("text=Runtime attention");
    await operatorRuntimePage.waitForSelector("text=Mission health");
    await waitForReplayReady(operatorRuntimePage);
    assert(
      await operatorRuntimePage.locator(".card", { hasText: "Dashboard comparison mission" }).isVisible(),
      "operator runtime should surface mission health attention rows"
    );
    assert(
      await operatorRuntimePage.locator(".card", { hasText: "longest active 2m 5s" }).isVisible(),
      "operator runtime should surface longest active mission duration"
    );
    assert(
      await operatorRuntimePage.locator(".card", { hasText: "profile fallback 1" }).isVisible(),
      "operator runtime should surface aggregate browser profile fallback count"
    );
    assert(
      await operatorRuntimePage.locator(".card", { hasText: "browser buckets browser_cdp_unavailable 1" }).isVisible(),
      "operator runtime should surface aggregate browser failure buckets"
    );
    assert(
      await operatorRuntimePage.locator(".runtime-health-row", { hasText: "1 profile fallback" }).isVisible(),
      "operator runtime should show mission-level browser profile fallback attention"
    );
    assert(
      await operatorRuntimePage.locator(".runtime-health-row", { hasText: "browser_cdp_unavailable 1" }).isVisible(),
      "operator runtime should show mission-level browser failure bucket attention"
    );
    assert(
      await operatorRuntimePage.locator(".runtime-health-row", { hasText: "running 2m 5s" }).isVisible(),
      "operator runtime should show per-attention mission wall-clock duration"
    );
    await operatorRuntimePage.getByRole("button", { name: "Reconcile" }).click();
    await operatorRuntimePage.waitForSelector("text=Reconciled 1 linked mission");
    assert(
      JSON.stringify(postedMissionReconciles) === JSON.stringify(["all"]),
      "operator runtime should call mission reconcile"
    );
    assert(
      await operatorRuntimePage.locator(".card", { hasText: "Release acceptance" }).isVisible(),
      "operator runtime should still render the release acceptance card"
    );
    assert(
      await operatorRuntimePage.locator(".card", { hasText: "local-automation · healthy" }).isVisible(),
      "operator runtime should surface bridge transport health from /bridge/status"
    );
    assert(
      await operatorRuntimePage.locator(".card", { hasText: "admin token required" }).isVisible(),
      "operator runtime should explain that validation ops require admin scope"
    );
    assert(
      await operatorRuntimePage.locator("text=Auth token required").count() === 0,
      "operator runtime must not clear the token when validation ops are admin-only"
    );
    await operatorRuntimePage.close();

    const readMissionPage = await newSmokePage(browser, { viewport: { width: 1100, height: 760 } });
    await readMissionPage.addInitScript(() => {
      sessionStorage.setItem("turnkeyai.controlCenter.token", "ui-smoke-read-token");
      sessionStorage.setItem("turnkeyai.controlCenter.scope", "read");
    });
    await readMissionPage.goto(`http://127.0.0.1:${port}/app#/mission/${encodeURIComponent(missionId)}`, {
      waitUntil: "domcontentloaded",
    });
    const readRecoveryCard = readMissionPage.locator(".mission-recovery-card", {
      hasText: "operator or admin token",
    });
    await readRecoveryCard.waitFor({ state: "visible", timeout: 15_000 });
    assert(
      await readRecoveryCard.isVisible(),
      "read-scope mission replay should explain that recovery actions need operator scope"
    );
    assert(
      await readMissionPage.getByRole("button", { name: "Approve recovery" }).isDisabled(),
      "read-scope mission replay should disable recovery approvals"
    );
    assert(
      await readMissionPage.getByLabel("Follow-up message to mission team").isDisabled(),
      "read-scope mission replay should disable follow-up messages"
    );
    await readMissionPage.getByRole("button", { name: "Show trace" }).click();
    await readMissionPage.waitForSelector(".tool-process-session-action-row");
    assert(
      await readMissionPage.getByRole("button", { name: /Continue session/ }).isDisabled(),
      "read-scope mission replay should disable sub-agent continuation"
    );
    await readMissionPage.close();

    const readApprovalsPage = await newSmokePage(browser, { viewport: { width: 1100, height: 760 } });
    await readApprovalsPage.addInitScript(() => {
      sessionStorage.setItem("turnkeyai.controlCenter.token", "ui-smoke-read-token");
      sessionStorage.setItem("turnkeyai.controlCenter.scope", "read");
    });
    await readApprovalsPage.goto(`http://127.0.0.1:${port}/app#/approvals`, {
      waitUntil: "domcontentloaded",
    });
    await readApprovalsPage.waitForSelector("text=Approvals");
    assert(
      await readApprovalsPage.locator("text=Approval decisions require an operator or admin token.").isVisible(),
      "read-scope approvals page should explain decision scope"
    );
    assert(
      await readApprovalsPage.getByRole("button", { name: "Approve" }).isDisabled(),
      "read-scope approvals page should disable approval decisions"
    );
    assert(
      await readApprovalsPage.getByRole("button", { name: "Deny" }).isDisabled(),
      "read-scope approvals page should disable denial decisions"
    );
    await readApprovalsPage.close();

    const page = await newSmokePage(browser, { viewport: { width: 1440, height: 980 } });
    page.on("console", (message) => {
      if (message.type() === "error") {
        if (isIgnorableConsoleError(message.text())) return;
        const location = message.location();
        const source = location.url ? ` ${location.url}:${location.lineNumber}` : "";
        browserConsoleErrors.push(`browser-console-error:${source} ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      browserPageErrors.push(`browser-page-error: ${error.message}`);
    });
    await page.addInitScript(() => {
      sessionStorage.setItem("turnkeyai.controlCenter.token", "ui-smoke-admin-token");
      sessionStorage.setItem("turnkeyai.controlCenter.scope", "admin");
    });
    await page.goto(`http://127.0.0.1:${port}/app#/missions`, {
      waitUntil: "domcontentloaded",
    });

    await page.goto(`http://127.0.0.1:${port}/app#/agents`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=Agents");
    await page.getByRole("button", { name: /Manage tokens/ }).click();
    await page.waitForSelector("text=Settings");
    assert(page.url().includes("#/settings"), "agents token action should route to settings");
    await page.goto(`http://127.0.0.1:${port}/app#/agents`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /Connect agent/ }).click();
    await page.waitForSelector("text=Agent Connect");
    assert(page.url().includes("#/agent-connect"), "agents connect action should route to Agent Connect");

    await page.goto(`http://127.0.0.1:${port}/app#/missions`, {
      waitUntil: "domcontentloaded",
    });
    const currentMissionCard = page.locator(".mission-card", { hasText: "UI smoke mission" });
    const archivedMissionCard = page.locator(".mission-card", { hasText: "Archived UI smoke mission" });
    await currentMissionCard.waitFor({ state: "visible" });
    assert(
      await currentMissionCard.isVisible(),
      "current missions should show non-archived mission cards by default"
    );
    assert(
      (await archivedMissionCard.count()) === 0,
      "archived missions should be hidden from the default Current filter"
    );
    await page.getByRole("button", { name: /Archived\s+1/ }).click();
    await archivedMissionCard.waitFor({ state: "visible" });
    assert(
      await archivedMissionCard.isVisible(),
      "Archived filter should expose archived missions explicitly"
    );
    await page.getByRole("button", { name: /Current\s+1/ }).click();
    await currentMissionCard.waitFor({ state: "visible" });
    await page.getByRole("button", { name: /New mission/ }).first().click();
    await page.waitForSelector("text=Agent team");
    await page.locator("input").first().fill("Browser-backed competitor check");
    await page.locator("textarea").fill("Open dynamic pages, collect browser evidence, and compare the result.");
    await page.locator(".modal-panel select").selectOption("browser");
    await page.waitForSelector(".agent-select-item.selected", { state: "attached" });
    assert(
      await page.locator(".agent-select-item.selected", { hasText: "Browser Operator" }).isVisible(),
      "browser mode should auto-select the browser operator"
    );
    assert(
      await page.locator(".agent-select-item.selected", { hasText: "Reviewer" }).isVisible(),
      "browser mode should keep reviewer selected for verification"
    );
    await page.getByRole("button", { name: "Create mission" }).click();
    await page.waitForSelector(".mission-bar");
    assert(postedMissions.length === 1, "expected one create mission POST");
    assert(
      JSON.stringify(postedMissions[0]).includes('"mode":"browser"'),
      "create mission POST should include selected mode"
    );
    assert(
      JSON.stringify(postedMissions[0]).includes("agent.browser"),
      "create mission POST should include selected browser agent"
    );

    await page.goto(`http://127.0.0.1:${port}/app#/mission/${encodeURIComponent(missionId)}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector(".thinking-card");
    await page.waitForSelector(".mission-progress-card");
    await page.waitForSelector(".context-continuity-card");
    await page.waitForSelector(".browser-continuity-card");
    await page.waitForSelector(".mission-recovery-card");
    await page.waitForSelector(".mission-evidence-card");
    await page.waitForSelector(".final-answer-card .markdown-body h2");
    await page.waitForSelector(".final-answer-card .markdown-body ul li");
    await page.waitForSelector(".final-answer-card .markdown-body table");
    await page.waitForSelector(".final-answer-card .markdown-body code");

    assert(await page.locator(".final-answer-card").count() === 1, "expected exactly one final answer card");
    assert(await page.locator(".mission-progress-card").count() === 1, "expected exactly one mission progress card");
    assert(
      await page.locator(".mission-progress-card", { hasText: "Done, needs attention" }).isVisible(),
      "mission progress should summarize current mission status"
    );
    assert(
      await page.locator(".mission-progress-card", { hasText: "tool · role-lead" }).isVisible(),
      "mission progress should show the latest replay event"
    );
    assert(
      await page.locator(".mission-progress-card", { hasText: "sessions_send · call" }).isVisible(),
      "mission progress should show the latest tool step"
    );
    assert(await page.locator(".thinking-card").count() === 1, "expected exactly one work trace card");
    assert(
      await page.locator(".mission-metrics-card", { hasText: "Needs attention" }).isVisible(),
      "mission health should surface the quality gate status"
    );
    assert(
      await page.locator(".mission-metric-tile", { hasText: "profile fallback" }).isVisible(),
      "mission health should show browser profile fallback count"
    );
    assert(
      await page.locator(".mission-metric-tile", { hasText: "browser buckets" }).locator("b", { hasText: "1" }).isVisible(),
      "mission health should show browser failure bucket count"
    );
    assert(
      await page.locator(".mission-metric-tile", { hasText: "requested" }).locator("b", { hasText: "3" }).isVisible(),
      "mission health should show requested tool count explicitly"
    );
    assert(
      await page.locator(".mission-metric-tile", { hasText: "executed" }).locator("b", { hasText: "2" }).isVisible(),
      "mission health should show executed tool count explicitly"
    );
    assert(
      await page.locator(".mission-metric-tile", { hasText: "cancelled" }).locator("b", { hasText: "1" }).isVisible(),
      "mission health should show cancelled tool count explicitly"
    );
    assert(
      await page.locator(".mission-quality-action-panel", { hasText: "persistent profile was locked" }).isVisible(),
      "mission health should show browser profile fallback detail"
    );
    assert(
      await page.locator(".mission-quality-action-panel", { hasText: "browser_cdp_unavailable=1" }).isVisible(),
      "mission health should show browser failure bucket detail"
    );
    assert(
      await page.locator(".mission-quality-action-panel", { hasText: "Final answer is too brief for tool-backed work." }).isVisible(),
      "mission health should show the actionable quality-gate detail"
    );
    assert(
      await page.locator(".mission-quality-action-panel", { hasText: "Final answer does not cover every visible source label" }).isVisible(),
      "mission health should show the source coverage quality detail"
    );
    assert(
      await page.locator(".mission-quality-action-panel", { hasText: "budget-limited answer" }).isVisible(),
      "mission health should suggest a concrete follow-up action"
    );
    assert(await page.locator(".context-continuity-card").count() === 1, "expected one context continuity card");
    assert(
      await page.locator(".context-continuity-card", { hasText: "Verify final answer against captured browser evidence" }).isVisible(),
      "context continuity should show active work"
    );
    assert(
      await page.locator(".context-continuity-card", { hasText: "Does the source need a screenshot artifact?" }).isVisible(),
      "context continuity should show open questions"
    );
    assert(
      await page.locator(".context-continuity-card", { hasText: "Keep browser evidence ahead of final synthesis" }).isVisible(),
      "context continuity should show carry-forward notes"
    );
    assert(await page.locator(".browser-continuity-card").count() === 1, "expected one browser continuity card");
    assert(await page.locator(".mission-recovery-card").count() === 1, "expected one recovery cases card");
    assert(
      await page.locator(".mission-recovery-card", { hasText: "Browser target detached" }).isVisible(),
      "recovery cases should show the latest recovery summary"
    );
    assert(
      await page.locator(".mission-recovery-card", { hasText: "waiting for approval" }).isVisible(),
      "recovery cases should show the operator gate"
    );
    assert(
      await page.locator(".mission-recovery-card", { hasText: "browser-ui" }).isVisible(),
      "recovery cases should show browser session continuity"
    );
    assert(postedRecoveryActions.length === 0, "read-scope smoke checks should not POST recovery actions");
    await page.getByRole("button", { name: "Approve recovery" }).click();
    await page.waitForSelector("[role='status']");
    assert(
      await page.locator("[role='status']", { hasText: "Recovery action requested: Approve recovery" }).isVisible(),
      "recovery approve action should show accepted operator feedback"
    );
    assert(
      postedRecoveryActions.includes("recovery:browser-detached:approve"),
      "recovery approve action should POST to the recovery run action route"
    );
    assert(
      await page.locator(".browser-continuity-card", { hasText: "target-reopen" }).isVisible(),
      "browser continuity should show target ids from worker results or timeline runtime"
    );
    assert(
      await page.locator(".browser-continuity-card", { hasText: "reopen" }).isVisible(),
      "browser continuity should show target resolution"
    );
    const sessionRow = page.locator(".subagent-session-row", { hasText: "Browser evidence" }).first();
    await sessionRow.locator("summary").click();
    await sessionRow.locator(".subagent-session-history-content h2", { hasText: "Captured evidence" }).waitFor();
    assert(
      await sessionRow.locator(".subagent-session-history-content h2", { hasText: "Captured evidence" }).isVisible(),
      "sub-agent session history should render markdown headings"
    );
    assert(
      await sessionRow.locator(".subagent-session-history-content li", { hasText: "Live browser snapshot" }).isVisible(),
      "sub-agent session history should render markdown list items"
    );
    assert(
      await sessionRow.locator(".subagent-session-history-content code", { hasText: "snapshot" }).isVisible(),
      "sub-agent session history should render inline code"
    );
    assert(await page.locator(".mission-evidence-card").count() === 1, "expected one mission evidence card");
    assert(
      await page.locator(".mission-evidence-card", { hasText: "Browser evidence" }).isVisible(),
      "mission evidence should show context sources used by the mission"
    );
    assert(
      await page.locator(".mission-evidence-card", { hasText: "snapshot-ui.json" }).isVisible(),
      "mission evidence should show saved artifacts"
    );
    assert(
      await page.locator(".mission-evidence-card", { hasText: "retains 7d" }).isVisible(),
      "mission evidence should show artifact retention"
    );
    assert(
      await page.locator(".mission-evidence-card", { hasText: "expired files pruned" }).isVisible(),
      "mission evidence should show artifact orphan reconciliation"
    );
    assert(
      await page.locator(".mission-evidence-card", { hasText: "browser.form.submit" }).isVisible(),
      "mission evidence should show approval actions"
    );
    assert(await page.locator("#thinking-record-timeline").count() === 0, "trace should be collapsed by default");
    assert(
      await page.locator(".thinking-card-preview", { hasText: "Final answer remains below" }).isVisible(),
      "collapsed trace preview should tell the user the final answer remains below"
    );
    await assertVerticalOrder(page, ".mission-progress-card", ".role-run-card", "mission progress should appear above runtime detail cards");
    await assertVerticalOrder(page, ".context-continuity-card", ".mission-recovery-card", "context continuity should appear before recovery cases");
    await assertVerticalOrder(page, ".mission-recovery-card", ".browser-continuity-card", "recovery cases should appear before browser continuity");
    await assertVerticalOrder(page, ".browser-continuity-card", ".worker-session-card", "browser continuity should appear before sub-agent sessions");
    await assertVerticalOrder(page, ".thinking-card", ".mission-evidence-card", "work trace must appear before mission evidence");
    await assertVerticalOrder(page, ".mission-evidence-card", ".final-answer-card", "mission evidence must appear before final answer");
    await assertVerticalOrder(page, ".thinking-card", ".final-answer-card", "work trace must appear before final answer");

    await page.getByRole("button", { name: "Show trace" }).click();
    await page.waitForSelector("#thinking-record-timeline .tool-process");
    await assertVerticalOrder(
      page,
      "#thinking-record-timeline",
      ".final-answer-card",
      "expanded trace timeline must stay before final answer"
    );
    await assertNoOverlap(page, ".thinking-card", ".final-answer-card", "trace and final answer should not overlap");
    assert(
      await page.locator(".tool-process-answer-link", { hasText: "Final answer appears below this trace." }).isVisible(),
      "tool process should point to the final answer below, not duplicate it inside the trace"
    );
    const activeProcessRow = page.locator(".tool-process", { hasText: "active tools" }).first();
    assert(
      await activeProcessRow.getByRole("button", { name: /Cancel tool calls/ }).isVisible(),
      "running tool process should expose message-level tool cancellation"
    );
    await activeProcessRow.getByRole("button", { name: /Cancel tool calls/ }).click();
    await page.waitForSelector("[role='status']");
    assert(
      await page.locator("[role='status']", { hasText: "Tool cancellation requested for 1 call" }).isVisible(),
      "tool cancellation should show accepted operator feedback"
    );
    assert(
      postedToolCancellations.some((body) => JSON.stringify(body).includes('"messageId":"msg.ui.active"')),
      "tool cancellation should POST the assistant message id"
    );
    assert(
      postedToolCancellations.some((body) => JSON.stringify(body).includes('"call-active"')),
      "tool cancellation should POST the active tool call id"
    );
    const processRow = page.locator(".tool-process").first();
    assert(
      await processRow.locator(".tool-process-session-action-row", { hasText: "Browser evidence" }).isVisible(),
      "tool process should expose the matching child session controls in context"
    );
    await processRow.getByRole("button", { name: /Continue session/ }).click();
    await page.waitForSelector("[role='status']");
    assert(
      await page.locator("[role='status']", { hasText: "Session follow-up accepted" }).isVisible(),
      "process-level session continue should submit a session follow-up"
    );

    const followUp = page.getByLabel("Follow-up message to mission team");
    await followUp.fill("Please tighten the result with the same evidence.");
    await page.getByRole("button", { name: /Send/ }).click();
    await page.waitForSelector("[role='status']");
    assert(
      await page.locator("[role='status']", { hasText: "Follow-up accepted" }).isVisible(),
      "follow-up accepted status should be visible after send"
    );
    assert(postedMessages.length === 2, "expected session continue plus one follow-up POST");
    assert(
      JSON.stringify(postedMessages[0]).includes("Continue sub-agent session wrk.browser.1"),
      "process-level Continue session should post the matched worker session key"
    );
    assert(
      JSON.stringify(postedMessages[1]).includes("Please tighten the result"),
      "follow-up POST should include textarea content"
    );
    await page.locator(".mission-quality-action-panel").getByRole("button", { name: /Reconcile/ }).click();
    await page.waitForSelector("text=Mission reconciled");
    assert(
      postedMissionReconciles.includes(missionId),
      "mission detail reconcile should call the mission-scoped reconcile route"
    );

    const screenshot = await page.screenshot({ fullPage: true });
    assert(screenshot.byteLength > 20_000, `expected non-trivial screenshot, got ${screenshot.byteLength} bytes`);
    const desktopLayoutEvidence = await collectMissionLayoutEvidence(page);

    await page.getByRole("button", { name: "Archive" }).click();
    await page.waitForFunction(() => window.location.hash === "#/missions");
    assert(
      postedMissionArchives.includes(missionId),
      "mission detail archive should call the mission-scoped archive route"
    );

    await page.goto(`http://127.0.0.1:${port}/app#/settings`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=LLM models");
    await page.waitForSelector('input[value="/tmp/turnkeyai-ui-smoke-models.json"]', {
      timeout: 30_000,
    });
    assert(
      await page.locator('input[value="OPENAI_API_KEY"]').isVisible(),
      "settings should show the live model key env"
    );
    assert(
      await page.getByText("missing key").isVisible(),
      "settings should show model readiness from /models"
    );
    assert(
      await page.locator('input[value*="chain lead_reasoning"]').isVisible(),
      "settings should show the live default model chain"
    );
    const chainList = page.locator(".settings-chain-list");
    assert(
      await chainList.locator("text=lead_reasoning").isVisible(),
      "settings should show live model chain routing"
    );
    assert(
      await chainList.locator("text=minimax-m2 -> gpt-5").isVisible(),
      "settings should show model chain primary and fallback order"
    );
    assert(
      await page.locator('input[value="/tmp/turnkeyai-ui-smoke/data"]').isVisible(),
      "settings should show live daemon paths"
    );
    assert(
      await page.locator(".card", { hasText: "Browser bridge" }).isVisible(),
      "settings should expose browser bridge setup health"
    );
    assert(
      await page.locator('input[value="local · local-automation"]').isVisible(),
      "settings should show the live browser transport"
    );
    assert(
      await page.locator('input[value="direct CDP not configured"]').isVisible(),
      "settings should show the expert lane readiness reason"
    );
    assert(
      await page.locator(".settings-health-list", { hasText: "Browser runtime" }).isVisible(),
      "settings should show browser runtime readiness from diagnostics"
    );
    assert(
      await page.locator(".settings-command-list", { hasText: "npm run cdp:smoke -- --timeout-ms 45000" }).isVisible(),
      "settings should show the browser validation command"
    );
    assert(
      await page.getByLabel("Model catalog JSON").isVisible(),
      "settings should expose the admin model catalog editor"
    );
    await page.getByLabel("Model catalog JSON").fill(JSON.stringify(modelCatalogConfigContent({ defaultModelId: "gpt-5" }), null, 2));
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForSelector("text=Catalog saved");
    assert(savedModelCatalogContents.length === 1, "settings should PUT edited model catalog content once");
    assert(
      savedModelCatalogContents[0]?.includes('"defaultModelId": "gpt-5"'),
      "settings should send the edited model catalog JSON"
    );
    await page.getByRole("button", { name: "Open command palette" }).click();
    await page.getByLabel("Search pages and missions").fill("Runtime");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.location.hash === "#/runtime");
    assert(page.url().includes("#/runtime"), "command palette should navigate to core pages");
    await page.getByRole("button", { name: "Open command palette" }).click();
    await page.getByLabel("Search pages and missions").fill("UI smoke mission");
    await page.locator(".command-palette-item", { hasText: "UI smoke mission" }).click();
    await page.waitForFunction((id) => window.location.hash === `#/mission/${id}`, missionId);
    assert(page.url().includes(`#/mission/${missionId}`), "command palette should open mission detail results");

    await page.goto(`http://127.0.0.1:${port}/app#/agent-connect`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=Agent Connect");
    assert(
      await page.locator('input[value^="http://127.0.0.1:"][value$="/bridge/command"]').count() > 0,
      "agent connect should show the local bridge command endpoint"
    );
    await page.waitForSelector("text=sessions_spawn · worker-session");
    assert(
      await page.locator("text=sessions_spawn · worker-session").isVisible(),
      "agent connect should show live native tool capabilities"
    );
    await page.waitForSelector("text=browser: browser");
    assert(
      await page.locator("text=browser: browser").isVisible(),
      "agent connect should show live transport preferences"
    );

    await page.goto(`http://127.0.0.1:${port}/app#/approvals`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=Approvals");
    assert(
      await page.getByRole("button", { name: /Policy rules/ }).isDisabled(),
      "approval policy action should be disabled until policy editing exists"
    );
    await page.getByRole("button", { name: /Decided/ }).click();
    await page.getByRole("button", { name: /View timeline/ }).click();
    await page.waitForSelector(".mission-bar");
    assert(page.url().includes(`#/mission/${missionId}`), "approval timeline action should open the mission");

    await page.goto(`http://127.0.0.1:${port}/app#/context`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=Context sources");
    assert(
      await page.getByRole("button", { name: /Policies/ }).isDisabled(),
      "context policies action should be disabled until policy editing exists"
    );
    await page.getByRole("button", { name: /Attach source/ }).click();
    await page.waitForSelector(".context-attach-card");
    await page.locator(".context-attach-card select").selectOption("folder");
    await page.locator(".context-attach-card input").nth(0).fill("UI smoke workspace");
    await page.locator(".context-attach-card input").nth(1).fill("/tmp/turnkeyai-ui-smoke");
    await page.getByRole("button", { name: /^Attach$/ }).click();
    await page.waitForSelector("text=Context source attached.");
    assert(postedContextSources.length === 1, "context attach should POST one source");
    assert(JSON.stringify(postedContextSources[0]) === JSON.stringify({
      kind: "folder",
      title: "UI smoke workspace",
      path: "/tmp/turnkeyai-ui-smoke",
    }), "context attach should POST the selected source payload");
    assert(
      await page.locator(".ctx-row", { hasText: "UI smoke workspace" }).isVisible(),
      "attached context source should appear after refetch"
    );

    await page.goto(`http://127.0.0.1:${port}/app#/runtime`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=Runtime attention");
    await page.waitForSelector("text=Mission health");
    const openReplay = page.getByRole("button", { name: /Open replay/ });
    await waitForReplayReady(page);
    assert(!(await openReplay.isDisabled()), "runtime replay action should open a mission-linked trace");
    assert(
      await page.locator("text=chain.browser.waiting").isVisible(),
      "runtime page should show live attention chains"
    );
    assert(
      await page.locator("text=wrk.browser.1").isVisible(),
      "runtime page should show live worker sessions"
    );
    assert(
      await page.locator(".card", { hasText: "Release acceptance" }).isVisible(),
      "runtime page should show release acceptance gates"
    );
    assert(
      await page.locator(".card", { hasText: "gates 4 passed · 0 failed · 1 missing" }).isVisible(),
      "release acceptance should not mark focused real LLM coverage as a full release pass"
    );
    assert(
      await page.locator(".card", { hasText: "Mission route real LLM matrix" }).isVisible(),
      "release acceptance should show the latest gate title"
    );
    assert(
      await page.locator(".card", { hasText: "Real LLM acceptance" }).isVisible(),
      "release acceptance should show the real LLM gate"
    );
    const artifactPath = page
      .locator(".card", { hasText: "Release acceptance" })
      .locator("text=validation-artifacts/real-llm-acceptance/mission-e2e-ui.json");
    await artifactPath.waitFor({ state: "visible" });
    assert(
      await artifactPath.isVisible(),
      "release acceptance should surface the latest real acceptance mission artifact path"
    );
    const tooluseArtifactPath = page
      .locator(".card", { hasText: "Release acceptance" })
      .locator("text=tool-use artifact: validation-artifacts/real-llm-acceptance/tool-use-e2e-ui.json");
    await tooluseArtifactPath.waitFor({ state: "visible" });
    assert(
      await tooluseArtifactPath.isVisible(),
      "release acceptance should surface the latest real acceptance tool-use artifact path"
    );
    const naturalArtifactPath = page
      .locator(".card", { hasText: "Release acceptance" })
      .locator("text=natural artifact: validation-artifacts/real-llm-acceptance/natural-mission-e2e-ui.json");
    await naturalArtifactPath.waitFor({ state: "visible" });
    assert(
      await naturalArtifactPath.isVisible(),
      "release acceptance should surface the latest real acceptance natural mission artifact path"
    );
    assert(
      await page.locator(".card", { hasText: "mission report: 4/4 mission scenarios" }).isVisible(),
      "release acceptance should surface real mission scenario summary"
    );
    assert(
      await page.locator(".card", { hasText: "coverage: focused gate" }).isVisible(),
      "release acceptance should distinguish focused gates from full release coverage"
    );
    assert(
      await page.locator(".card", { hasText: "natural 3/21 (missing 18)" }).isVisible(),
      "release acceptance should surface missing natural release coverage"
    );
    assert(
      await page.locator(".card", { hasText: "only focused coverage is recorded" }).isVisible(),
      "release acceptance should explain why the real LLM gate remains missing"
    );
    assert(
      await page.locator(".card", { hasText: "quality failures 0" }).isVisible(),
      "release acceptance should surface real mission quality failure count"
    );
    assert(
      await page.locator(".card", { hasText: "checks warn/fail 1/0" }).isVisible(),
      "release acceptance should surface real mission quality-check warning count"
    );
    assert(
      await page.locator(".card", { hasText: "source coverage 1/0" }).isVisible(),
      "release acceptance should surface real mission source-coverage warning count"
    );
    assert(
      await page.locator(".card", { hasText: "liveness 0/0/0" }).isVisible(),
      "release acceptance should surface real mission liveness summary"
    );
    assert(
      await page.locator(".card", { hasText: "natural report: 3/3 natural scenarios" }).isVisible(),
      "release acceptance should surface natural mission scenario summary"
    );
    assert(
      await page.locator(".card", { hasText: "source terms 8/9" }).isVisible(),
      "release acceptance should surface natural source term coverage"
    );
    assert(
      await page.locator(".card", { hasText: "evidence patterns 7/8" }).isVisible(),
      "release acceptance should surface natural evidence pattern coverage"
    );
    assert(
      await page.locator(".card", { hasText: "natural proof · natural-browser-dashboard-task" }).isVisible(),
      "release acceptance should surface per-scenario natural dashboard proof"
    );
    assert(
      await page.locator(".card", { hasText: "browser yes · sessions 1/0" }).isVisible(),
      "release acceptance should surface browser session proof signals"
    );
    assert(
      await page.locator(".card", { hasText: "natural proof · natural-long-delegation" }).isVisible(),
      "release acceptance should surface per-scenario delegation proof"
    );
    assert(
      await page.locator(".card", { hasText: "unsupported 0" }).isVisible(),
      "release acceptance should surface unsupported natural claim count"
    );
    assert(
      await page.locator(".card", { hasText: "validation-ops" }).isVisible(),
      "release acceptance should show the next validation command"
    );
    await openReplay.click();
    await page.waitForFunction((id) => window.location.hash === `#/mission/${id}`, missionId);
    assert(page.url().includes(`#/mission/${missionId}`), "runtime replay action should open the mission trace");

    await page.goto(`http://127.0.0.1:${port}/app#/onboarding`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=First run");
    await page.waitForSelector("text=Production readiness");
    assert(
      await page.locator(".onboarding-readiness-card", { hasText: "Daemon reachable" }).isVisible(),
      "onboarding should show daemon readiness"
    );
    assert(
      await page.locator(".onboarding-readiness-card", { hasText: "Default model route" }).isVisible(),
      "onboarding should show default model readiness"
    );
    assert(
      await page.locator(".onboarding-readiness-card", { hasText: "Browser bridge route" }).isVisible(),
      "onboarding should show browser bridge readiness"
    );
    assert(
      await page.locator(".onboarding-readiness-card", { hasText: "local-automation · healthy" }).isVisible(),
      "onboarding should show browser bridge transport health"
    );
    assert(
      await page.locator(".onboarding-readiness-card", { hasText: "Real acceptance gate" }).isVisible(),
      "onboarding should show real acceptance readiness"
    );
    assert(
      await page.locator(".onboarding-readiness-card", { hasText: "npm run acceptance:real -- --model-catalog models.local.json" }).isVisible(),
      "onboarding should show the real acceptance command"
    );
    assert(
      await page.locator(".onboarding-step", { hasText: "Daemon and token" }).isVisible(),
      "onboarding should show daemon/token setup"
    );
    assert(
      await page.locator(".onboarding-step", { hasText: "Browser bridge" }).isVisible(),
      "onboarding should show browser bridge setup"
    );
    await page.getByRole("button", { name: "Mark runtime reviewed" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("reviewed-runtime"));
    assert(onboardingState.step === "reviewed-runtime", "onboarding PUT should persist the reviewed-runtime step");
    await page.close();

    const mobilePage = await newSmokePage(browser, { viewport: { width: 390, height: 844 } });
    mobilePage.on("console", (message) => {
      if (message.type() === "error") {
        if (isIgnorableConsoleError(message.text())) return;
        const location = message.location();
        const source = location.url ? ` ${location.url}:${location.lineNumber}` : "";
        browserConsoleErrors.push(`mobile-browser-console-error:${source} ${message.text()}`);
      }
    });
    mobilePage.on("pageerror", (error) => {
      browserPageErrors.push(`mobile-browser-page-error: ${error.message}`);
    });
    await mobilePage.addInitScript(() => {
      sessionStorage.setItem("turnkeyai.controlCenter.token", "ui-smoke-token");
      sessionStorage.setItem("turnkeyai.controlCenter.scope", "operator");
    });
    await mobilePage.goto(`http://127.0.0.1:${port}/app#/mission/${encodeURIComponent(missionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await mobilePage.waitForSelector(".thinking-card");
    await mobilePage.waitForSelector(".final-answer-card .markdown-body h2");
    await mobilePage.waitForSelector(".final-answer-card .markdown-table-wrap");
    await assertNoPageHorizontalOverflow(mobilePage, "mobile mission detail should not create page-level horizontal scroll");
    await assertWithinViewport(mobilePage, ".mission-bar", "mobile mission bar should fit the viewport");
    await assertWithinViewport(mobilePage, ".mission-detail-pane", "mobile mission detail pane should fit the viewport");
    await assertWithinViewport(mobilePage, ".thinking-card", "mobile work trace card should fit the viewport");
    await assertWithinViewport(mobilePage, ".final-answer-card", "mobile final answer card should fit the viewport");
    await assertWithinViewport(
      mobilePage,
      ".final-answer-card .markdown-table-wrap",
      "mobile markdown table wrapper should fit the viewport"
    );
    await assertTableScrollsInsideWrapper(
      mobilePage,
      ".final-answer-card .markdown-table-wrap",
      "wide markdown tables should scroll inside the answer card instead of overflowing the page"
    );
    assert(await mobilePage.locator("#thinking-record-timeline").count() === 0, "mobile trace should be collapsed by default");
    await assertVerticalOrder(
      mobilePage,
      ".thinking-card",
      ".final-answer-card",
      "mobile work trace must appear before final answer"
    );
    await mobilePage.getByRole("button", { name: "Show trace" }).click();
    await mobilePage.waitForSelector("#thinking-record-timeline .tool-process");
    await assertVerticalOrder(
      mobilePage,
      "#thinking-record-timeline",
      ".final-answer-card",
      "mobile expanded trace timeline must stay before final answer"
    );
    await assertNoOverlap(
      mobilePage,
      ".thinking-card",
      ".final-answer-card",
      "mobile trace and final answer should not overlap"
    );
    await assertNoPageHorizontalOverflow(
      mobilePage,
      "expanded mobile mission trace should not create page-level horizontal scroll"
    );
    const mobileFollowUp = mobilePage.getByLabel("Follow-up message to mission team");
    await mobileFollowUp.fill("Mobile follow-up remains usable.");
    assert(
      await mobilePage.getByRole("button", { name: /Send/ }).isEnabled(),
      "mobile follow-up send button should be enabled after text input"
    );
    const mobileScreenshot = await mobilePage.screenshot({ fullPage: true });
    assert(
      mobileScreenshot.byteLength > 15_000,
      `expected non-trivial mobile screenshot, got ${mobileScreenshot.byteLength} bytes`
    );
    const mobileLayoutEvidence = await collectMissionLayoutEvidence(mobilePage);
    await mobilePage.close();
    assert(
      requestedPaths.some((value) => value.startsWith(`/missions/${missionId}/timeline`)),
      "mission timeline endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith(`/missions/${missionId}/artifacts`)),
      "mission artifacts endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/mission-context-sources")),
      "mission context sources endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith(`/recovery-runs?threadId=${encodeURIComponent(threadId)}`)),
      "mission recovery runs endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith(`/context/session-memory?threadId=${encodeURIComponent(threadId)}`)),
      "mission session memory endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/approvals")),
      "approvals endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/diagnostics")),
      "settings diagnostics endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/diagnostics/logs")),
      "runtime diagnostics logs endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/models")),
      "settings models endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/bridge/status")),
      "agent connect bridge status endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/capabilities")),
      "agent connect capabilities endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/runtime-summary")),
      "runtime summary endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/runtime-worker-sessions")),
      "runtime worker sessions endpoint was not requested"
    );
    assert(
      requestedPaths.some((value) => value.startsWith("/validation-ops")),
      "validation ops endpoint was not requested"
    );
    assert(
      browserConsoleErrors.length === 0,
      `browser console errors should stay clean:\n${browserConsoleErrors.join("\n")}`
    );
    assert(
      browserPageErrors.length === 0,
      `browser page errors should stay clean:\n${browserPageErrors.join("\n")}`
    );
    if (smokeArtifactDir) {
      const artifact = await writeSmokeArtifacts({
        artifactDir: smokeArtifactDir,
        desktopScreenshot: screenshot,
        mobileScreenshot,
        desktopLayoutEvidence,
        mobileLayoutEvidence,
      });
      console.log(`control-center-ui-smoke: artifact-summary ${artifact.summaryPath}`);
      console.log(`control-center-ui-smoke: desktop-screenshot ${artifact.desktopScreenshotPath}`);
      console.log(`control-center-ui-smoke: mobile-screenshot ${artifact.mobileScreenshotPath}`);
    }
    console.log("control-center-ui-smoke: passed");
    console.log(`control-center-ui-smoke: screenshot-bytes ${screenshot.byteLength}`);
    console.log(`control-center-ui-smoke: mobile-screenshot-bytes ${mobileScreenshot.byteLength}`);
    }
  }
} finally {
  if (browser) {
    await browser.close();
  }
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function runHumanProductSmoke(browserPath: string): Promise<void> {
  let humanBrowser: Browser | undefined;
  try {
    humanBrowser = await chromium.launch({
      executablePath: browserPath,
      headless: !headful,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const noTokenPage = await newSmokePage(humanBrowser, { viewport: { width: 1100, height: 760 } });
    await noTokenPage.goto(`http://127.0.0.1:${port}/app#/missions`, {
      waitUntil: "domcontentloaded",
    });
    await noTokenPage.waitForSelector(".launch-command-list");
    assert(await noTokenPage.locator("text=Auth token required").isVisible(), "no-token page should explain token recovery");
    assert(
      await noTokenPage.locator("text=launchers/TurnkeyAI Mission Control.command").isVisible(),
      "no-token page should show the bundled launcher"
    );
    assert(
      await noTokenPage.locator("text=npx @turnkeyai/cli app").isVisible(),
      "no-token page should show the no-install launcher"
    );
    await noTokenPage.close();

    const page = await newSmokePage(humanBrowser, { viewport: { width: 1440, height: 980 } });
    page.on("console", (message) => {
      if (message.type() === "error") {
        if (isIgnorableConsoleError(message.text())) return;
        const location = message.location();
        const source = location.url ? ` ${location.url}:${location.lineNumber}` : "";
        browserConsoleErrors.push(`browser-console-error:${source} ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      browserPageErrors.push(`browser-page-error: ${error.message}`);
    });
    await page.addInitScript(() => {
      sessionStorage.setItem("turnkeyai.controlCenter.token", "ui-smoke-admin-token");
      sessionStorage.setItem("turnkeyai.controlCenter.scope", "admin");
    });

    await page.goto(`http://127.0.0.1:${port}/app#/agent-connect`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".start-brief");
    assert(
      await page.locator(".chat-message", { hasText: "Tell me what you want done" }).isVisible(),
      "chat should be the product entry"
    );
    assert(await page.locator(".start-brief").isVisible(), "chat should expose the main composer");
    assert(await page.locator(".chat-team-panel", { hasText: "Auto" }).isVisible(), "chat should default to Auto team");
    assert(await page.locator(".work-now-panel", { hasText: "UI smoke mission" }).isVisible(), "chat should show current work");
    assert(
      (await page.locator("text=Context sources").count()) === 0,
      "chat entry should not expose internal context-source terminology"
    );
    assert((await page.locator("text=Runtime attention").count()) === 0, "chat entry should not expose runtime internals");
    await page.locator(".start-brief").fill("Open dynamic pages, collect browser evidence, and compare the result.");
    await page.getByRole("button", { name: /^Send$/ }).click();
    await page.waitForSelector(".mission-bar");
    assert(postedMissions.length === 1, "chat send should create one work item");
    assert(
      JSON.stringify(postedMissions[0]).includes("Open dynamic pages"),
      "chat send should post the user's plain-language request"
    );

    await page.goto(`http://127.0.0.1:${port}/app#/agents`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=Team");
    assert(await page.locator(".team-choice-card", { hasText: "Auto" }).isVisible(), "team page should offer Auto");
    assert(
      await page.locator(".team-choice-card", { hasText: "Use websites" }).isVisible(),
      "team page should explain browser-backed work in user language"
    );
    assert(
      await page.locator(".team-choice-card", { hasText: "Review carefully" }).isVisible(),
      "team page should offer review mode in user language"
    );
    assert((await page.locator("text=sessions_spawn").count()) === 0, "team page should not expose tool schema names");

    await page.goto(`http://127.0.0.1:${port}/app#/mission/${encodeURIComponent(missionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".work-status-overview");
    await page.waitForSelector(".mission-progress-card");
    await page.waitForSelector(".work-answer-card .markdown-body h2");
    assert(await page.locator(".work-status-overview").count() === 1, "work detail should show one current-state panel");
    assert(await page.locator(".mission-progress-card").count() === 1, "work detail should show one chronological progress panel");
    assert(await page.locator(".work-answer-card").count() === 1, "work detail should show one answer panel");
    assert(
      await page.locator(".work-needs-you-card", { hasText: "Browser target detached" }).isVisible(),
      "work detail should surface human decisions near the top"
    );
    const rawToolCallText = page.locator("text=Tool Call").first();
    assert(
      (await rawToolCallText.count()) === 0 || !(await rawToolCallText.isVisible()),
      "work detail should not lead with raw tool-call terminology"
    );
    await assertVerticalOrder(
      page,
      ".work-status-overview",
      ".mission-progress-card",
      "current state should appear before chronological progress"
    );
    await assertVerticalOrder(
      page,
      ".mission-progress-card",
      ".work-answer-card",
      "chronological progress should appear before the answer"
    );
    await page.locator(".work-detail-section", { hasText: "Activity details" }).locator("summary").click();
    await page.getByRole("button", { name: "Show activity" }).click();
    await page.waitForSelector("#thinking-record-timeline .tool-process");
    await assertNoOverlap(page, ".thinking-card", ".work-answer-card", "activity and answer should not overlap");
    const followUp = page.getByLabel("Follow-up message to mission team");
    await followUp.fill("Please tighten the result with the same evidence.");
    await page.getByRole("button", { name: /Send/ }).click();
    await page.waitForSelector("[role='status']");
    assert(
      await page.locator("[role='status']", { hasText: "Message sent" }).isVisible(),
      "work detail should accept follow-up messages"
    );
    assert(
      postedMessages.some((body) => JSON.stringify(body).includes("Please tighten the result")),
      "follow-up should POST the user's message"
    );
    const screenshot = await page.screenshot({ fullPage: true });
    assert(screenshot.byteLength > 20_000, `expected non-trivial desktop screenshot, got ${screenshot.byteLength} bytes`);
    const desktopLayoutEvidence = await collectMissionLayoutEvidence(page);

    await page.goto(`http://127.0.0.1:${port}/app#/settings`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=Settings");
    assert(await page.locator(".settings-overview-card", { hasText: "Model" }).isVisible(), "settings should lead with Model");
    assert(await page.locator(".settings-overview-card", { hasText: "Team" }).isVisible(), "settings should expose Team");
    assert(await page.locator(".settings-overview-card", { hasText: "Browser" }).isVisible(), "settings should expose Browser");
    assert(await page.locator(".settings-overview-card", { hasText: "Other apps" }).isVisible(), "settings should expose Other apps");
    assert((await page.locator("text=LLM models").count()) === 0, "settings should avoid LLM jargon in the default view");
    await page.locator(".settings-advanced").evaluate((node) => {
      if (node instanceof HTMLDetailsElement) node.open = true;
    });
    await page.getByLabel("Model catalog JSON").fill(JSON.stringify(modelCatalogConfigContent({ defaultModelId: "gpt-5" }), null, 2));
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.waitForSelector("text=Catalog saved");
    assert(savedModelCatalogContents.length === 1, "settings should save edited model catalog content once");

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await page.getByLabel("Search").fill("Team");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.location.hash === "#/agents");
    assert(page.url().includes("#/agents"), "command palette should navigate to Team");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await page.getByLabel("Search").fill("UI smoke mission");
    await page.locator(".command-palette-item", { hasText: "UI smoke mission" }).click();
    await page.waitForFunction((id) => window.location.hash === `#/mission/${id}`, missionId);
    assert(page.url().includes(`#/mission/${missionId}`), "command palette should open work details");

    for (const oldRoute of ["#/missions", "#/approvals", "#/context", "#/runtime", "#/onboarding"]) {
      await page.goto(`http://127.0.0.1:${port}/app${oldRoute}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector(".start-brief");
      assert((await page.locator("text=Runtime attention").count()) === 0, `${oldRoute} should not show old runtime IA`);
      assert((await page.locator("text=Context sources").count()) === 0, `${oldRoute} should not show old context IA`);
      assert((await page.locator("text=Approvals").count()) === 0, `${oldRoute} should not show old approvals IA`);
    }
    await page.close();

    const mobilePage = await newSmokePage(humanBrowser, { viewport: { width: 390, height: 844 } });
    mobilePage.on("console", (message) => {
      if (message.type() === "error") {
        if (isIgnorableConsoleError(message.text())) return;
        const location = message.location();
        const source = location.url ? ` ${location.url}:${location.lineNumber}` : "";
        browserConsoleErrors.push(`mobile-browser-console-error:${source} ${message.text()}`);
      }
    });
    mobilePage.on("pageerror", (error) => {
      browserPageErrors.push(`mobile-browser-page-error: ${error.message}`);
    });
    await mobilePage.addInitScript(() => {
      sessionStorage.setItem("turnkeyai.controlCenter.token", "ui-smoke-token");
      sessionStorage.setItem("turnkeyai.controlCenter.scope", "operator");
    });
    await mobilePage.goto(`http://127.0.0.1:${port}/app#/mission/${encodeURIComponent(missionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await mobilePage.waitForSelector(".work-status-overview");
    await mobilePage.waitForSelector(".work-answer-card .markdown-body h2");
    await assertNoPageHorizontalOverflow(mobilePage, "mobile work detail should not create page-level horizontal scroll");
    await assertWithinViewport(mobilePage, ".mission-bar", "mobile mission bar should fit the viewport");
    await assertWithinViewport(mobilePage, ".mission-detail-pane", "mobile work detail pane should fit the viewport");
    await assertWithinViewport(mobilePage, ".thinking-card", "mobile activity card should fit the viewport");
    await assertWithinViewport(mobilePage, ".work-answer-card", "mobile answer card should fit the viewport");
    await assertVerticalOrder(
      mobilePage,
      ".mission-progress-card",
      ".work-answer-card",
      "mobile progress should appear before answer"
    );
    const mobileScreenshot = await mobilePage.screenshot({ fullPage: true });
    assert(
      mobileScreenshot.byteLength > 15_000,
      `expected non-trivial mobile screenshot, got ${mobileScreenshot.byteLength} bytes`
    );
    const mobileLayoutEvidence = await collectMissionLayoutEvidence(mobilePage);
    await mobilePage.close();

    assert(requestedPaths.some((value) => value.startsWith("/missions")), "missions endpoint was not requested");
    assert(
      requestedPaths.some((value) => value.startsWith(`/missions/${missionId}/timeline`)),
      "mission timeline endpoint was not requested"
    );
    assert(requestedPaths.some((value) => value.startsWith("/mission-agents")), "team endpoint was not requested");
    assert(requestedPaths.some((value) => value.startsWith("/models")), "models endpoint was not requested");
    assert(requestedPaths.some((value) => value.startsWith("/diagnostics")), "diagnostics endpoint was not requested");
    assert(
      browserConsoleErrors.length === 0,
      `browser console errors should stay clean:\n${browserConsoleErrors.join("\n")}`
    );
    assert(
      browserPageErrors.length === 0,
      `browser page errors should stay clean:\n${browserPageErrors.join("\n")}`
    );
    if (smokeArtifactDir) {
      const artifact = await writeSmokeArtifacts({
        artifactDir: smokeArtifactDir,
        desktopScreenshot: screenshot,
        mobileScreenshot,
        desktopLayoutEvidence,
        mobileLayoutEvidence,
      });
      console.log(`control-center-ui-smoke: artifact-summary ${artifact.summaryPath}`);
      console.log(`control-center-ui-smoke: desktop-screenshot ${artifact.desktopScreenshotPath}`);
      console.log(`control-center-ui-smoke: mobile-screenshot ${artifact.mobileScreenshotPath}`);
    }
    console.log("control-center-ui-smoke: passed");
    console.log(`control-center-ui-smoke: screenshot-bytes ${screenshot.byteLength}`);
    console.log(`control-center-ui-smoke: mobile-screenshot-bytes ${mobileScreenshot.byteLength}`);
  } finally {
    if (humanBrowser) {
      await humanBrowser.close();
    }
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  requestedPaths.push(url.pathname + url.search);

  if (url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/" || url.pathname === "/index.html") {
    await serveStatic(req, res, indexHtmlPath);
    return;
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname.startsWith("/app/assets/")) {
    await serveStatic(req, res, path.join(distDir, url.pathname.slice("/app/".length)));
    return;
  }

  if (method === "GET" && url.pathname === "/missions") {
    json(res, [missionFixture(), archivedMissionFixture()]);
    return;
  }
  if (method === "GET" && url.pathname === "/onboarding/state") {
    json(res, onboardingState);
    return;
  }
  if (method === "PUT" && url.pathname === "/onboarding/state") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    onboardingState = {
      ...onboardingState,
      ...body,
      updatedAt: 1_779_984_006_000,
    };
    json(res, onboardingState);
    return;
  }
  if (method === "POST" && url.pathname === "/missions") {
    postedMissions.push(await readJsonBody(req));
    json(res, missionFixture());
    return;
  }
  if (method === "POST" && url.pathname === "/missions/reconcile") {
    if (!hasOperatorAccess(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "operator" }));
      return;
    }
    postedMissionReconciles.push("all");
    json(res, {
      ok: true,
      scope: "all",
      missions: [{ missionId, appended: 2 }],
      appended: 2,
    });
    return;
  }
  if (method === "GET" && url.pathname === `/missions/${missionId}`) {
    json(res, missionFixture());
    return;
  }
  if (method === "POST" && url.pathname === `/missions/${missionId}/reconcile`) {
    if (!hasOperatorAccess(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "operator" }));
      return;
    }
    postedMissionReconciles.push(missionId);
    json(res, {
      ok: true,
      scope: "mission",
      missionId,
      appended: 1,
    });
    return;
  }
  if (method === "POST" && url.pathname === `/missions/${missionId}/archive`) {
    if (!hasOperatorAccess(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "operator" }));
      return;
    }
    postedMissionArchives.push(missionId);
    json(res, {
      ...missionFixture(),
      status: "archived",
    });
    return;
  }
  if (method === "GET" && url.pathname === `/missions/${missionId}/timeline`) {
    json(res, timelineFixture());
    return;
  }
  if (method === "GET" && url.pathname === `/missions/${missionId}/metrics`) {
    json(res, metricsFixture());
    return;
  }
  if (method === "GET" && url.pathname === `/missions/${missionId}/artifacts`) {
    json(res, artifactsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/runtime-worker-sessions") {
    json(res, workerSessionsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/runtime-summary") {
    json(res, runtimeSummaryFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/validation-ops") {
    if (req.headers.authorization !== "Bearer ui-smoke-admin-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "admin" }));
      return;
    }
    json(res, validationOpsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/recovery-runs") {
    json(res, recoveryRunsFixture());
    return;
  }
  const recoveryRunAction = url.pathname.match(/^\/recovery-runs\/([^/]+)\/(approve|reject|retry|fallback|resume)$/);
  if (method === "POST" && recoveryRunAction) {
    postedRecoveryActions.push(`${decodeURIComponent(recoveryRunAction[1]!)}:${recoveryRunAction[2]!}`);
    json(res, { accepted: true, action: recoveryRunAction[2], recoveryRunId: decodeURIComponent(recoveryRunAction[1]!) });
    return;
  }
  if (method === "GET" && url.pathname === "/context/session-memory") {
    json(res, sessionMemoryFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/runs") {
    json(res, roleRunsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/approvals") {
    json(res, approvalsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/bridge/status") {
    json(res, bridgeStatusFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/diagnostics") {
    json(res, diagnosticsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/diagnostics/logs") {
    json(res, diagnosticsLogsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/models") {
    json(res, modelsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/daemon/config/model-catalog") {
    if (req.headers.authorization !== "Bearer ui-smoke-admin-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "admin" }));
      return;
    }
    json(res, modelCatalogConfigFixture());
    return;
  }
  if (method === "PUT" && url.pathname === "/daemon/config/model-catalog") {
    if (req.headers.authorization !== "Bearer ui-smoke-admin-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "admin" }));
      return;
    }
    const body = await readJsonBody(req) as { content?: unknown };
    if (typeof body.content === "string") {
      savedModelCatalogContents.push(body.content);
    }
    json(res, {
      ...modelCatalogConfigFixture(typeof body.content === "string" ? body.content : undefined),
      saved: true,
      restartRequired: false,
    });
    return;
  }
  if (method === "GET" && url.pathname === "/capabilities") {
    json(res, capabilitiesFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/mission-agents") {
    json(res, agentsFixture());
    return;
  }
  if (method === "GET" && url.pathname === "/mission-context-sources") {
    json(res, contextSourcesFixture());
    return;
  }
  if (method === "POST" && url.pathname === "/mission-context-sources") {
    if (!hasOperatorAccess(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", requiredAccess: "operator" }));
      return;
    }
    const body = await readJsonBody(req);
    postedContextSources.push(body);
    const index = postedContextSources.length;
    const kind = contextSourceKindFromBody(body);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: contextSourceId(kind, index),
      kind,
      title: String((body as { title?: unknown }).title ?? ""),
      url: String((body as { path?: unknown; url?: unknown }).path ?? (body as { url?: unknown }).url ?? ""),
      state: "attached",
      lastUse: "",
      lastUseAtMs: 1_779_984_004_300 + index - 1,
    }));
    return;
  }
  if (method === "POST" && url.pathname === `/missions/${missionId}/messages`) {
    postedMessages.push(await readJsonBody(req));
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: true }));
    return;
  }
  if (method === "POST" && url.pathname === "/message/cancel-tools") {
    const body = await readJsonBody(req);
    postedToolCancellations.push(body);
    json(res, {
      cancelled: true,
      messageId: String((body as { messageId?: unknown }).messageId ?? ""),
      threadId: String((body as { threadId?: unknown }).threadId ?? threadId),
      toolCallIds: Array.isArray((body as { toolCallIds?: unknown }).toolCallIds)
        ? (body as { toolCallIds: unknown[] }).toolCallIds
        : ["call-active"],
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `not found: ${method} ${url.pathname}` }));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  const normalized = path.resolve(filePath);
  if (!normalized.startsWith(distDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const body = await readFile(normalized);
  res.writeHead(200, { "content-type": contentTypeFor(normalized) });
  res.end(body);
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function hasOperatorAccess(req: IncomingMessage): boolean {
  return req.headers.authorization === "Bearer ui-smoke-admin-token" || req.headers.authorization === "Bearer ui-smoke-operator-token";
}

function missionFixture() {
  return {
    id: missionId,
    shortId: "UI-1",
    title: "UI smoke mission",
    desc: "Verifies Mission Detail ordering and rendering.",
    status: "done",
    mode: "research",
    modeLabel: "Research",
    owner: "operator",
    ownerLabel: "Operator",
    createdAt: "2026-05-29 12:00",
    createdAtMs: 1_779_984_000_000,
    agents: ["role-lead"],
    progress: 100,
    pendingApprovals: 0,
    blockers: 0,
    contextSummary: ["browser evidence", "tool result"],
    threadId,
  };
}

function archivedMissionFixture() {
  return {
    ...missionFixture(),
    id: "msn.ui-smoke.archived",
    shortId: "UI-X",
    title: "Archived UI smoke mission",
    status: "archived",
    progress: 100,
    pendingApprovals: 0,
    blockers: 0,
    threadId: "thread-ui-smoke-archived",
  };
}

function onboardingStateFixture() {
  return {
    completedAt: 1_779_984_000_000,
    transportChosen: "local",
    transportVerifiedAt: 1_779_984_000_000,
    step: "ready",
    updatedAt: 1_779_984_000_000,
  };
}

function timelineFixture() {
  const finalAnswer = [
    "# Result",
    "",
    "The mission completed with **browser evidence** and a durable tool result.",
    "",
    "- Evidence item: captured page title",
    "- Follow-up state: accepted by the daemon",
    "",
    "| Check | Value |",
    "| --- | --- |",
    "| order | trace before final answer |",
    "| markdown | rendered |",
    "",
    "`tool_result` is rendered as inline code. See [example](https://example.com).",
  ].join("\n");
  return [
    event("ev.user", "plan", 1_000, "user", "Compare two browser-backed sources."),
    event(
      "ev.browser.context",
      "browser",
      1_700,
      "role-browser",
      "Browser evidence captured.",
      {
        route: "worker-session",
        browserSessionId: "browser-ui",
        browserTargetId: "target-reopen",
        resumeMode: "cold",
        targetResolution: "reopen",
        transport: "direct-cdp",
      },
      "ctx.browser.session.browser-ui"
    ),
    tool("ev.tool.call", 2_000, "call", "sessions_spawn", "call-browser", "Spawn browser worker."),
    tool("ev.tool.progress", 2_700, "progress", "sessions_spawn", "call-browser", "Browser worker opened context."),
    tool("ev.tool.result", 4_300, "result", "sessions_spawn", "call-browser", "Returned 3 evidence bullets."),
    event("ev.final", "thought", 5_200, "role-lead", finalAnswer, { route: "lead-role" }),
    tool(
      "ev.tool.active-call",
      6_000,
      "call",
      "sessions_send",
      "call-active",
      "Continue browser worker with updated instructions.",
      { messageId: "msg.ui.active", round: "1" }
    ),
  ];
}

function metricsFixture() {
  return {
    missionId,
    status: "done",
    generatedAtMs: 1_779_984_005_000,
    wallClockMs: 5_200,
    timelineEventCount: 6,
    tool: {
      requested: 3,
      results: 1,
      executed: 2,
      skipped: 0,
      failed: 0,
      cancelled: 1,
      timeouts: 0,
    },
    sessions: {
      spawned: 1,
      continued: 0,
    },
    browser: {
      profileFallbacks: 1,
      latestProfileFallback: {
        sessionId: "browser-session-profile-fallback-ui",
        fallbackDir: ".daemon-data/browser/_runtime-fallback/browser-session-profile-fallback-ui/123",
      },
      failureBuckets: [
        { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 1_779_984_004_200 },
      ],
    },
    approvals: {
      requested: 1,
      applied: 1,
      decided: 1,
    },
    recovery: {
      events: 0,
    },
    liveness: {
      active: 0,
      waiting: 0,
      stale: 0,
      lastProgressAtMs: 1_779_984_005_000,
      staleSubjects: [],
    },
    qualityGate: {
      status: "needs_attention",
      finalAnswerEventId: "ev.final",
      evidenceEvents: 2,
      checks: [
        { name: "final_answer", status: "pass", detail: "Final answer event exists." },
        { name: "evidence", status: "pass", detail: "Evidence event exists." },
        {
          name: "source_coverage",
          status: "warn",
          detail: "Final answer does not cover every visible source label: Browser evidence.",
        },
        { name: "residual_risk", status: "pass", detail: "Final answer names residual risk." },
        { name: "answer_substance", status: "warn", detail: "Final answer is too brief for tool-backed work." },
        {
          name: "tool_fallback_answer",
          status: "warn",
          detail: "Final answer says a required tool or search path was unavailable and falls back to model knowledge.",
        },
        {
          name: "tool_loop_closeout",
          status: "warn",
          detail: "Final answer was forced after the tool-round limit. 2 completed rounds; 2 executed tool calls; 1 pending tool call.",
        },
        {
          name: "browser_profile_fallback",
          status: "warn",
          detail:
            "Browser used an isolated runtime profile 1 time because the persistent profile was locked. Latest session browser-session-profile-fallback-ui.",
        },
        {
          name: "browser_failure_bucket",
          status: "warn",
          detail:
            "Browser failure bucket(s): browser_cdp_unavailable=1. Use the trace and recovery events to decide whether to retry, reattach, or continue with bounded evidence.",
        },
      ],
    },
  };
}

function diagnosticsFixture() {
  return {
    daemon: {
      version: "0.1.1",
      port,
      startedAt: "2026-05-29T04:00:00.000Z",
      uptimeMs: 12_000,
      authMode: "token",
    },
    paths: {
      runtimeRoot: "/tmp/turnkeyai-ui-smoke",
      dataDir: "/tmp/turnkeyai-ui-smoke/data",
      configFile: "/tmp/turnkeyai-ui-smoke/config.json",
      logFile: "/tmp/turnkeyai-ui-smoke/logs/daemon.log",
      modelCatalogPath: "/tmp/turnkeyai-ui-smoke-models.json",
      logFileBytes: 120,
      logFileModifiedAt: "2026-05-29T04:00:10.000Z",
    },
    transport: {
      mode: "local",
      label: "local-automation",
      health: {
        transportMode: "local",
        transportLabel: "local-automation",
        healthy: true,
        connected: true,
        checkedAt: 1_700_000_000_100,
      },
    },
    counters: {
      sessionCount: 1,
      relayPeerCount: 0,
      relayTargetCount: 0,
    },
    missionHealth: {
      total: 3,
      inspected: 3,
      byStatus: {
        draft: 0,
        planning: 0,
        working: 1,
        needs_approval: 1,
        blocked: 0,
        done: 1,
        archived: 0,
      },
      active: 2,
      terminal: 1,
      needsApproval: 1,
      withBlockers: 0,
      snapshotErrorCount: 0,
      duration: {
        longestActiveMs: 125_000,
        longestActiveMissionId: missionId,
        longestActiveMissionTitle: "Dashboard comparison mission",
        oldestActiveCreatedAtMs: Date.now() - 125_000,
      },
      latestMission: {
        id: missionId,
        title: "Dashboard comparison mission",
        status: "working",
        createdAtMs: Date.now(),
      },
      qualityGate: {
        running: 1,
        passed: 1,
        needsAttention: 0,
        blocked: 0,
      },
      tool: {
        requested: 4,
        executed: 3,
        failed: 0,
        cancelled: 0,
        timeouts: 0,
      },
      sessions: {
        spawned: 2,
        continued: 1,
      },
      browser: {
        profileFallbacks: 1,
        failureBuckets: [
          { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: Date.now() - 30_000 },
        ],
      },
      liveness: {
        active: 1,
        waiting: 1,
        stale: 0,
      },
      recoveryEvents: 0,
      attentionMissions: [
        {
          id: missionId,
          title: "Dashboard comparison mission",
          status: "needs_approval",
          qualityGateStatus: "running",
          pendingApprovals: 1,
          blockers: 0,
          toolFailures: 0,
          toolTimeouts: 0,
          browserProfileFallbacks: 1,
          browserFailureBuckets: [
            { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: Date.now() - 30_000 },
          ],
          recoveryEvents: 0,
          staleRuntimeSubjects: 0,
          wallClockMs: 125_000,
          lastProgressAtMs: Date.now() - 20_000,
        },
      ],
    },
    node: {
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    readiness: {
      status: "warn",
      checks: [
        {
          id: "model_catalog",
          label: "Model catalog",
          status: "warn",
          detail: "One configured model is missing its API key.",
        },
        {
          id: "browser_transport",
          label: "Browser transport",
          status: "ok",
          detail: "local-automation is active.",
        },
        {
          id: "browser_runtime",
          label: "Browser runtime",
          status: "warn",
          detail: "Recent browser tasks used isolated runtime profiles 1 time; latest session browser-session-ui.",
          action: "A persistent browser profile was locked. Close the conflicting browser profile or revoke/retry the session.",
        },
      ],
    },
  };
}

function diagnosticsLogsFixture() {
  return {
    logFile: "/tmp/turnkeyai-ui-smoke/logs/daemon.log",
    limit: 50,
    lineCount: 2,
    lines: [
      "2026-05-29T04:00:01.000Z daemon started",
      "2026-05-29T04:00:08.000Z mission replay indexed",
    ],
    truncatedFromHead: false,
    redacted: true,
  };
}

function bridgeStatusFixture() {
  return {
    ok: true,
    port,
    version: "0.1.1",
    dataDir: "/tmp/turnkeyai-ui-smoke/data",
    logsPath: "/tmp/turnkeyai-ui-smoke/logs/daemon.log",
    configFile: "/tmp/turnkeyai-ui-smoke/config.json",
    transport: {
      mode: "local",
      label: "local-automation",
      health: {
        transportMode: "local",
        transportLabel: "local-automation",
        healthy: true,
        connected: true,
        checkedAt: 1_700_000_000_100,
      },
    },
    relay: {
      configured: false,
      peerCount: 0,
      targetCount: 0,
      lastHeartbeatAgeMs: null,
      actionRequestQueueDepth: 0,
    },
    directCdp: {
      configured: false,
      endpoint: null,
    },
    expertLane: {
      available: false,
      reason: "direct CDP not configured",
    },
    sessions: {
      count: 1,
    },
  };
}

function capabilitiesFixture() {
  return {
    availableWorkers: ["browser", "explore"],
    toolCapabilities: [
      { name: "sessions_spawn", executorKind: "worker-session", promptGroup: "sessions" },
      { name: "sessions_send", executorKind: "worker-session", promptGroup: "sessions" },
      { name: "permission_query", executorKind: "permission", promptGroup: "permissions" },
    ],
    connectorStates: [
      { provider: "browser", available: true, authorized: true },
      { provider: "exa", available: false, authorized: false, issues: ["exa connector is not authorized"] },
    ],
    apiStates: [
      { name: "exa-search", configured: false, ready: false, issues: ["missing EXA_API_KEY"] },
    ],
    skillStates: [
      { skillId: "browser", installed: true },
    ],
    transportPreferences: [
      { capability: "browser", orderedTransports: ["browser"] },
      { capability: "research", orderedTransports: ["official_api", "business_tool", "browser"] },
    ],
    unavailableCapabilities: ["workspace"],
    generatedAt: Date.now(),
  };
}

function modelsFixture() {
  return {
    modelCatalogPath: "/tmp/turnkeyai-ui-smoke-models.json",
    adapterMode: "llm+heuristic-fallback",
    modelChains: [
      {
        id: "lead_reasoning",
        primary: "minimax-m2",
        fallbacks: ["gpt-5"],
      },
    ],
    defaultSelection: {
      ok: true,
      chainId: "lead_reasoning",
      primaryModelId: "minimax-m2",
      fallbackModelIds: ["gpt-5"],
    },
    models: [
      {
        id: "minimax-m2",
        label: "MiniMax M2",
        providerId: "minimax",
        protocol: "anthropic-compatible",
        model: "MiniMax-M2.7-highspeed",
        apiKeyEnv: "MINIMAX_API_KEY",
        configured: true,
      },
      {
        id: "gpt-5",
        label: "GPT 5",
        providerId: "openai",
        protocol: "openai-compatible",
        model: "gpt-5",
        apiKeyEnv: "OPENAI_API_KEY",
        configured: false,
      },
    ],
  };
}

function modelCatalogConfigFixture(content?: string) {
  const catalogContent = content ?? JSON.stringify(modelCatalogConfigContent(), null, 2);
  return {
    currentModelCatalogPath: "/tmp/turnkeyai-ui-smoke-models.json",
    editableModelCatalogPath: "/tmp/turnkeyai-ui-smoke-models.json",
    exists: true,
    content: catalogContent,
    restartRequired: false,
    liveReloadAvailable: true,
    validation: {
      ok: true,
      errors: [],
      warnings: ["Missing API key env: OPENAI_API_KEY"],
      modelCount: 2,
      chainCount: 1,
      missingApiKeyEnvs: ["OPENAI_API_KEY"],
      missingBaseUrlEnvs: [],
    },
  };
}

function modelCatalogConfigContent(overrides: Record<string, unknown> = {}) {
  return {
    defaultModelChainId: "lead_reasoning",
    models: {
      "minimax-m2": {
        label: "MiniMax M2",
        providerId: "minimax",
        apiType: "anthropic",
        model: "MiniMax-M2.7-highspeed",
        baseURL: "https://minimax.example/v1",
        apiKeyEnv: "MINIMAX_API_KEY",
      },
      "gpt-5": {
        label: "GPT 5",
        providerId: "openai",
        apiType: "openai",
        model: "gpt-5",
        baseURL: "https://api.openai.example/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    },
    modelChains: {
      lead_reasoning: {
        primary: "minimax-m2",
        fallbacks: ["gpt-5"],
      },
    },
    ...overrides,
  };
}

function artifactsFixture() {
  return [
    {
      id: "artifact.snapshot.ui",
      missionId,
      label: "snapshot-ui.json",
      kind: "snapshot",
      path: "artifacts/ui/snapshot-ui.json",
      sizeBytes: 2480,
      sha: "sha256:ui-smoke",
      createdAtMs: 1_779_984_004_100,
      lifecycle: {
        storageBackend: "file",
        refType: "local-path",
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        expiresAtMs: 1_780_588_804_100,
        maxArtifactBytes: 25 * 1024 * 1024,
        sessionBudgetBytes: 100 * 1024 * 1024,
        cleanupOnSessionClose: false,
        orphanReconciliation: "delete_expired",
      },
    },
  ];
}

function contextSourcesFixture() {
  const created = postedContextSources.map((body, index) => {
    const kind = contextSourceKindFromBody(body);
    return {
      id: contextSourceId(kind, index + 1),
      kind,
      title: String((body as { title?: unknown }).title ?? ""),
      url: String((body as { path?: unknown; url?: unknown }).path ?? (body as { url?: unknown }).url ?? ""),
      state: "attached",
      lastUse: "",
      lastUseAtMs: 1_779_984_004_300 + index,
    };
  });
  return [
    {
      id: "ctx.browser.session.browser-ui",
      kind: "browser",
      title: "Browser evidence",
      url: "https://example.com/ui-smoke",
      state: "live",
      lastUse: "now",
      transport: "direct-cdp",
      session: "browser-ui",
      counts: { files: 0, snapshots: 1, screenshots: 0 },
    },
    {
      id: "ctx.doc.unused",
      kind: "doc",
      title: "Unreferenced source",
      url: "file://unused.md",
      state: "idle",
      lastUse: "1h ago",
    },
    ...created,
  ];
}

function contextSourceKindFromBody(body: unknown): string {
  const kind = (body as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : "folder";
}

function contextSourceId(kind: string, index: number): string {
  return `ctx.${kind}.manual.ui-smoke.${index}`;
}

function agentsFixture() {
  return [
    {
      id: "agent.coord",
      name: "Coordinator",
      role: "Coordinator",
      provider: "local runtime",
      providerNote: "lead role",
      status: "working",
      ava: "Co",
      color: "info",
      capabilities: ["plan", "delegate", "review.plan"],
      missions: 1,
      tokensIn: "12k",
      tokensOut: "2k",
    },
    {
      id: "agent.browser",
      name: "Browser Operator",
      role: "Browser",
      provider: "local worker",
      providerNote: "browser tool runtime",
      status: "working",
      ava: "Br",
      color: "warning",
      capabilities: ["browser.navigate", "browser.snapshot", "browser.form"],
      missions: 1,
      tokensIn: "-",
      tokensOut: "-",
    },
    {
      id: "agent.review",
      name: "Reviewer",
      role: "Reviewer",
      provider: "local runtime",
      providerNote: "quality gate",
      status: "planning",
      ava: "Rv",
      color: "success",
      capabilities: ["citation.check", "consistency.check"],
      missions: 1,
      tokensIn: "4k",
      tokensOut: "1k",
    },
  ];
}

function approvalsFixture() {
  return [
    {
      id: "appr.browser.navigate",
      approvalId: "appr.browser.navigate",
      missionId,
      missionTitle: "UI smoke mission",
      agent: "role-browser",
      action: "browser.navigate",
      title: "Navigate browser tab",
      affects: ["ctx.browser.session.browser-ui"],
      risk: "Would change the active browser tab.",
      severity: "medium",
      requestedAt: "2026-05-29 12:00",
      requestedAtMs: 1_779_984_002_500,
      requestedAgo: "now",
      policyHint: "Operator approval required before changing the active browser tab.",
    },
    {
      id: "appr.browser.submit",
      approvalId: "appr.browser.submit",
      missionId,
      missionTitle: "UI smoke mission",
      agent: "role-browser",
      action: "browser.form.submit",
      title: "Submit browser form",
      affects: ["ctx.browser.session.browser-ui"],
      risk: "Would submit data in the active browser session.",
      severity: "medium",
      requestedAt: "2026-05-29 12:00",
      requestedAtMs: 1_779_984_003_000,
      requestedAgo: "now",
      policyHint: "Operator approval required before browser form submission.",
      decision: {
        approvalId: "appr.browser.submit",
        decision: "approved",
        decidedBy: "operator",
        decidedAtMs: 1_779_984_003_500,
        reason: "UI smoke fixture",
      },
    },
  ];
}

async function newSmokePage(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const page = await browser.newPage(options);
  await page.route(/https:\/\/fonts\.googleapis\.com\/.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/css; charset=utf-8",
      body: "",
    });
  });
  await page.route(/https:\/\/fonts\.gstatic\.com\/.*/, async (route) => {
    await route.fulfill({
      status: 204,
      contentType: "font/woff2",
      body: "",
    });
  });
  return page;
}

function workerSessionsFixture() {
  return [
    {
      workerRunKey: "wrk.browser.1",
      executionToken: 1,
      context: {
        threadId,
        flowId: "flow.ui",
        taskId: "task.ui",
        roleId: "role-lead",
        parentSpanId: "span.ui",
        toolCallId: "call-browser",
        label: "Browser evidence",
      },
      state: {
        workerRunKey: "wrk.browser.1",
        workerType: "browser",
        status: "done",
        createdAt: 1_779_984_002_000,
        updatedAt: 1_779_984_004_500,
        history: [
          {
            id: "hist.1",
            role: "tool",
            content: "## Captured evidence\n\n- Live browser snapshot collected with `snapshot`.\n- The tab was reopened from the durable browser session.",
            createdAt: 1_779_984_004_000,
            toolCallId: "call-browser",
            toolName: "snapshot",
            status: "completed",
          },
        ],
        lastResult: {
          workerType: "browser",
          status: "completed",
          summary: "Captured a browser source and returned evidence.",
          payload: {
            sessionId: "browser-ui",
            targetId: "target-reopen",
            resumeMode: "cold",
            targetResolution: "reopen",
            transportLabel: "direct-cdp",
          },
        },
      },
    },
  ];
}

function runtimeSummaryFixture() {
  const attentionChain = {
    chainId: "chain.browser.waiting",
    threadId,
    rootKind: "worker",
    rootId: "wrk.browser.1",
    phase: "waiting",
    canonicalState: "waiting",
    continuityState: "recoverable",
    attention: true,
    updatedAt: Date.now() - 2_000,
    activeSubjectKind: "worker",
    activeSubjectId: "wrk.browser.1",
    waitingReason: "approval required",
    currentWaitingPoint: "browser.form.submit",
    headline: "Browser worker waiting for operator approval",
    nextStep: "Decide the pending browser approval.",
  };
  return {
    totalChains: 2,
    activeCount: 1,
    waitingCount: 1,
    failedCount: 0,
    resolvedCount: 1,
    staleCount: 0,
    attentionCount: 1,
    stateCounts: { waiting: 1, resolved: 1 },
    continuityCounts: { recoverable: 1 },
    caseStateCounts: {},
    attentionChains: [attentionChain],
    activeChains: [attentionChain],
    waitingChains: [attentionChain],
    staleChains: [],
    failedChains: [],
    recentlyResolved: [],
    workerSessionHealth: {
      totalSessions: 1,
      activeSessions: 1,
      orphanedSessions: 0,
      missingContextSessions: 0,
    },
  };
}

function validationOpsFixture() {
  const completedAt = 1_779_984_003_000;
  return {
    totalRuns: 5,
    failedRuns: 0,
    passedRuns: 5,
    attentionCount: 0,
    runTypeCounts: {
      "validation-profile": 1,
      "release-readiness": 1,
      "transport-soak": 1,
      "soak-series": 1,
      "real-llm-acceptance": 1,
    },
    bucketCounts: {},
    severityCounts: {},
    recommendedActionCounts: {},
    latestRuns: [
      {
        runId: "validation-profile-run-ui",
        runType: "validation-profile",
        title: "Mission route real LLM matrix",
        status: "passed",
        startedAt: completedAt - 60_000,
        completedAt,
        durationMs: 60_000,
        issueCount: 0,
      },
      {
        runId: "release-readiness-run-ui",
        runType: "release-readiness",
        title: "Release readiness verification",
        status: "passed",
        startedAt: completedAt - 30_000,
        completedAt: completedAt - 1_000,
        durationMs: 29_000,
        issueCount: 0,
      },
      {
        runId: "real-llm-acceptance-run-ui",
        runType: "real-llm-acceptance",
        title: "Real LLM acceptance",
        status: "passed",
        startedAt: completedAt - 90_000,
        completedAt: completedAt - 2_000,
        durationMs: 88_000,
        issueCount: 0,
        artifactPath: "validation-artifacts/real-llm-acceptance/mission-e2e-ui.json",
        realAcceptance: {
          tooluseScenarios: ["basic", "approval", "followup", "timeout", "complex"],
          missionScenarios: ["basic", "comparison", "browser-dashboard", "realistic-brief"],
          naturalMissionScenarios: [
            "natural-browser-dynamic-page",
            "natural-browser-dashboard-task",
            "natural-long-delegation",
          ],
          browserTooluseEnabled: true,
          totalCases: 12,
          tooluseArtifactPath: "validation-artifacts/real-llm-acceptance/tool-use-e2e-ui.json",
          naturalArtifactPath: "validation-artifacts/real-llm-acceptance/natural-mission-e2e-ui.json",
          releaseCoverage: {
            status: "focused",
            tooluse: { status: "full", requested: 5, expected: 5, missing: 0 },
            mission: { status: "focused", requested: 4, expected: 12, missing: 8 },
            naturalMission: { status: "focused", requested: 3, expected: 21, missing: 18 },
          },
          missionReport: {
            status: "passed",
            scenarioCount: 4,
            scenarioIds: ["basic", "comparison", "browser-dashboard", "realistic-brief"],
            passedScenarios: 4,
            failedScenarios: 0,
            qualityFailures: 0,
            toolRequested: 7,
            toolResults: 7,
            toolFailed: 0,
            toolCancelled: 0,
            toolTimeouts: 0,
            sessionsSpawned: 5,
            sessionsContinued: 1,
            browserProfileFallbacks: 0,
            browserFailureBuckets: 0,
            approvalsRequested: 0,
            approvalsDecided: 0,
            approvalsApplied: 0,
            livenessActive: 0,
            livenessWaiting: 0,
            livenessStale: 0,
            qualityCheckWarnings: 1,
            qualityCheckFailures: 0,
            sourceCoverageWarnings: 1,
            sourceCoverageFailures: 0,
            evidenceEvents: 9,
            recoveryEvents: 0,
            scenarioProofs: ["basic", "comparison", "browser-dashboard", "realistic-brief"].map((scenario) => ({
              scenario,
              passed: true,
              qualityFailures: 0,
              toolRequested: 1,
              toolResults: 1,
              toolFailed: 0,
              toolCancelled: 0,
              toolTimeouts: 0,
              sessionsSpawned: 1,
              sessionsContinued: scenario === "browser-dashboard" ? 1 : 0,
              browserProfileFallbacks: 0,
              browserFailureBuckets: 0,
              approvalsRequested: 0,
              approvalsDecided: 0,
              approvalsApplied: 0,
              livenessActive: 0,
              livenessWaiting: 0,
              livenessStale: 0,
              qualityCheckFailures: 0,
              sourceCoverageFailures: 0,
              evidenceEvents: 1,
              recoveryEvents: 0,
            })),
          },
          naturalMissionReport: {
            status: "passed",
            scenarioCount: 3,
            scenarioIds: [
              "natural-browser-dynamic-page",
              "natural-browser-dashboard-task",
              "natural-long-delegation",
            ],
            passedScenarios: 3,
            failedScenarios: 0,
            completed: 3,
            stuckOrLoop: 0,
            reasonableToolUse: 3,
            browserUsed: 2,
            subAgentCompleted: 3,
            approvalExercised: 1,
            finalAnswerHasEvidence: 3,
            finalAnswerUseful: 3,
            weakAnswerSignals: 0,
            toolRequested: 6,
            toolResults: 6,
            toolFailed: 0,
            toolCancelled: 0,
            toolTimeouts: 0,
            sessionsSpawned: 4,
            sessionsContinued: 1,
            browserProfileFallbacks: 0,
            browserFailureBuckets: 0,
            approvalsRequested: 1,
            approvalsDecided: 1,
            approvalsApplied: 1,
            livenessActive: 0,
            livenessWaiting: 0,
            livenessStale: 0,
            evidenceEvents: 5,
            sourceAnswerTermsCovered: 8,
            sourceAnswerTermsTotal: 9,
            sourceAnswerTermsMissing: 1,
            sourceAnswerPatternsCovered: 4,
            sourceAnswerPatternsTotal: 4,
            sourceAnswerPatternsMissing: 0,
            sourceEvidencePatternsCovered: 7,
            sourceEvidencePatternsTotal: 8,
            sourceEvidencePatternsMissing: 1,
            sourceEvidenceEventsObserved: 5,
            sourceEvidenceEventsRequired: 3,
            sourceResidualRiskVisible: 3,
            sourceUnsupportedClaims: 0,
            recoveryEvents: 0,
            scenarioProofs: [
              {
                scenario: "natural-browser-dynamic-page",
                passed: true,
                completed: true,
                stuckOrLoop: false,
                reasonableToolUse: true,
                browserUsed: true,
                subAgentCompleted: true,
                approvalExercised: false,
                finalAnswerHasEvidence: true,
                finalAnswerUseful: true,
                weakAnswerSignals: 0,
                toolFailed: 0,
                toolCancelled: 0,
                toolTimeouts: 0,
                sessionsSpawned: 1,
                sessionsContinued: 0,
                browserProfileFallbacks: 0,
                browserFailureBuckets: 0,
                approvalsRequested: 0,
                approvalsDecided: 0,
                approvalsApplied: 0,
                livenessActive: 0,
                livenessWaiting: 0,
                livenessStale: 0,
                evidenceEvents: 2,
                recoveryEvents: 0,
                sourceResidualRiskVisible: true,
                sourceUnsupportedClaims: 0,
                sourceAnswerTermsMissing: 0,
                sourceAnswerPatternsMissing: 0,
                sourceEvidencePatternsMissing: 0,
              },
              {
                scenario: "natural-browser-dashboard-task",
                passed: true,
                completed: true,
                stuckOrLoop: false,
                reasonableToolUse: true,
                browserUsed: true,
                subAgentCompleted: true,
                approvalExercised: false,
                finalAnswerHasEvidence: true,
                finalAnswerUseful: true,
                weakAnswerSignals: 0,
                toolFailed: 0,
                toolCancelled: 0,
                toolTimeouts: 0,
                sessionsSpawned: 1,
                sessionsContinued: 0,
                browserProfileFallbacks: 0,
                browserFailureBuckets: 0,
                approvalsRequested: 0,
                approvalsDecided: 0,
                approvalsApplied: 0,
                livenessActive: 0,
                livenessWaiting: 0,
                livenessStale: 0,
                evidenceEvents: 2,
                recoveryEvents: 0,
                sourceResidualRiskVisible: true,
                sourceUnsupportedClaims: 0,
                sourceAnswerTermsMissing: 0,
                sourceAnswerPatternsMissing: 0,
                sourceEvidencePatternsMissing: 0,
              },
              {
                scenario: "natural-long-delegation",
                passed: true,
                completed: true,
                stuckOrLoop: false,
                reasonableToolUse: true,
                browserUsed: false,
                subAgentCompleted: true,
                approvalExercised: true,
                finalAnswerHasEvidence: true,
                finalAnswerUseful: true,
                weakAnswerSignals: 0,
                toolFailed: 0,
                toolCancelled: 0,
                toolTimeouts: 0,
                sessionsSpawned: 2,
                sessionsContinued: 1,
                browserProfileFallbacks: 0,
                browserFailureBuckets: 0,
                approvalsRequested: 1,
                approvalsDecided: 1,
                approvalsApplied: 1,
                livenessActive: 0,
                livenessWaiting: 0,
                livenessStale: 0,
                evidenceEvents: 1,
                recoveryEvents: 0,
                sourceResidualRiskVisible: true,
                sourceUnsupportedClaims: 0,
                sourceAnswerTermsMissing: 1,
                sourceAnswerPatternsMissing: 0,
                sourceEvidencePatternsMissing: 1,
              },
            ],
          },
        },
      },
    ],
    activeIssues: [],
    readiness: {
      status: "missing",
      summary: "Phase 1 exit gates need attention: failed=0 missing=1.",
      passedGates: 4,
      failedGates: 0,
      missingGates: 1,
      nextCommand: "npm run acceptance:real -- --model-catalog models.local.json",
      gates: [
        {
          gateId: "phase1-e2e-profile",
          title: "Mission route real LLM matrix",
          status: "passed",
          summary: "Mission route real LLM matrix passed with 0 issue(s).",
          commandHint: "validation-profile-run phase1-e2e",
          latestRunId: "validation-profile-run-ui",
          recordedAt: completedAt,
        },
        {
          gateId: "real-llm-acceptance",
          title: "Real LLM acceptance",
          status: "missing",
          summary:
            "Real LLM acceptance passed, but only focused coverage is recorded (tool-use 5/5; mission 4/12 missing 8; natural 3/21 missing 18).",
          commandHint: "npm run acceptance:real -- --model-catalog models.local.json",
          latestRunId: "real-llm-acceptance-run-ui",
          recordedAt: completedAt - 2_000,
        },
        {
          gateId: "release-readiness",
          title: "Release readiness",
          status: "passed",
          summary: "Release readiness verification passed with 0 issue(s).",
          commandHint: "release-verify",
          latestRunId: "release-readiness-run-ui",
          recordedAt: completedAt - 1_000,
        },
        {
          gateId: "transport-soak",
          title: "Browser transport soak",
          status: "passed",
          summary: "Browser transport soak passed with 0 issue(s).",
          commandHint: "transport-soak 3 relay direct-cdp",
          latestRunId: "transport-soak-run-ui",
          recordedAt: completedAt - 3_000,
        },
        {
          gateId: "soak-series",
          title: "Acceptance/realworld/soak series",
          status: "passed",
          summary: "Validation soak series passed with 0 issue(s).",
          commandHint: "soak-series 3 acceptance realworld soak",
          latestRunId: "soak-series-run-ui",
          recordedAt: completedAt - 4_000,
        },
      ],
    },
    closedLoop: {
      closedLoopStatus: "completed",
      totalCases: 8,
      completedCases: 8,
      actionableCases: 0,
      silentFailureCases: 0,
      ambiguousFailureCases: 0,
      closedLoopCases: 8,
      closedLoopRate: 1,
      rerunCommand: "validation-ops",
      measuredRuns: 5,
      statusCounts: { completed: 5 },
      nextCommand: "validation-ops",
      latestRunId: "validation-profile-run-ui",
    },
    baseline: {
      status: "fresh-passing",
      summary: "Phase 1 baseline is fresh and passing.",
      nextCommand: "validation-ops",
      staleAfterMs: 129_600_000,
      latestRunId: "phase1-baseline-run-ui",
      recordedAt: completedAt,
      ageMs: 12_000,
      requiredRuns: 3,
      consecutivePassedRuns: 3,
    },
  };
}

function recoveryRunsFixture() {
  return {
    totalRuns: 1,
    runs: [
      {
        recoveryRunId: "recovery:browser-detached",
        threadId,
        sourceGroupId: "group.browser-detached",
        taskId: "task.browser-detached",
        flowId: "flow.ui",
        roleId: "role-browser",
        targetLayer: "worker",
        targetWorker: "browser",
        latestStatus: "failed",
        status: "waiting_approval",
        nextAction: "resume_session",
        autoDispatchReady: false,
        requiresManualIntervention: true,
        latestSummary: "Browser target detached while collecting evidence.",
        waitingReason: "Approval required before browser resume.",
        latestFailure: {
          category: "stale_session",
          layer: "browser",
          retryable: true,
          message: "Browser target detached.",
          recommendedAction: "resume",
        },
        currentAttemptId: "attempt.browser.resume",
        browserSession: {
          sessionId: "browser-ui",
          targetId: "target-reopen",
          resumeMode: "cold",
        },
        attempts: [
          {
            attemptId: "attempt.browser.resume",
            action: "resume",
            requestedAt: 1_779_984_004_000,
            updatedAt: 1_779_984_004_400,
            status: "waiting_approval",
            nextAction: "resume_session",
            summary: "Waiting for approval before resuming the browser session.",
            targetLayer: "worker",
            targetWorker: "browser",
            browserSession: {
              sessionId: "browser-ui",
              targetId: "target-reopen",
              resumeMode: "cold",
            },
            browserOutcome: "cold_reopen",
            browserOutcomeSummary: "Will reopen the last known target if approved.",
          },
        ],
        createdAt: 1_779_984_004_000,
        updatedAt: 1_779_984_004_400,
        confirmed: true,
        inferred: false,
        truthSource: "recovery-runtime",
      },
    ],
  };
}

function sessionMemoryFixture() {
  return {
    threadId,
    memoryVersion: 3,
    sourceMessageCount: 6,
    sectionFingerprint: "ctx-ui-smoke",
    updatedAt: 1_779_984_004_800,
    activeTasks: ["Verify final answer against captured browser evidence."],
    openQuestions: ["Does the source need a screenshot artifact?"],
    recentDecisions: ["Use the browser worker result as the primary evidence source."],
    constraints: ["Do not treat unreferenced context sources as evidence."],
    continuityNotes: ["Keep browser evidence ahead of final synthesis."],
    latestJournalEntries: ["Browser worker captured the relevant page state."],
  };
}

function roleRunsFixture() {
  return [
    {
      runKey: "run.role-lead.done",
      threadId,
      roleId: "role-lead",
      status: "done",
      generation: 1,
      iterationCount: 2,
      maxIterations: 128,
      queuedAt: 1_779_984_001_000,
      startedAt: 1_779_984_001_200,
      lastActiveAt: 1_779_984_005_000,
      workerSessions: {},
      inbox: [],
    },
  ];
}

function event(
  id: string,
  kind: string,
  tMs: number,
  actor: string,
  text: string,
  runtime?: Record<string, string>,
  target?: string
) {
  return {
    id,
    missionId,
    t: `12:00:${String(Math.floor(tMs / 1000)).padStart(2, "0")}`,
    tMs,
    kind,
    actor,
    text,
    ...(runtime ? { runtime } : {}),
    ...(target ? { target } : {}),
  };
}

function tool(
  id: string,
  tMs: number,
  phase: "call" | "progress" | "result",
  toolName: string,
  toolCallId: string,
  text: string,
  options: { messageId?: string; round?: string } = {}
) {
  return event(id, "tool", tMs, "role-lead", text, {
    route: "lead-role",
    toolPhase: phase,
    toolName,
    toolCallId,
    messageId: options.messageId ?? "msg.ui.1",
    round: options.round ?? "1",
    ...(phase === "call" ? { callInput: JSON.stringify({ workerType: "browser" }) } : {}),
    ...(phase === "progress" ? { progressDetail: "context opened" } : {}),
    ...(phase === "result"
      ? {
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            session_key: "wrk.browser.1",
            agent_id: "browser",
            status: "completed",
            result: "3 evidence bullets",
          }),
        }
      : {}),
  });
}

async function assertVerticalOrder(
  page: Page,
  topSelector: string,
  bottomSelector: string,
  message: string
): Promise<void> {
  const order = await page.evaluate(
    ([top, bottom]) => {
      const topEl = document.querySelector(top);
      const bottomEl = document.querySelector(bottom);
      if (!topEl || !bottomEl) return null;
      const topRect = topEl.getBoundingClientRect();
      const bottomRect = bottomEl.getBoundingClientRect();
      return { topBottom: topRect.bottom, bottomTop: bottomRect.top };
    },
    [topSelector, bottomSelector]
  );
  assert(order !== null, `missing elements for order check: ${topSelector}, ${bottomSelector}`);
  assert(order.topBottom <= order.bottomTop + 1, `${message}: ${JSON.stringify(order)}`);
}

async function assertNoOverlap(
  page: Page,
  firstSelector: string,
  secondSelector: string,
  message: string
): Promise<void> {
  const overlap = await page.evaluate(
    ([first, second]) => {
      const firstEl = document.querySelector(first);
      const secondEl = document.querySelector(second);
      if (!firstEl || !secondEl) return null;
      const a = firstEl.getBoundingClientRect();
      const b = secondEl.getBoundingClientRect();
      return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    },
    [firstSelector, secondSelector]
  );
  assert(overlap === false, message);
}

async function assertWithinViewport(page: Page, selector: string, message: string): Promise<void> {
  const result = await page.evaluate((target) => {
    const el = document.querySelector(target);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewportWidth: document.documentElement.clientWidth,
    };
  }, selector);
  assert(result !== null, `missing element for viewport check: ${selector}`);
  assert(result.left >= -1, `${message}: ${JSON.stringify(result)}`);
  assert(result.right <= result.viewportWidth + 1, `${message}: ${JSON.stringify(result)}`);
}

interface MissionLayoutEvidence {
  viewport: {
    width: number;
    height: number;
  };
  traceExpanded: boolean;
  toolProcessCount: number;
  traceFinalAnswerLinkVisible: boolean;
  finalAnswerVisible: boolean;
  thinkingBeforeFinal: boolean;
  timelineBeforeFinal: boolean;
  traceFinalOverlap: boolean | null;
  horizontalOverflowPx: number;
  missingSelectors: string[];
}

interface SmokeArtifactInput {
  artifactDir: string;
  desktopScreenshot: Buffer;
  mobileScreenshot: Buffer;
  desktopLayoutEvidence: MissionLayoutEvidence;
  mobileLayoutEvidence: MissionLayoutEvidence;
}

async function collectMissionLayoutEvidence(page: Page): Promise<MissionLayoutEvidence> {
  return page.evaluate(() => {
    const thinking = document.querySelector(".thinking-card")?.getBoundingClientRect() ?? null;
    const timeline = document.querySelector("#thinking-record-timeline")?.getBoundingClientRect() ?? null;
    const finalAnswer = document.querySelector(".final-answer-card")?.getBoundingClientRect() ?? null;
    const missingSelectors = [
      ...(thinking ? [] : [".thinking-card"]),
      ...(timeline ? [] : ["#thinking-record-timeline"]),
      ...(finalAnswer ? [] : [".final-answer-card"]),
    ];
    const overlaps =
      thinking && finalAnswer
        ? !(thinking.right <= finalAnswer.left || finalAnswer.right <= thinking.left || thinking.bottom <= finalAnswer.top || finalAnswer.bottom <= thinking.top)
        : null;
    const clientWidth = document.documentElement.clientWidth;
    return {
      viewport: {
        width: clientWidth,
        height: document.documentElement.clientHeight,
      },
      traceExpanded: Boolean(document.querySelector("#thinking-record-timeline")),
      toolProcessCount: document.querySelectorAll("#thinking-record-timeline .tool-process").length,
      traceFinalAnswerLinkVisible: Boolean(document.querySelector(".tool-process-answer-link")),
      finalAnswerVisible: Boolean(document.querySelector(".final-answer-card")),
      thinkingBeforeFinal: Boolean(thinking && finalAnswer && thinking.bottom <= finalAnswer.top + 1),
      timelineBeforeFinal: Boolean(timeline && finalAnswer && timeline.bottom <= finalAnswer.top + 1),
      traceFinalOverlap: overlaps,
      horizontalOverflowPx: Math.max(0, Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - clientWidth),
      missingSelectors,
    };
  });
}

async function writeSmokeArtifacts(input: SmokeArtifactInput): Promise<{
  summaryPath: string;
  desktopScreenshotPath: string;
  mobileScreenshotPath: string;
}> {
  await mkdir(input.artifactDir, { recursive: true });
  const desktopScreenshotPath = path.join(input.artifactDir, "mission-detail-desktop.png");
  const mobileScreenshotPath = path.join(input.artifactDir, "mission-detail-mobile.png");
  const summaryPath = path.join(input.artifactDir, "control-center-ui-smoke-summary.json");
  await Promise.all([
    writeFile(desktopScreenshotPath, input.desktopScreenshot),
    writeFile(mobileScreenshotPath, input.mobileScreenshot),
    writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          kind: "turnkeyai.control-center-ui-smoke.v1",
          missionId,
          generatedAt: new Date().toISOString(),
          screenshots: {
            desktop: {
              path: desktopScreenshotPath,
              bytes: input.desktopScreenshot.byteLength,
            },
            mobile: {
              path: mobileScreenshotPath,
              bytes: input.mobileScreenshot.byteLength,
            },
          },
          layout: {
            desktop: input.desktopLayoutEvidence,
            mobile: input.mobileLayoutEvidence,
          },
          replayThoughtProcessProof: {
            missionId,
            surfaces: ["desktop", "mobile"],
            checks: [
              "trace-expanded",
              "tool-process-visible",
              "thinking-card-before-final-answer",
              "timeline-before-final-answer",
              "trace-final-answer-link-visible",
              "trace-final-answer-non-overlap",
            ],
            runtimeStates: [
              "completed-final-answer",
              "browser-evidence",
              "approval-evidence",
              "active-running-tool-process",
              "cancellable-tool-call",
            ],
            desktopPassed:
              input.desktopLayoutEvidence.traceExpanded &&
              input.desktopLayoutEvidence.toolProcessCount > 0 &&
              input.desktopLayoutEvidence.traceFinalAnswerLinkVisible &&
              input.desktopLayoutEvidence.finalAnswerVisible &&
              input.desktopLayoutEvidence.thinkingBeforeFinal &&
              input.desktopLayoutEvidence.timelineBeforeFinal &&
              input.desktopLayoutEvidence.traceFinalOverlap === false,
            mobilePassed:
              input.mobileLayoutEvidence.traceExpanded &&
              input.mobileLayoutEvidence.toolProcessCount > 0 &&
              input.mobileLayoutEvidence.traceFinalAnswerLinkVisible &&
              input.mobileLayoutEvidence.finalAnswerVisible &&
              input.mobileLayoutEvidence.thinkingBeforeFinal &&
              input.mobileLayoutEvidence.timelineBeforeFinal &&
              input.mobileLayoutEvidence.traceFinalOverlap === false,
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
  ]);
  return { summaryPath, desktopScreenshotPath, mobileScreenshotPath };
}

async function assertNoPageHorizontalOverflow(page: Page, message: string): Promise<void> {
  const result = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert(
    Math.max(result.bodyScrollWidth, result.docScrollWidth) <= result.clientWidth + 1,
    `${message}: ${JSON.stringify(result)}`
  );
}

async function assertTableScrollsInsideWrapper(page: Page, selector: string, message: string): Promise<void> {
  const result = await page.evaluate((target) => {
    const el = document.querySelector(target);
    if (!el) return null;
    return {
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowX: getComputedStyle(el).overflowX,
    };
  }, selector);
  assert(result !== null, `missing element for table scroll check: ${selector}`);
  assert(result.overflowX === "auto" || result.overflowX === "scroll", `${message}: ${JSON.stringify(result)}`);
  assert(result.scrollWidth > result.clientWidth, `${message}: ${JSON.stringify(result)}`);
}

async function waitForReplayReady(page: Page): Promise<void> {
  const openReplay = page.getByRole("button", { name: /Open replay/ });
  await openReplay.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => /Open replay/i.test(button.textContent ?? "") && !button.disabled
      ),
    undefined,
    { timeout: 30_000 }
  );
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isIgnorableConsoleError(text: string): boolean {
  return (
    (text.includes("fonts.gstatic.com/") || text.includes("fonts.googleapis.com/")) &&
    text.includes("Failed to load resource:")
  );
}

async function resolveChromePath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error("no supported Chromium executable found; pass --browser-path or set TURNKEYAI_BROWSER_PATH");
}

async function resolveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}
