import type {
  ReleaseReadinessOptions,
  ReleaseReadinessResult,
} from "./release-readiness";
import type {
  BrowserTransportSoakOptions,
  BrowserTransportSoakResult,
  BrowserTransportSoakTarget,
} from "./browser-transport-soak";
import type {
  ValidationSuiteId,
  ValidationRunResult,
} from "./validation-suite";
import type {
  ValidationSoakSeriesOptions,
  ValidationSoakSeriesResult,
} from "./validation-soak-series";

export type ValidationProfileId = "smoke" | "nightly" | "prerelease" | "weekly";
export type ValidationProfileStageId =
  | "validation-run"
  | "release-readiness"
  | "soak-series"
  | "transport-soak";
export type ValidationProfileIssueKind =
  | "validation-item"
  | "release-check"
  | "soak-suite"
  | "transport-target";

export interface ValidationProfileDescriptor {
  profileId: ValidationProfileId;
  title: string;
  summary: string;
  focusAreas: string[];
  validationSelectors: string[];
  includeReleaseReadiness: boolean;
  soakSeriesCycles?: number;
  soakSeriesSelectors?: string[];
  transportSoakCycles?: number;
  transportSoakTargets?: BrowserTransportSoakTarget[];
}

export interface ValidationProfileIssue {
  issueId: string;
  kind: ValidationProfileIssueKind;
  stageId: ValidationProfileStageId;
  scope: string;
  summary: string;
}

export interface ValidationProfileValidationStageResult {
  stageId: "validation-run";
  title: string;
  status: "passed" | "failed";
  durationMs: number;
  selectors: string[];
  result: ValidationRunResult;
}

export interface ValidationProfileReleaseStageResult {
  stageId: "release-readiness";
  title: string;
  status: "passed" | "failed";
  durationMs: number;
  result: ReleaseReadinessResult;
}

export interface ValidationProfileSoakStageResult {
  stageId: "soak-series";
  title: string;
  status: "passed" | "failed";
  durationMs: number;
  cycles: number;
  selectors: string[];
  result: ValidationSoakSeriesResult;
}

export interface ValidationProfileTransportSoakStageResult {
  stageId: "transport-soak";
  title: string;
  status: "passed" | "failed";
  durationMs: number;
  cycles: number;
  targets: BrowserTransportSoakTarget[];
  result: BrowserTransportSoakResult;
}

export type ValidationProfileStageResult =
  | ValidationProfileValidationStageResult
  | ValidationProfileReleaseStageResult
  | ValidationProfileSoakStageResult
  | ValidationProfileTransportSoakStageResult;

export interface ValidationProfileRunResult extends ValidationProfileDescriptor {
  status: "passed" | "failed";
  durationMs: number;
  totalStages: number;
  passedStages: number;
  failedStages: number;
  stages: ValidationProfileStageResult[];
  issues: ValidationProfileIssue[];
}

export interface ValidationProfileRunOptions {
  releaseReadiness?: ReleaseReadinessOptions;
  soakSeries?: Omit<ValidationSoakSeriesOptions, "cycles" | "selectors">;
  transportSoak?: Omit<BrowserTransportSoakOptions, "cycles" | "targets">;
}

interface ValidationProfileDeps {
  releaseReadinessRunner: (options?: ReleaseReadinessOptions) => Promise<ReleaseReadinessResult>;
  validationRunner: (selectors?: string[]) => ValidationRunResult;
  transportSoakRunner: (options: BrowserTransportSoakOptions) => Promise<BrowserTransportSoakResult>;
}

const DEFAULT_SOAK_PROFILE_SELECTORS = ["soak", "realworld", "acceptance"] as const;
const DEFAULT_TRANSPORT_SOAK_TARGETS: BrowserTransportSoakTarget[] = ["relay", "direct-cdp"];
const VALIDATION_SUITE_ORDER: ValidationSuiteId[] = [
  "regression",
  "soak",
  "failure",
  "acceptance",
  "realworld",
];

