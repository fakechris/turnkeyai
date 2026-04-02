import type {
  BoundedRegressionCaseDescriptor,
  BoundedRegressionCaseResult,
} from "./bounded-regression-harness";
import {
  listBoundedRegressionCases,
  runBoundedRegressionSuite,
} from "./bounded-regression-harness";
import type {
  FailureInjectionScenarioDescriptor,
  FailureInjectionScenarioResult,
} from "./failure-injection-suite";
import {
  listFailureInjectionScenarios,
  runFailureInjectionSuite,
} from "./failure-injection-suite";
import type {
  SoakScenarioDescriptor,
  SoakScenarioResult,
} from "./soak-suite";
import {
  listSoakScenarios,
  runSoakSuite,
} from "./soak-suite";
import type {
  ScenarioParityAcceptanceScenarioDescriptor,
  ScenarioParityAcceptanceScenarioResult,
} from "./scenario-parity-acceptance";
import {
  listScenarioParityAcceptanceScenarios,
  runScenarioParityAcceptanceSuite,
} from "./scenario-parity-acceptance";
import type {
  RealWorldScenarioDescriptor,
  RealWorldScenarioResult,
} from "./real-world-suite";
import {
  listRealWorldScenarios,
  runRealWorldSuite,
} from "./real-world-suite";

export type ValidationSuiteId = "regression" | "soak" | "failure" | "acceptance" | "realworld";

export interface ValidationCatalogItemDescriptor {
  suiteId: ValidationSuiteId;
  itemId: string;
  area: string;
  title: string;
  summary: string;
  caseIds?: string[];
}

export interface ValidationSuiteDescriptor {
  suiteId: ValidationSuiteId;
  title: string;
  summary: string;
  totalItems: number;
  items: ValidationCatalogItemDescriptor[];
}

export interface ValidationRunItemResult {
  suiteId: ValidationSuiteId;
  itemId: string;
  area: string;
  title: string;
  summary: string;
  status: "passed" | "failed";
  totalCases: number;
  passedCases: number;
  failedCases: number;
  caseResults: BoundedRegressionCaseResult[];
}

export interface ValidationRunSuiteResult {
  suiteId: ValidationSuiteId;
  title: string;
  summary: string;
  totalItems: number;
  passedItems: number;
  failedItems: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  items: ValidationRunItemResult[];
}

export interface ValidationRunResult {
  totalSuites: number;
  passedSuites: number;
  failedSuites: number;
  totalItems: number;
  passedItems: number;
  failedItems: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  suites: ValidationRunSuiteResult[];
}

interface ValidationSelector {
  suiteId: ValidationSuiteId;
  itemId?: string;
}

export class ValidationSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationSelectorError";
  }
}

const SUITE_METADATA: Record<ValidationSuiteId, { title: string; summary: string }> = {
  regression: {
    title: "Bounded Regression",
    summary: "细粒度回归样本，覆盖 browser / recovery / context / parallel / governance / runtime 主线。",
  },
  soak: {
    title: "Stability Soak",
    summary: "按长链稳定性场景编排的验证套件，聚焦 browser / recovery / context 的跨面收敛。",
  },
  failure: {
    title: "Failure Injection",
    summary: "按失败场景编排的验证套件，检查 retry / fallback / approval / recovery 语义。",
  },
  acceptance: {
    title: "Scenario Parity Acceptance",
    summary: "按 operator-facing 场景编排的 acceptance 套件，验证主链体验与跨面一致性。",
  },
  realworld: {
    title: "Real-World Runbooks",
    summary: "按真实任务 runbook 编排的验证套件，聚焦 browser/recovery/context/operator 的同场景排障与收敛。",
  },
};

export function listValidationSuites(): ValidationSuiteDescriptor[] {
  const regressionItems = listBoundedRegressionCases().map(mapRegressionDescriptor);
  const soakItems = listSoakScenarios().map(mapSoakDescriptor);
  const failureItems = listFailureInjectionScenarios().map(mapFailureDescriptor);
  const acceptanceItems = listScenarioParityAcceptanceScenarios().map(mapAcceptanceDescriptor);
  const realWorldItems = listRealWorldScenarios().map(mapRealWorldDescriptor);

  return [
    buildSuiteDescriptor("regression", regressionItems),
    buildSuiteDescriptor("soak", soakItems),
    buildSuiteDescriptor("failure", failureItems),
    buildSuiteDescriptor("acceptance", acceptanceItems),
    buildSuiteDescriptor("realworld", realWorldItems),
  ];
}

