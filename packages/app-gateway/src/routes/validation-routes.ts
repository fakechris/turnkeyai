import type http from "node:http";

import type {
  Phase1BaselineRunResult,
  Phase1BaselineRunSummary,
  Phase1ReadinessRunResult,
  Phase1ReadinessRunStage,
  ValidationOpsRunRecord,
  ValidationOpsRunStore,
} from "@turnkeyai/core-types/team";
import type {
  BrowserTransportSoakOptions,
  BrowserTransportSoakResult,
} from "@turnkeyai/qc-runtime/browser-transport-soak";
import {
  listBoundedRegressionCases,
  runBoundedRegressionSuite,
} from "@turnkeyai/qc-runtime/bounded-regression-harness";
import {
  listFailureInjectionScenarios,
  runFailureInjectionSuite,
} from "@turnkeyai/qc-runtime/failure-injection-suite";
import {
  listRealWorldScenarios,
  runRealWorldSuite,
} from "@turnkeyai/qc-runtime/real-world-suite";
import { runReleaseReadiness } from "@turnkeyai/qc-runtime/release-readiness";
import type {
  ReleaseReadinessOptions,
  ReleaseReadinessResult,
} from "@turnkeyai/qc-runtime/release-readiness";
import {
  listScenarioParityAcceptanceScenarios,
  runScenarioParityAcceptanceSuite,
} from "@turnkeyai/qc-runtime/scenario-parity-acceptance";
import {
  listSoakScenarios,
  runSoakSuite,
} from "@turnkeyai/qc-runtime/soak-suite";
import {
  isValidationProfileId,
  listValidationProfiles,
  runValidationProfile,
  summarizeValidationProfileResult,
} from "@turnkeyai/qc-runtime/validation-profile";
import {
  buildValidationOpsRecordFromPhase1Baseline,
  buildValidationOpsRecordFromReleaseReadiness,
  buildValidationOpsRecordFromSoakSeries,
  buildValidationOpsRecordFromTransportSoak,
  buildValidationOpsRecordFromValidationProfile,
  buildValidationOpsReport,
} from "@turnkeyai/qc-runtime/validation-ops-inspection";
import { runValidationSoakSeries } from "@turnkeyai/qc-runtime/validation-soak-series";
import {
  listValidationSuites,
  runValidationSuites,
  ValidationSelectorError,
} from "@turnkeyai/qc-runtime/validation-suite";

import { readJsonBodySafe, sendJson } from "../http-helpers";

export interface ValidationRouteDeps {
  validationOpsRunStore: ValidationOpsRunStore;
  createValidationOpsRunId: (
    kind: "release-readiness" | "validation-profile" | "soak-series" | "transport-soak" | "phase1-baseline"
  ) => string;
  writeValidationArtifact: (kind: string, runId: string, payload: unknown) => Promise<string>;
  runBrowserTransportSoakViaCli: (options?: BrowserTransportSoakOptions) => Promise<BrowserTransportSoakResult>;
  runReleaseReadiness?: (options?: ReleaseReadinessOptions) => Promise<ReleaseReadinessResult>;
}

const PHASE1_READINESS_SOAK_SELECTORS = [
  "acceptance:phase1-production-closure",
  "realworld:phase1-production-closure-runbook",
  "soak:phase1-production-closure-long-chain",
  "soak:transport-soak-validation-ops-readiness",
] as const;

const PHASE1_READINESS_TRANSPORT_TARGETS = ["relay", "direct-cdp"] as const;