const PROFILE_DESCRIPTORS: Record<ValidationProfileId, ValidationProfileDescriptor> = {
  smoke: {
    profileId: "smoke",
    title: "Smoke Hardening",
    summary:
      "快速覆盖 local/browser/runtime/governance 主链，适合本地开发后的第一轮稳定性检查。",
    focusAreas: ["local", "browser", "runtime", "governance", "realworld"],
    validationSelectors: [
      "regression:browser-recovery-cold-reopen-outcome",
      "regression:runtime-prompt-console-summarizes-boundaries",
      "regression:governance-publish-readback-verifies-closure",
      "acceptance:browser-ownership-reclaim-isolation",
      "realworld:browser-research-recovery-runbook",
      "realworld:governed-publish-readback-verification",
    ],
    includeReleaseReadiness: false,
  },
  nightly: {
    profileId: "nightly",
    title: "Nightly Hardening",
    summary:
      "每天固定覆盖 acceptance / realworld / soak / failure，并附带 release readiness 与短周期 soak。",
    focusAreas: ["browser", "runtime", "release", "acceptance", "soak", "failure"],
    validationSelectors: ["failure", "acceptance", "realworld", "soak"],
    includeReleaseReadiness: true,
    soakSeriesCycles: 3,
    soakSeriesSelectors: [...DEFAULT_SOAK_PROFILE_SELECTORS],
    transportSoakCycles: 1,
    transportSoakTargets: [...DEFAULT_TRANSPORT_SOAK_TARGETS],
  },
  prerelease: {
    profileId: "prerelease",
    title: "Pre-Release Confidence",
    summary:
      "发版前的高置信度验证，覆盖 full regression/failure/acceptance/realworld/soak，并执行 release readiness 与中等强度 soak。",
    focusAreas: ["local", "browser", "runtime", "release", "acceptance", "soak", "failure"],
    validationSelectors: ["regression", "failure", "acceptance", "realworld", "soak"],
    includeReleaseReadiness: true,
    soakSeriesCycles: 5,
    soakSeriesSelectors: [...DEFAULT_SOAK_PROFILE_SELECTORS],
    transportSoakCycles: 2,
    transportSoakTargets: [...DEFAULT_TRANSPORT_SOAK_TARGETS],
  },
  weekly: {
    profileId: "weekly",
    title: "Weekly Stability Sweep",
    summary:
      "每周全量稳定性扫面，覆盖 full validation catalog、release readiness 与更长周期 soak。",
    focusAreas: ["local", "browser", "runtime", "release", "acceptance", "soak", "failure", "regression"],
    validationSelectors: ["regression", "failure", "acceptance", "realworld", "soak"],
    includeReleaseReadiness: true,
    soakSeriesCycles: 10,
    soakSeriesSelectors: [...DEFAULT_SOAK_PROFILE_SELECTORS],
    transportSoakCycles: 3,
    transportSoakTargets: [...DEFAULT_TRANSPORT_SOAK_TARGETS],
  },
};

export function listValidationProfiles(): ValidationProfileDescriptor[] {
  return (["smoke", "nightly", "prerelease", "weekly"] as ValidationProfileId[]).map((profileId) => ({
    ...PROFILE_DESCRIPTORS[profileId],
    focusAreas: [...PROFILE_DESCRIPTORS[profileId].focusAreas],
    validationSelectors: [...PROFILE_DESCRIPTORS[profileId].validationSelectors],
    ...(PROFILE_DESCRIPTORS[profileId].soakSeriesSelectors
      ? { soakSeriesSelectors: [...PROFILE_DESCRIPTORS[profileId].soakSeriesSelectors] }
      : {}),
    ...(PROFILE_DESCRIPTORS[profileId].transportSoakTargets
      ? { transportSoakTargets: [...PROFILE_DESCRIPTORS[profileId].transportSoakTargets] }
      : {}),
  }));
}

