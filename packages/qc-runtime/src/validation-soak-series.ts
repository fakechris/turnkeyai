import type { ValidationSuiteId } from "./validation-suite";
import type { ValidationOpsClosedLoopMetric } from "@turnkeyai/core-types/team";

import { runValidationSuites } from "./validation-suite";
import { mergeClosedLoopMetrics } from "./closed-loop-metrics";

export const DEFAULT_VALIDATION_SOAK_SELECTORS = ["soak", "realworld", "acceptance"] as const;

export interface ValidationSoakSeriesCycleSuiteResult {
  suiteId: ValidationSuiteId;
  status: "passed" | "failed";
  totalItems: number;
  failedItems: number;
  totalCases: number;
  failedCases: number;
  closedLoop?: ValidationOpsClosedLoopMetric;
}

export interface ValidationSoakSeriesCycleResult {
  cycleNumber: number;
  status: "passed" | "failed";
  durationMs: number;
  totalSuites: number;
  failedSuites: number;
  totalItems: number;
  failedItems: number;
  totalCases: number;
  failedCases: number;
  closedLoop?: ValidationOpsClosedLoopMetric;
  suites: ValidationSoakSeriesCycleSuiteResult[];
}

export interface ValidationSoakSeriesSuiteAggregate {
  suiteId: ValidationSuiteId;
  cycles: number;
  failedCycles: number;
  totalItems: number;
  failedItems: number;
  totalCases: number;
  failedCases: number;
  closedLoop?: ValidationOpsClosedLoopMetric;
}

export interface ValidationSoakSeriesResult {
  status: "passed" | "failed";
  selectors: string[];
  totalCycles: number;
  passedCycles: number;
  failedCycles: number;
  totalSuites: number;
  failedSuites: number;
  totalItems: number;
  failedItems: number;
  totalCases: number;
  failedCases: number;
  durationMs: number;
  closedLoop?: ValidationOpsClosedLoopMetric;
  cycles: ValidationSoakSeriesCycleResult[];
  suiteAggregates: ValidationSoakSeriesSuiteAggregate[];
}

export interface ValidationSoakSeriesOptions {
  cycles?: number;
  selectors?: string[];
}

export function runValidationSoakSeries(
  options: ValidationSoakSeriesOptions = {}
): ValidationSoakSeriesResult {
  const selectedCycles = normalizeCycleCount(options.cycles);
  const normalizedSelectors = options.selectors?.map((selector) => selector.trim()).filter((selector) => selector.length > 0) ?? [];
  const selectors = normalizedSelectors.length > 0 ? normalizedSelectors : [...DEFAULT_VALIDATION_SOAK_SELECTORS];
  const startedAt = Date.now();
  const cycleResults: ValidationSoakSeriesCycleResult[] = [];

  for (let cycleNumber = 1; cycleNumber <= selectedCycles; cycleNumber += 1) {
    const cycleStartedAt = Date.now();
    const run = runValidationSuites(selectors);
    const suiteResults = run.suites.map((suite) => ({
      suiteId: suite.suiteId,
      status: suite.failedItems === 0 ? "passed" as const : "failed" as const,
      totalItems: suite.totalItems,
      failedItems: suite.failedItems,
      totalCases: suite.totalCases,
      failedCases: suite.failedCases,
      ...(suite.closedLoop ? { closedLoop: suite.closedLoop } : {}),
    }));
    cycleResults.push({
      cycleNumber,
      status: run.failedSuites === 0 ? "passed" : "failed",
      durationMs: Date.now() - cycleStartedAt,
      totalSuites: run.totalSuites,
      failedSuites: run.failedSuites,
      totalItems: run.totalItems,
      failedItems: run.failedItems,
      totalCases: run.totalCases,
      failedCases: run.failedCases,
      ...(run.closedLoop ? { closedLoop: run.closedLoop } : {}),
      suites: suiteResults,
    });
  }

  const suiteAggregateMap = new Map<ValidationSuiteId, ValidationSoakSeriesSuiteAggregate>();
  const suiteClosedLoopMetrics = new Map<ValidationSuiteId, ValidationOpsClosedLoopMetric[]>();
  for (const cycle of cycleResults) {
    for (const suite of cycle.suites) {
      const aggregate = suiteAggregateMap.get(suite.suiteId) ?? {
        suiteId: suite.suiteId,
        cycles: 0,
        failedCycles: 0,
        totalItems: 0,
        failedItems: 0,
        totalCases: 0,
        failedCases: 0,
      };
      aggregate.cycles += 1;
      aggregate.failedCycles += suite.status === "failed" ? 1 : 0;
      aggregate.totalItems += suite.totalItems;
      aggregate.failedItems += suite.failedItems;
      aggregate.totalCases += suite.totalCases;
      aggregate.failedCases += suite.failedCases;
      suiteAggregateMap.set(suite.suiteId, aggregate);
      if (suite.closedLoop) {
        const metrics = suiteClosedLoopMetrics.get(suite.suiteId) ?? [];
        metrics.push(suite.closedLoop);
        suiteClosedLoopMetrics.set(suite.suiteId, metrics);
      }
    }
  }
  const command = `soak-series ${cycleResults.length} ${selectors.join(" ")}`.trim();
  const suiteAggregates = [...suiteAggregateMap.values()].map((aggregate) => {
    const closedLoop = mergeClosedLoopMetrics(
      suiteClosedLoopMetrics.get(aggregate.suiteId) ?? [],
      command
    );
    return {
      ...aggregate,
      ...(closedLoop ? { closedLoop } : {}),
    };
  });
  const closedLoop = mergeClosedLoopMetrics(cycleResults.map((cycle) => cycle.closedLoop), command);

  return {
    status: cycleResults.every((cycle) => cycle.status === "passed") ? "passed" : "failed",
    selectors,
    totalCycles: cycleResults.length,
    passedCycles: cycleResults.filter((cycle) => cycle.status === "passed").length,
    failedCycles: cycleResults.filter((cycle) => cycle.status === "failed").length,
    totalSuites: cycleResults.reduce((sum, cycle) => sum + cycle.totalSuites, 0),
    failedSuites: cycleResults.reduce((sum, cycle) => sum + cycle.failedSuites, 0),
    totalItems: cycleResults.reduce((sum, cycle) => sum + cycle.totalItems, 0),
    failedItems: cycleResults.reduce((sum, cycle) => sum + cycle.failedItems, 0),
    totalCases: cycleResults.reduce((sum, cycle) => sum + cycle.totalCases, 0),
    failedCases: cycleResults.reduce((sum, cycle) => sum + cycle.failedCases, 0),
    durationMs: Date.now() - startedAt,
    ...(closedLoop ? { closedLoop } : {}),
    cycles: cycleResults,
    suiteAggregates,
  };
}

function normalizeCycleCount(value?: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.max(1, Math.floor(value!));
}