export async function handleValidationRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: ValidationRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method === "GET" && url.pathname === "/regression-cases") {
    const cases = listBoundedRegressionCases();
    sendJson(res, 200, {
      totalCases: cases.length,
      cases,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/regression-cases/run") {
    const bodyResult = await readJsonBodySafe<{ caseIds?: string[] }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const caseIds = filterNonEmptyStrings(body.caseIds);
    sendJson(res, 200, runBoundedRegressionSuite(caseIds));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/failure-cases") {
    const scenarios = listFailureInjectionScenarios();
    sendJson(res, 200, {
      totalScenarios: scenarios.length,
      scenarios,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/failure-cases/run") {
    const bodyResult = await readJsonBodySafe<{ scenarioIds?: string[] }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const scenarioIds = filterNonEmptyStrings(body.scenarioIds);
    sendJson(res, 200, runFailureInjectionSuite(scenarioIds));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/soak-cases") {
    const scenarios = listSoakScenarios();
    sendJson(res, 200, {
      totalScenarios: scenarios.length,
      scenarios,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/soak-cases/run") {
    const bodyResult = await readJsonBodySafe<{ scenarioIds?: string[] }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const scenarioIds = filterNonEmptyStrings(body.scenarioIds);
    if (scenarioIds && scenarioIds.length > 0) {
      const invalidScenarioIds = findUnknownScenarioIds(
        scenarioIds,
        listSoakScenarios().map((scenario) => scenario.scenarioId)
      );
      if (invalidScenarioIds.length > 0) {
        sendJson(res, 400, {
          error: "unknown scenario ids",
          invalidScenarioIds,
        });
        return true;
      }
    }
    sendJson(res, 200, runSoakSuite(scenarioIds));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/acceptance-cases") {
    const scenarios = listScenarioParityAcceptanceScenarios();
    sendJson(res, 200, {
      totalScenarios: scenarios.length,
      scenarios,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/acceptance-cases/run") {
    const bodyResult = await readJsonBodySafe<{ scenarioIds?: string[] }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const scenarioIds = filterNonEmptyStrings(body.scenarioIds);
    if (scenarioIds && scenarioIds.length > 0) {
      const invalidScenarioIds = findUnknownScenarioIds(
        scenarioIds,
        listScenarioParityAcceptanceScenarios().map((scenario) => scenario.scenarioId)
      );
      if (invalidScenarioIds.length > 0) {
        sendJson(res, 400, {
          error: "unknown scenario ids",
          invalidScenarioIds,
        });
        return true;
      }
    }
    sendJson(res, 200, runScenarioParityAcceptanceSuite(scenarioIds));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/realworld-cases") {
    const scenarios = listRealWorldScenarios();
    sendJson(res, 200, {
      totalScenarios: scenarios.length,
      scenarios,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/realworld-cases/run") {
    const bodyResult = await readJsonBodySafe<{ scenarioIds?: string[] }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const scenarioIds = filterNonEmptyStrings(body.scenarioIds);
    if (scenarioIds && scenarioIds.length > 0) {
      const invalidScenarioIds = findUnknownScenarioIds(
        scenarioIds,
        listRealWorldScenarios().map((scenario) => scenario.scenarioId)
      );
      if (invalidScenarioIds.length > 0) {
        sendJson(res, 400, {
          error: "unknown scenario ids",
          invalidScenarioIds,
        });
        return true;
      }
    }
    sendJson(res, 200, runRealWorldSuite(scenarioIds));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/validation-cases") {
    const suites = listValidationSuites();
    sendJson(res, 200, {
      totalSuites: suites.length,
      totalItems: suites.reduce((sum: number, suite) => sum + suite.totalItems, 0),
      suites,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/validation-cases/run") {
    const bodyResult = await readJsonBodySafe<{ selectors?: string[] }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const selectors = filterNonEmptyStrings(body.selectors);
    try {
      sendJson(res, 200, runValidationSuites(selectors));
    } catch (error) {
      if (error instanceof ValidationSelectorError) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/validation-profiles") {
    const profiles = listValidationProfiles();
    sendJson(res, 200, {
      totalProfiles: profiles.length,
      profiles,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/validation-ops") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "10");
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 10;
    const records = await deps.validationOpsRunStore.list(Math.max(limit, 50));
    sendJson(res, 200, buildValidationOpsReport(records, limit));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/validation-profiles/run") {
    const bodyResult = await readJsonBodySafe<{ profileId?: string }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const profileId = typeof body.profileId === "string" ? body.profileId.trim() : undefined;
    if (!profileId || !isValidationProfileId(profileId)) {
      sendJson(res, 400, { error: "Unknown validation profile" });
      return true;
    }
    const startedAt = Date.now();
    const result = await runValidationProfile(profileId, {}, {
      releaseReadinessRunner: deps.runReleaseReadiness ?? runReleaseReadiness,
      validationRunner: runValidationSuites,
      transportSoakRunner: (options) => deps.runBrowserTransportSoakViaCli(options),
    });
    const completedAt = Date.now();
    await deps.validationOpsRunStore.put(
      buildValidationOpsRecordFromValidationProfile({
        runId: deps.createValidationOpsRunId("validation-profile"),
        startedAt,
        completedAt,
        result,
      })
    );
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/soak-series/run") {
    const bodyResult = await readJsonBodySafe<{ cycles?: number; selectors?: string[] }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const selectors = filterTrimmedStrings(body.selectors);
    if (body.cycles !== undefined && (!Number.isInteger(body.cycles) || body.cycles <= 0)) {
      sendJson(res, 400, { error: "Invalid cycles: must be a positive integer" });
      return true;
    }
    const cycles = body.cycles !== undefined ? Number(body.cycles) : undefined;
    try {
      const startedAt = Date.now();
      const result = await runValidationSoakSeries({
        ...(cycles !== undefined ? { cycles } : {}),
        ...(selectors !== undefined ? { selectors } : {}),
      });
      const completedAt = Date.now();
      await deps.validationOpsRunStore.put(
        buildValidationOpsRecordFromSoakSeries({
          runId: deps.createValidationOpsRunId("soak-series"),
          startedAt,
          completedAt,
          selectors: result.selectors,
          result,
        })
      );
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof ValidationSelectorError) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/transport-soak/run") {
    const bodyResult = await readJsonBodySafe<{
      cycles?: number;
      timeoutMs?: number;
      relayPeerCount?: number;
      verifyReconnect?: boolean;
      verifyWorkflowLog?: boolean;
      targets?: string[];
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (body.cycles !== undefined && (!Number.isInteger(body.cycles) || body.cycles <= 0)) {
      sendJson(res, 400, { error: "Invalid cycles: must be a positive integer" });
      return true;
    }
    if (body.timeoutMs !== undefined && (!Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0)) {
      sendJson(res, 400, { error: "Invalid timeoutMs: must be a positive number" });
      return true;
    }
    if (body.relayPeerCount !== undefined && (!Number.isInteger(body.relayPeerCount) || body.relayPeerCount <= 0)) {
      sendJson(res, 400, { error: "Invalid relayPeerCount: must be a positive integer" });
      return true;
    }
    if (body.verifyReconnect !== undefined && typeof body.verifyReconnect !== "boolean") {
      sendJson(res, 400, { error: "Invalid verifyReconnect: must be a boolean" });
      return true;
    }
    if (body.verifyWorkflowLog !== undefined && typeof body.verifyWorkflowLog !== "boolean") {
      sendJson(res, 400, { error: "Invalid verifyWorkflowLog: must be a boolean" });
      return true;
    }
    const targets = Array.isArray(body.targets)
      ? body.targets
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value): value is "relay" | "direct-cdp" => value === "relay" || value === "direct-cdp")
      : undefined;
    const startedAt = Date.now();
    const result = await deps.runBrowserTransportSoakViaCli({
      ...(body.cycles !== undefined ? { cycles: Number(body.cycles) } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: Math.trunc(body.timeoutMs) } : {}),
      ...(body.relayPeerCount !== undefined ? { relayPeerCount: Number(body.relayPeerCount) } : {}),
      ...(body.verifyReconnect !== undefined ? { verifyReconnect: body.verifyReconnect } : {}),
      ...(body.verifyWorkflowLog !== undefined ? { verifyWorkflowLog: body.verifyWorkflowLog } : {}),
      ...(targets && targets.length > 0 ? { targets } : {}),
    });
    const completedAt = Date.now();
    const runId = deps.createValidationOpsRunId("transport-soak");
    const artifactPath = await deps.writeValidationArtifact("transport-soak", runId, result);
    await deps.validationOpsRunStore.put(
      buildValidationOpsRecordFromTransportSoak({
        runId,
        startedAt,
        completedAt,
        artifactPath,
        result,
      })
    );
    sendJson(res, 200, {
      ...result,
      artifactPath,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/release-readiness/run") {
    const startedAt = Date.now();
    const result = await (deps.runReleaseReadiness ?? runReleaseReadiness)();
    const completedAt = Date.now();
    await deps.validationOpsRunStore.put(
      buildValidationOpsRecordFromReleaseReadiness({
        runId: deps.createValidationOpsRunId("release-readiness"),
        startedAt,
        completedAt,
        result,
      })
    );
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/phase1-readiness/run") {
    const bodyResult = await readJsonBodySafe<{
      transportCycles?: number;
      soakCycles?: number;
      releaseSkipBuild?: boolean;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (body.transportCycles !== undefined && (!Number.isInteger(body.transportCycles) || body.transportCycles <= 0)) {
      sendJson(res, 400, { error: "Invalid transportCycles: must be a positive integer" });
      return true;
    }
    if (body.soakCycles !== undefined && (!Number.isInteger(body.soakCycles) || body.soakCycles <= 0)) {
      sendJson(res, 400, { error: "Invalid soakCycles: must be a positive integer" });
      return true;
    }
    if (body.releaseSkipBuild !== undefined && typeof body.releaseSkipBuild !== "boolean") {
      sendJson(res, 400, { error: "Invalid releaseSkipBuild: must be a boolean" });
      return true;
    }

    const result = await runPhase1Readiness({
      deps,
      transportCycles: body.transportCycles ?? 3,
      soakCycles: body.soakCycles ?? 3,
      releaseSkipBuild: body.releaseSkipBuild ?? false,
    });
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/phase1-baseline/run") {
    const bodyResult = await readJsonBodySafe<{
      runs?: number;
      transportCycles?: number;
      soakCycles?: number;
      releaseSkipBuild?: boolean;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (body.runs !== undefined && (!Number.isInteger(body.runs) || body.runs <= 0)) {
      sendJson(res, 400, { error: "Invalid runs: must be a positive integer" });
      return true;
    }
    if (body.transportCycles !== undefined && (!Number.isInteger(body.transportCycles) || body.transportCycles <= 0)) {
      sendJson(res, 400, { error: "Invalid transportCycles: must be a positive integer" });
      return true;
    }
    if (body.soakCycles !== undefined && (!Number.isInteger(body.soakCycles) || body.soakCycles <= 0)) {
      sendJson(res, 400, { error: "Invalid soakCycles: must be a positive integer" });
      return true;
    }
    if (body.releaseSkipBuild !== undefined && typeof body.releaseSkipBuild !== "boolean") {
      sendJson(res, 400, { error: "Invalid releaseSkipBuild: must be a boolean" });
      return true;
    }

    const result = await runPhase1Baseline({
      deps,
      runs: body.runs ?? 3,
      transportCycles: body.transportCycles ?? 3,
      soakCycles: body.soakCycles ?? 3,
      releaseSkipBuild: body.releaseSkipBuild ?? false,
    });
    sendJson(res, 200, result);
    return true;
  }

  return false;
}

async function runPhase1Readiness(input: {
  deps: ValidationRouteDeps;
  transportCycles: number;
  soakCycles: number;
  releaseSkipBuild: boolean;
}): Promise<Phase1ReadinessRunResult> {
  const { deps } = input;
  const startedAt = Date.now();
  const stages: Phase1ReadinessRunStage[] = [];
  const records: ValidationOpsRunRecord[] = [];
  const releaseReadinessRunner = deps.runReleaseReadiness ?? runReleaseReadiness;

  const profileStartedAt = Date.now();
  const profileResult = await runValidationProfile("phase1-e2e", {}, {
    releaseReadinessRunner,
    validationRunner: runValidationSuites,
    transportSoakRunner: (options) => deps.runBrowserTransportSoakViaCli(options),
  });
  const profileRunId = deps.createValidationOpsRunId("validation-profile");
  const profileRecord = buildValidationOpsRecordFromValidationProfile({
    runId: profileRunId,
    startedAt: profileStartedAt,
    completedAt: Date.now(),
    result: profileResult,
  });
  await deps.validationOpsRunStore.put(profileRecord);
  records.push(profileRecord);
  stages.push({
    stageId: "validation-profile",
    title: "Phase 1 E2E validation profile",
    status: profileResult.status,
    runId: profileRunId,
    durationMs: Date.now() - profileStartedAt,
    summary: summarizeValidationProfileResult(profileResult),
    commandHint: "validation-profile-run phase1-e2e",
  });

  const transportStartedAt = Date.now();
  const transportResult = await deps.runBrowserTransportSoakViaCli({
    cycles: input.transportCycles,
    targets: [...PHASE1_READINESS_TRANSPORT_TARGETS],
    verifyReconnect: true,
    verifyWorkflowLog: true,
  });
  const transportRunId = deps.createValidationOpsRunId("transport-soak");
  const transportArtifactPath = await deps.writeValidationArtifact("transport-soak", transportRunId, transportResult);
  const transportRecord = buildValidationOpsRecordFromTransportSoak({
    runId: transportRunId,
    startedAt: transportStartedAt,
    completedAt: Date.now(),
    artifactPath: transportArtifactPath,
    result: transportResult,
  });
  await deps.validationOpsRunStore.put(transportRecord);
  records.push(transportRecord);
  stages.push({
    stageId: "transport-soak",
    title: "Relay/direct-cdp transport soak",
    status: transportResult.status,
    runId: transportRunId,
    durationMs: Date.now() - transportStartedAt,
    summary: `cycles=${transportResult.passedCycles}/${transportResult.totalCycles} targetRuns=${
      transportResult.totalTargetRuns - transportResult.failedTargetRuns
    }/${transportResult.totalTargetRuns}`,
    commandHint: `transport-soak ${input.transportCycles} relay direct-cdp`,
    artifactPath: transportArtifactPath,
  });

  const releaseStartedAt = Date.now();
  const releaseResult = await releaseReadinessRunner({
    skipBuild: input.releaseSkipBuild,
  });
  const releaseRunId = deps.createValidationOpsRunId("release-readiness");
  const releaseRecord = buildValidationOpsRecordFromReleaseReadiness({
    runId: releaseRunId,
    startedAt: releaseStartedAt,
    completedAt: Date.now(),
    result: releaseResult,
  });
  await deps.validationOpsRunStore.put(releaseRecord);
  records.push(releaseRecord);
  stages.push({
    stageId: "release-readiness",
    title: "Release readiness verification",
    status: releaseResult.status,
    runId: releaseRunId,
    durationMs: Date.now() - releaseStartedAt,
    summary: `checks=${releaseResult.passedChecks}/${releaseResult.totalChecks}`,
    commandHint: "release-verify",
  });

  const soakStartedAt = Date.now();
  const soakResult = await runValidationSoakSeries({
    cycles: input.soakCycles,
    selectors: [...PHASE1_READINESS_SOAK_SELECTORS],
  });
  const soakRunId = deps.createValidationOpsRunId("soak-series");
  const soakRecord = buildValidationOpsRecordFromSoakSeries({
    runId: soakRunId,
    startedAt: soakStartedAt,
    completedAt: Date.now(),
    selectors: soakResult.selectors,
    result: soakResult,
  });
  await deps.validationOpsRunStore.put(soakRecord);
  records.push(soakRecord);
  stages.push({
    stageId: "soak-series",
    title: "Acceptance/realworld/soak series",
    status: soakResult.status,
    runId: soakRunId,
    durationMs: Date.now() - soakStartedAt,
    summary: `cycles=${soakResult.passedCycles}/${soakResult.totalCycles} cases=${
      soakResult.totalCases - soakResult.failedCases
    }/${soakResult.totalCases}`,
    commandHint: `soak-series ${input.soakCycles} ${PHASE1_READINESS_SOAK_SELECTORS.join(" ")}`,
  });

  const storedRecords = await deps.validationOpsRunStore.list(50);
  const validationOps = buildValidationOpsReport(storedRecords.length > 0 ? storedRecords : records, 50);
  const northStar = validationOps.closedLoop;
  const completedAt = Date.now();
  const failedStages = stages.filter((stage) => stage.status === "failed").length;
  const nextCommand = northStar.closedLoopStatus !== "completed"
    ? northStar.nextCommand
    : validationOps.readiness.nextCommand;

  return {
    status: failedStages === 0 && validationOps.readiness.status === "passed" ? "passed" : "failed",
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    totalStages: stages.length,
    passedStages: stages.length - failedStages,
    failedStages,
    nextCommand,
    stages,
    validationOps,
    northStar,
  };
}

async function runPhase1Baseline(input: {
  deps: ValidationRouteDeps;
  runs: number;
  transportCycles: number;
  soakCycles: number;
  releaseSkipBuild: boolean;
}): Promise<Phase1BaselineRunResult> {
  const startedAt = Date.now();
  const runs: Phase1BaselineRunSummary[] = [];
  const failureReasons: string[] = [];

  for (let index = 0; index < input.runs; index += 1) {
    const result = await runPhase1Readiness({
      deps: input.deps,
      transportCycles: input.transportCycles,
      soakCycles: input.soakCycles,
      releaseSkipBuild: input.releaseSkipBuild,
    });
    const summary = summarizePhase1BaselineRun(index + 1, result);
    runs.push(summary);
    failureReasons.push(...validatePhase1BaselineRun(summary).map((reason) => `run ${summary.runNumber}: ${reason}`));
  }

  let records = await input.deps.validationOpsRunStore.list(50);
  let validationOps = buildValidationOpsReport(records, 50);
  failureReasons.push(
    ...validatePhase1BaselineValidationOps(validationOps).map((reason) => `final validation-ops: ${reason}`)
  );
  const completedAt = Date.now();
  const provisionalResult: Phase1BaselineRunResult = {
    status: failureReasons.length === 0 ? "passed" : "failed",
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    requiredRuns: input.runs,
    consecutivePassedRuns: countTrailingPhase1BaselineCleanRuns(runs),
    transportCycles: input.transportCycles,
    soakCycles: input.soakCycles,
    releaseSkipBuild: input.releaseSkipBuild,
    nextCommand:
      validationOps.closedLoop.closedLoopStatus !== "completed"
        ? validationOps.closedLoop.nextCommand
        : validationOps.readiness.nextCommand,
    runs,
    failureReasons,
    validationOps,
    northStar: validationOps.closedLoop,
    baseline: validationOps.baseline,
  };

  await input.deps.validationOpsRunStore.put(
    buildValidationOpsRecordFromPhase1Baseline({
      runId: input.deps.createValidationOpsRunId("phase1-baseline"),
      startedAt,
      completedAt,
      result: provisionalResult,
    })
  );
  records = await input.deps.validationOpsRunStore.list(50);
  validationOps = buildValidationOpsReport(records, 50);

  return {
    ...provisionalResult,
    nextCommand: validationOps.baseline.status === "fresh-passing" ? "validation-ops" : validationOps.baseline.nextCommand,
    validationOps,
    northStar: validationOps.closedLoop,
    baseline: validationOps.baseline,
  };
}

function filterNonEmptyStrings(values: string[] | undefined): string[] | undefined {
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : undefined;
}

function filterTrimmedStrings(values: string[] | undefined): string[] | undefined {
  return Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : undefined;
}

function findUnknownScenarioIds(inputIds: string[], validIds: string[]): string[] {
  const validScenarioIds = new Set(validIds);
  return inputIds.filter((scenarioId) => !validScenarioIds.has(scenarioId));
}

function summarizePhase1BaselineRun(runNumber: number, result: Phase1ReadinessRunResult): Phase1BaselineRunSummary {
  return {
    runNumber,
    status: result.status,
    durationMs: result.durationMs,
    failedStages: result.failedStages,
    nextCommand: result.nextCommand,
    readinessStatus: result.validationOps.readiness.status,
    northStarStatus: result.northStar.closedLoopStatus,
    closedLoopCases: result.northStar.closedLoopCases,
    totalCases: result.northStar.totalCases,
    closedLoopRate: result.northStar.closedLoopRate,
    silentFailureCases: result.northStar.silentFailureCases,
    ambiguousFailureCases: result.northStar.ambiguousFailureCases,
    stages: result.stages.map((stage) => ({
      stageId: stage.stageId,
      status: stage.status,
      summary: stage.summary,
      commandHint: stage.commandHint,
      ...(stage.artifactPath ? { artifactPath: stage.artifactPath } : {}),
    })),
  };
}

function validatePhase1BaselineRun(summary: Phase1BaselineRunSummary): string[] {
  const failures: string[] = [];
  if (summary.status !== "passed") {
    failures.push(`readiness status is ${summary.status}`);
  }
  if (summary.failedStages !== 0) {
    failures.push(`failed stages=${summary.failedStages}`);
  }
  if (summary.readinessStatus !== "passed") {
    failures.push(`readiness gate status is ${summary.readinessStatus}`);
  }
  if (summary.northStarStatus !== "completed") {
    failures.push(`north-star status is ${summary.northStarStatus}`);
  }
  if (summary.closedLoopRate !== 1) {
    failures.push(`closed-loop rate is ${summary.closedLoopRate.toFixed(3)}`);
  }
  if (summary.closedLoopCases !== summary.totalCases) {
    failures.push(`closed-loop cases=${summary.closedLoopCases}/${summary.totalCases}`);
  }
  if (summary.silentFailureCases !== 0) {
    failures.push(`silent failures=${summary.silentFailureCases}`);
  }
  if (summary.ambiguousFailureCases !== 0) {
    failures.push(`ambiguous failures=${summary.ambiguousFailureCases}`);
  }
  return failures;
}

function validatePhase1BaselineValidationOps(report: Phase1ReadinessRunResult["validationOps"]): string[] {
  const failures: string[] = [];
  if (report.readiness.status !== "passed") {
    failures.push(`readiness status is ${report.readiness.status}`);
  }
  if (report.closedLoop.closedLoopStatus !== "completed") {
    failures.push(`north-star status is ${report.closedLoop.closedLoopStatus}`);
  }
  if (report.closedLoop.closedLoopRate !== 1) {
    failures.push(`closed-loop rate is ${report.closedLoop.closedLoopRate.toFixed(3)}`);
  }
  if (report.closedLoop.closedLoopCases !== report.closedLoop.totalCases) {
    failures.push(`closed-loop cases=${report.closedLoop.closedLoopCases}/${report.closedLoop.totalCases}`);
  }
  if (report.closedLoop.silentFailureCases !== 0) {
    failures.push(`silent failures=${report.closedLoop.silentFailureCases}`);
  }
  if (report.closedLoop.ambiguousFailureCases !== 0) {
    failures.push(`ambiguous failures=${report.closedLoop.ambiguousFailureCases}`);
  }
  return failures;
}

function countTrailingPhase1BaselineCleanRuns(runs: Phase1BaselineRunSummary[]): number {
  let count = 0;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) {
      continue;
    }
    if (validatePhase1BaselineRun(run).length > 0) {
      break;
    }
    count += 1;
  }
  return count;
}