export function runValidationSuites(selectors?: string[]): ValidationRunResult {
  const parsedSelectors = parseValidationSelectors(selectors);
  const suites = buildValidationSuiteRunResults(parsedSelectors);
  return {
    totalSuites: suites.length,
    passedSuites: suites.filter((suite) => suite.failedItems === 0).length,
    failedSuites: suites.filter((suite) => suite.failedItems > 0).length,
    totalItems: suites.reduce((sum, suite) => sum + suite.totalItems, 0),
    passedItems: suites.reduce((sum, suite) => sum + suite.passedItems, 0),
    failedItems: suites.reduce((sum, suite) => sum + suite.failedItems, 0),
    totalCases: suites.reduce((sum, suite) => sum + suite.totalCases, 0),
    passedCases: suites.reduce((sum, suite) => sum + suite.passedCases, 0),
    failedCases: suites.reduce((sum, suite) => sum + suite.failedCases, 0),
    suites,
  };
}

function buildValidationSuiteRunResults(selectors?: ValidationSelector[]): ValidationRunSuiteResult[] {
  const suiteIds = selectors?.length
    ? (["regression", "soak", "failure", "acceptance", "realworld"] as ValidationSuiteId[]).filter((suiteId) =>
        selectors.some((selector) => selector.suiteId === suiteId)
      )
    : (["regression", "soak", "failure", "acceptance", "realworld"] as ValidationSuiteId[]);

  return suiteIds.map((suiteId) => {
    const suiteSelectors = selectors?.filter((selector) => selector.suiteId === suiteId) ?? [];
    switch (suiteId) {
      case "regression":
        return buildRegressionSuiteRunResult(suiteSelectors);
      case "soak":
        return buildSoakSuiteRunResult(suiteSelectors);
      case "failure":
        return buildFailureSuiteRunResult(suiteSelectors);
      case "acceptance":
        return buildAcceptanceSuiteRunResult(suiteSelectors);
      case "realworld":
        return buildRealWorldSuiteRunResult(suiteSelectors);
    }
  });
}

function buildRegressionSuiteRunResult(selectors: ValidationSelector[]): ValidationRunSuiteResult {
  const allCases = listBoundedRegressionCases();
  const selectedCaseIds = resolveSelectedItemIds({
    selectors,
    validItemIds: allCases.map((item) => item.caseId),
    suiteLabel: "regression",
  });
  const result = runBoundedRegressionSuite(selectedCaseIds);
  const resultsById = new Map(result.results.map((item) => [item.caseId, item]));
  const descriptors = allCases
    .filter((item) => !selectedCaseIds || selectedCaseIds.includes(item.caseId))
    .map((item) => {
      const caseResult = resultsById.get(item.caseId);
      if (!caseResult) {
        throw new Error(`validation suite missing regression result: ${item.caseId}`);
      }
      return mapRegressionRunItem(caseResult);
    });
  return finalizeRunSuite("regression", descriptors);
}

function buildFailureSuiteRunResult(selectors: ValidationSelector[]): ValidationRunSuiteResult {
  const selectedScenarioIds = resolveSelectedItemIds({
    selectors,
    validItemIds: listFailureInjectionScenarios().map((item) => item.scenarioId),
    suiteLabel: "failure",
  });
  const result = runFailureInjectionSuite(selectedScenarioIds);
  return finalizeRunSuite("failure", result.scenarios.map(mapFailureRunItem));
}

function buildSoakSuiteRunResult(selectors: ValidationSelector[]): ValidationRunSuiteResult {
  const selectedScenarioIds = resolveSelectedItemIds({
    selectors,
    validItemIds: listSoakScenarios().map((item) => item.scenarioId),
    suiteLabel: "soak",
  });
  const result = runSoakSuite(selectedScenarioIds);
  return finalizeRunSuite("soak", result.scenarios.map(mapSoakRunItem));
}

