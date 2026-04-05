import type http from "node:http";

import type { ValidationOpsRunStore } from "@turnkeyai/core-types/team";
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
} from "@turnkeyai/qc-runtime/validation-profile";
import {
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

import { readJsonBody, sendJson } from "../http-helpers";

export interface ValidationRouteDeps {
  validationOpsRunStore: ValidationOpsRunStore;
  createValidationOpsRunId: (
    kind: "release-readiness" | "validation-profile" | "soak-series" | "transport-soak"
  ) => string;
  writeValidationArtifact: (kind: string, runId: string, payload: unknown) => Promise<string>;
  runBrowserTransportSoakViaCli: (options?: BrowserTransportSoakOptions) => Promise<BrowserTransportSoakResult>;
}

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
    const body = await readJsonBody<{ caseIds?: string[] }>(req);
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
    const body = await readJsonBody<{ scenarioIds?: string[] }>(req);
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
    const body = await readJsonBody<{ scenarioIds?: string[] }>(req);
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
    const body = await readJsonBody<{ scenarioIds?: string[] }>(req);
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
    const body = await readJsonBody<{ scenarioIds?: string[] }>(req);
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
    const body = await readJsonBody<{ selectors?: string[] }>(req);
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
    const records = await deps.validationOpsRunStore.list(limit);
    sendJson(res, 200, buildValidationOpsReport(records, limit));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/validation-profiles/run") {
    const body = await readJsonBody<{ profileId?: string }>(req);
    const profileId = typeof body.profileId === "string" ? body.profileId.trim() : undefined;
    if (!profileId || !isValidationProfileId(profileId)) {
      sendJson(res, 400, { error: "Unknown validation profile" });
      return true;
    }
    const startedAt = Date.now();
    const result = await runValidationProfile(profileId, {}, {
      releaseReadinessRunner: runReleaseReadiness,
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
    const body = await readJsonBody<{ cycles?: number; selectors?: string[] }>(req);
    const selectors = filterTrimmedStrings(body.selectors);
    if (body.cycles !== undefined && (!Number.isInteger(body.cycles) || body.cycles <= 0)) {
      sendJson(res, 400, { error: "Invalid cycles: must be a positive integer" });
      return true;
    }
    const cycles = body.cycles !== undefined ? Number(body.cycles) : undefined;
    try {
      const startedAt = Date.now();
      const result = runValidationSoakSeries({
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
    const body = await readJsonBody<{
      cycles?: number;
      timeoutMs?: number;
      relayPeerCount?: number;
      verifyReconnect?: boolean;
      verifyWorkflowLog?: boolean;
      targets?: string[];
    }>(req);
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
    const result = await runReleaseReadiness();
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

  return false;
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
