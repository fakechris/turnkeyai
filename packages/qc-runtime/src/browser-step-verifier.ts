import type { BrowserActionTrace, BrowserTaskRequest } from "@turnkeyai/core-types/team";

export interface VerificationReport {
  ok: boolean;
  issues: string[];
}

export class BrowserStepVerifier {
  verify(input: { request: BrowserTaskRequest; trace: BrowserActionTrace[] }): VerificationReport {
    const issues: string[] = [];

    if (input.trace.length === 0) {
      issues.push("browser trace is empty");
    }

    const failedSteps = input.trace.filter((step) => step.status === "failed");
    for (const step of failedSteps) {
      issues.push(`step failed: ${step.kind}${step.errorMessage ? ` (${step.errorMessage})` : ""}`);
    }

    const requestedKinds = new Set(input.request.actions.map((action) => action.kind));
    for (const kind of requestedKinds) {
      if (!input.trace.some((step) => step.kind === kind)) {
        issues.push(`missing executed step for requested action: ${kind}`);
      }
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }
}