function buildAcceptanceSuiteRunResult(selectors: ValidationSelector[]): ValidationRunSuiteResult {
  const selectedScenarioIds = resolveSelectedItemIds({
    selectors,
    validItemIds: listScenarioParityAcceptanceScenarios().map((item) => item.scenarioId),
    suiteLabel: "acceptance",
  });
  const result = runScenarioParityAcceptanceSuite(selectedScenarioIds);
  return finalizeRunSuite("acceptance", result.scenarios.map(mapAcceptanceRunItem));
}

function buildRealWorldSuiteRunResult(selectors: ValidationSelector[]): ValidationRunSuiteResult {
  const selectedScenarioIds = resolveSelectedItemIds({
    selectors,
    validItemIds: listRealWorldScenarios().map((item) => item.scenarioId),
    suiteLabel: "realworld",
  });
  const result = runRealWorldSuite(selectedScenarioIds);
  return finalizeRunSuite("realworld", result.scenarios.map(mapRealWorldRunItem));
}

function finalizeRunSuite(
  suiteId: ValidationSuiteId,
  items: ValidationRunItemResult[]
): ValidationRunSuiteResult {
  const metadata = SUITE_METADATA[suiteId];
  return {
    suiteId,
    title: metadata.title,
    summary: metadata.summary,
    totalItems: items.length,
    passedItems: items.filter((item) => item.status === "passed").length,
    failedItems: items.filter((item) => item.status === "failed").length,
    totalCases: items.reduce((sum, item) => sum + item.totalCases, 0),
    passedCases: items.reduce((sum, item) => sum + item.passedCases, 0),
    failedCases: items.reduce((sum, item) => sum + item.failedCases, 0),
    items,
  };
}

function parseValidationSelectors(selectors?: string[]): ValidationSelector[] | undefined {
  if (!selectors || selectors.length === 0) {
    return undefined;
  }

  const parsed: ValidationSelector[] = [];
  for (const rawSelector of selectors) {
    const selector = rawSelector.trim();
    if (!selector) {
      continue;
    }
    const [maybeSuiteId, ...itemParts] = selector.split(":");
    const rawSuiteId = maybeSuiteId ?? "";
    if (!isValidationSuiteId(rawSuiteId)) {
      throw new ValidationSelectorError(`unknown validation suite: ${rawSuiteId}`);
    }
    const itemId = itemParts.join(":").trim();
    parsed.push(itemId ? { suiteId: rawSuiteId, itemId } : { suiteId: rawSuiteId });
  }
  return parsed.length > 0 ? dedupeSelectors(parsed) : undefined;
}

function resolveSelectedItemIds(input: {
  selectors: ValidationSelector[];
  validItemIds: string[];
  suiteLabel: string;
}): string[] | undefined {
  if (input.selectors.length === 0) {
    return undefined;
  }

  if (input.selectors.some((selector) => !selector.itemId)) {
    return undefined;
  }

  const selectedItemIds = input.selectors.flatMap((selector) => (selector.itemId ? [selector.itemId] : []));
  const invalidItemIds = selectedItemIds.filter((itemId) => !input.validItemIds.includes(itemId));
  if (invalidItemIds.length > 0) {
    throw new ValidationSelectorError(
      `unknown ${input.suiteLabel} validation items: ${invalidItemIds.join(", ")}`
    );
  }

  return selectedItemIds;
}