export function isValidationProfileId(value: string): value is ValidationProfileId {
  return Object.prototype.hasOwnProperty.call(PROFILE_DESCRIPTORS, value);
}

export async function runValidationProfile(
  profileId: ValidationProfileId,
  options: ValidationProfileRunOptions = {},
  deps: ValidationProfileDeps
): Promise<ValidationProfileRunResult> {
  const profile = PROFILE_DESCRIPTORS[profileId];
  const startedAt = Date.now();
  const stages: ValidationProfileStageResult[] = [];

  const validationStartedAt = Date.now();
  const validationResult = await runValidationSuitesNonBlocking({
    validationRunner: deps.validationRunner,
    selectors: profile.validationSelectors,
  });
  stages.push({
    stageId: "validation-run",
    title: "Validation catalog run",
    status: validationResult.failedSuites === 0 ? "passed" : "failed",
    durationMs: Date.now() - validationStartedAt,
    selectors: [...profile.validationSelectors],
    result: validationResult,
  });

  if (profile.includeReleaseReadiness) {
    const releaseStartedAt = Date.now();
    const releaseResult = await deps.releaseReadinessRunner(options.releaseReadiness);
    stages.push({
      stageId: "release-readiness",
      title: "Release readiness verification",
      status: releaseResult.status,
      durationMs: Date.now() - releaseStartedAt,
      result: releaseResult,
    });
  }

  if (profile.soakSeriesCycles && profile.soakSeriesCycles > 0) {
    const soakStartedAt = Date.now();
    const soakSelectors = profile.soakSeriesSelectors ?? [...DEFAULT_SOAK_PROFILE_SELECTORS];
    const soakResult = await runValidationSoakSeriesNonBlocking({
      validationRunner: deps.validationRunner,
      ...options.soakSeries,
      cycles: profile.soakSeriesCycles,
      selectors: soakSelectors,
    });
    stages.push({
      stageId: "soak-series",
      title: "Validation soak series",
      status: soakResult.status,
      durationMs: Date.now() - soakStartedAt,
      cycles: profile.soakSeriesCycles,
      selectors: [...soakSelectors],
      result: soakResult,
    });
  }

  if (profile.transportSoakCycles && profile.transportSoakCycles > 0) {
    const transportStartedAt = Date.now();
    const transportTargets = profile.transportSoakTargets ?? [...DEFAULT_TRANSPORT_SOAK_TARGETS];
    const transportResult = await deps.transportSoakRunner({
      ...options.transportSoak,
      cycles: profile.transportSoakCycles,
      targets: transportTargets,
    });
    stages.push({
      stageId: "transport-soak",
      title: "Browser transport soak",
      status: transportResult.status,
      durationMs: Date.now() - transportStartedAt,
      cycles: profile.transportSoakCycles,
      targets: [...transportTargets],
      result: transportResult,
    });
  }

  const issues = collectProfileIssues(stages);
  return {
    ...profile,
    focusAreas: [...profile.focusAreas],
    validationSelectors: [...profile.validationSelectors],
    ...(profile.soakSeriesSelectors ? { soakSeriesSelectors: [...profile.soakSeriesSelectors] } : {}),
    ...(profile.transportSoakTargets ? { transportSoakTargets: [...profile.transportSoakTargets] } : {}),
    status: stages.every((stage) => stage.status === "passed") ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    totalStages: stages.length,
    passedStages: stages.filter((stage) => stage.status === "passed").length,
    failedStages: stages.filter((stage) => stage.status === "failed").length,
    stages,
    issues,
  };
}