function dedupeSelectors(selectors: ValidationSelector[]): ValidationSelector[] {
  const seen = new Set<string>();
  const deduped: ValidationSelector[] = [];
  for (const selector of selectors) {
    const key = `${selector.suiteId}:${selector.itemId ?? "*"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(selector);
  }
  return deduped;
}

function isValidationSuiteId(value: string): value is ValidationSuiteId {
  return value === "regression" || value === "soak" || value === "failure" || value === "acceptance" || value === "realworld";
}

function buildSuiteDescriptor(
  suiteId: ValidationSuiteId,
  items: ValidationCatalogItemDescriptor[]
): ValidationSuiteDescriptor {
  const metadata = SUITE_METADATA[suiteId];
  return {
    suiteId,
    title: metadata.title,
    summary: metadata.summary,
    totalItems: items.length,
    items,
  };
}

function mapRegressionDescriptor(descriptor: BoundedRegressionCaseDescriptor): ValidationCatalogItemDescriptor {
  return {
    suiteId: "regression",
    itemId: descriptor.caseId,
    area: descriptor.area,
    title: descriptor.title,
    summary: descriptor.summary,
  };
}

function mapFailureDescriptor(descriptor: FailureInjectionScenarioDescriptor): ValidationCatalogItemDescriptor {
  return {
    suiteId: "failure",
    itemId: descriptor.scenarioId,
    area: descriptor.area,
    title: descriptor.title,
    summary: descriptor.summary,
    caseIds: [...descriptor.caseIds],
  };
}

function mapSoakDescriptor(descriptor: SoakScenarioDescriptor): ValidationCatalogItemDescriptor {
  return {
    suiteId: "soak",
    itemId: descriptor.scenarioId,
    area: descriptor.area,
    title: descriptor.title,
    summary: descriptor.summary,
    caseIds: [...descriptor.caseIds],
  };
}

function mapAcceptanceDescriptor(
  descriptor: ScenarioParityAcceptanceScenarioDescriptor
): ValidationCatalogItemDescriptor {
  return {
    suiteId: "acceptance",
    itemId: descriptor.scenarioId,
    area: descriptor.area,
    title: descriptor.title,
    summary: descriptor.summary,
    caseIds: [...descriptor.caseIds],
  };
}

function mapRealWorldDescriptor(descriptor: RealWorldScenarioDescriptor): ValidationCatalogItemDescriptor {
  return {
    suiteId: "realworld",
    itemId: descriptor.scenarioId,
    area: descriptor.area,
    title: descriptor.title,
    summary: descriptor.summary,
    caseIds: [...descriptor.caseIds],
  };
}

function mapRegressionRunItem(result: BoundedRegressionCaseResult): ValidationRunItemResult {
  return {
    suiteId: "regression",
    itemId: result.caseId,
    area: result.area,
    title: result.title,
    summary: result.summary,
    status: result.status,
    totalCases: 1,
    passedCases: result.status === "passed" ? 1 : 0,
    failedCases: result.status === "failed" ? 1 : 0,
    caseResults: [result],
  };
}

function mapFailureRunItem(result: FailureInjectionScenarioResult): ValidationRunItemResult {
  return {
    suiteId: "failure",
    itemId: result.scenarioId,
    area: result.area,
    title: result.title,
    summary: result.summary,
    status: result.status,
    totalCases: result.totalCases,
    passedCases: result.passedCases,
    failedCases: result.failedCases,
    caseResults: result.caseResults,
  };
}

function mapSoakRunItem(result: SoakScenarioResult): ValidationRunItemResult {
  return {
    suiteId: "soak",
    itemId: result.scenarioId,
    area: result.area,
    title: result.title,
    summary: result.summary,
    status: result.status,
    totalCases: result.totalCases,
    passedCases: result.passedCases,
    failedCases: result.failedCases,
    caseResults: result.caseResults,
  };
}

function mapAcceptanceRunItem(result: ScenarioParityAcceptanceScenarioResult): ValidationRunItemResult {
  return {
    suiteId: "acceptance",
    itemId: result.scenarioId,
    area: result.area,
    title: result.title,
    summary: result.summary,
    status: result.status,
    totalCases: result.totalCases,
    passedCases: result.passedCases,
    failedCases: result.failedCases,
    caseResults: result.caseResults,
  };
}

function mapRealWorldRunItem(result: RealWorldScenarioResult): ValidationRunItemResult {
  return {
    suiteId: "realworld",
    itemId: result.scenarioId,
    area: result.area,
    title: result.title,
    summary: result.summary,
    status: result.status,
    totalCases: result.totalCases,
    passedCases: result.passedCases,
    failedCases: result.failedCases,
    caseResults: result.caseResults,
  };
}