function collectProfileIssues(stages: ValidationProfileStageResult[]): ValidationProfileIssue[] {
  const issues: ValidationProfileIssue[] = [];

  for (const stage of stages) {
    if (stage.stageId === "validation-run") {
      for (const suite of stage.result.suites) {
        for (const item of suite.items) {
          if (item.status === "passed") {
            continue;
          }
          issues.push({
            issueId: `${stage.stageId}:${suite.suiteId}:${item.itemId}`,
            kind: "validation-item",
            stageId: stage.stageId,
            scope: `${suite.suiteId}:${item.itemId}`,
            summary: `[${item.area}] ${item.title} failed ${item.failedCases}/${item.totalCases} cases`,
          });
        }
      }
      continue;
    }

    if (stage.stageId === "release-readiness") {
      for (const check of stage.result.checks) {
        if (check.status === "passed") {
          continue;
        }
        issues.push({
          issueId: `${stage.stageId}:${check.checkId}`,
          kind: "release-check",
          stageId: stage.stageId,
          scope: check.checkId,
          summary: `${check.title} failed`,
        });
      }
      continue;
    }

    if (stage.stageId === "soak-series") {
      for (const aggregate of stage.result.suiteAggregates) {
        if (aggregate.failedCycles === 0) {
          continue;
        }
        issues.push({
          issueId: `${stage.stageId}:${aggregate.suiteId}`,
          kind: "soak-suite",
          stageId: stage.stageId,
          scope: aggregate.suiteId,
          summary: `${aggregate.suiteId} failed ${aggregate.failedCycles}/${aggregate.cycles} soak cycles`,
        });
      }
      continue;
    }

    for (const aggregate of stage.result.targetAggregates) {
      if (aggregate.failedCycles === 0) {
        continue;
      }
      issues.push({
        issueId: `${stage.stageId}:${aggregate.target}`,
        kind: "transport-target",
        stageId: stage.stageId,
        scope: aggregate.target,
        summary: `${aggregate.target} failed ${aggregate.failedCycles}/${aggregate.cycles} transport soak cycles`,
      });
    }
  }

  return issues;
}

async function runValidationSoakSeriesNonBlocking(
  options: ValidationSoakSeriesOptions & {
    validationRunner: (selectors?: string[]) => ValidationRunResult;
  }
): Promise<ValidationSoakSeriesResult> {
  const selectedCycles = normalizeCycleCount(options.cycles);
  const normalizedSelectors = normalizeSelectors(options.selectors);
  const selectors = normalizedSelectors.length > 0 ? normalizedSelectors : [...DEFAULT_SOAK_PROFILE_SELECTORS];
  const startedAt = Date.now();
  const cycleResults: ValidationSoakSeriesResult["cycles"] = [];

  for (let cycleNumber = 1; cycleNumber <= selectedCycles; cycleNumber += 1) {
    await yieldToEventLoop();
    const cycleStartedAt = Date.now();
    const run = await runValidationSuitesNonBlocking({
      validationRunner: options.validationRunner,
      selectors,
    });
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
      suites: run.suites.map((suite) => ({
        suiteId: suite.suiteId,
        status: suite.failedItems === 0 ? "passed" : "failed",
        totalItems: suite.totalItems,
        failedItems: suite.failedItems,
        totalCases: suite.totalCases,
        failedCases: suite.failedCases,
      })),
    });
  }

  const suiteAggregateMap = new Map<ValidationSuiteId, ValidationSoakSeriesResult["suiteAggregates"][number]>();
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
    }
  }

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
    cycles: cycleResults,
    suiteAggregates: [...suiteAggregateMap.values()],
  };
}

async function runValidationSuitesNonBlocking(options: {
  selectors?: string[];
  validationRunner: (selectors?: string[]) => ValidationRunResult;
}): Promise<ValidationRunResult> {
  const selectors = normalizeSelectors(options.selectors);
  const selectorGroups = selectors.length > 0
    ? buildSuiteScopedSelectors(selectors)
    : VALIDATION_SUITE_ORDER.map((suiteId) => ({ suiteId, selectors: [suiteId] }));
  const suiteRuns: ValidationRunResult[] = [];

  for (const group of selectorGroups) {
    await yieldToEventLoop();
    suiteRuns.push(options.validationRunner(group.selectors));
  }

  const suites = suiteRuns.flatMap((run) => run.suites);
  return {
    totalSuites: suites.length,
    passedSuites: suites.filter((suite) => suite.failedItems === 0).length,
    failedSuites: suites.filter((suite) => suite.failedItems > 0).length,
    totalItems: suites.reduce((sum, suite) => sum + suite.totalItems, 0),
    passedItems: suites.reduce((sum, suite) => sum + (suite.totalItems - suite.failedItems), 0),
    failedItems: suites.reduce((sum, suite) => sum + suite.failedItems, 0),
    totalCases: suites.reduce((sum, suite) => sum + suite.totalCases, 0),
    passedCases: suites.reduce((sum, suite) => sum + (suite.totalCases - suite.failedCases), 0),
    failedCases: suites.reduce((sum, suite) => sum + suite.failedCases, 0),
    suites,
  };
}

function buildSuiteScopedSelectors(
  selectors: string[]
): Array<{ suiteId: ValidationSuiteId; selectors: string[] }> {
  const groups = new Map<ValidationSuiteId, string[]>();

  for (const selector of selectors) {
    const suiteId = getValidationSelectorSuiteId(selector);
    if (!suiteId) {
      continue;
    }
    const entries = groups.get(suiteId);
    if (!entries) {
      groups.set(suiteId, [selector]);
      continue;
    }
    entries.push(selector);
  }

  return [...groups.keys()].map((suiteId) => ({
      suiteId,
      selectors: groups.get(suiteId)!,
    }));
}

function getValidationSelectorSuiteId(selector: string): ValidationSuiteId | undefined {
  const [prefix] = selector.split(":", 1);
  return VALIDATION_SUITE_ORDER.find((suiteId) => suiteId === prefix);
}

function normalizeSelectors(selectors?: string[]): string[] {
  return selectors?.map((selector) => selector.trim()).filter((selector) => selector.length > 0) ?? [];
}

function normalizeCycleCount(value?: number): number {
  if (!Number.isFinite(value)) {
    return 5;
  }
  return Math.max(1, Math.floor(value!));
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function summarizeValidationStage(
  stage: ValidationProfileStageResult
): string {
  if (stage.stageId === "validation-run") {
    return `suites=${stage.result.passedSuites}/${stage.result.totalSuites} items=${stage.result.passedItems}/${stage.result.totalItems} cases=${stage.result.passedCases}/${stage.result.totalCases}`;
  }
  if (stage.stageId === "release-readiness") {
    return `checks=${stage.result.passedChecks}/${stage.result.totalChecks}`;
  }
  if (stage.stageId === "soak-series") {
    return `cycles=${stage.result.passedCycles}/${stage.result.totalCycles} cases=${stage.result.totalCases - stage.result.failedCases}/${stage.result.totalCases}`;
  }
  return `cycles=${stage.result.passedCycles}/${stage.result.totalCycles} targetRuns=${stage.result.totalTargetRuns - stage.result.failedTargetRuns}/${stage.result.totalTargetRuns}`;
}

export function summarizeValidationProfileResult(
  result: ValidationProfileRunResult
): string {
  return `stages=${result.passedStages}/${result.totalStages} issues=${result.issues.length} durationMs=${result.durationMs}`;
}

export function getValidationProfile(profileId: ValidationProfileId): ValidationProfileDescriptor {
  const descriptor = PROFILE_DESCRIPTORS[profileId];
  return {
    ...descriptor,
    focusAreas: [...descriptor.focusAreas],
    validationSelectors: [...descriptor.validationSelectors],
    ...(descriptor.soakSeriesSelectors ? { soakSeriesSelectors: [...descriptor.soakSeriesSelectors] } : {}),
    ...(descriptor.transportSoakTargets ? { transportSoakTargets: [...descriptor.transportSoakTargets] } : {}),
  };
}
