import type { BrowserTaskResult } from "@turnkeyai/core-types/team";

import type { VerificationReport } from "./browser-step-verifier";
import { inspectBrowserExcerptSafety } from "./browser-excerpt-safety";

export class BrowserResultVerifier {
  verify(result: BrowserTaskResult): VerificationReport {
    const issues: string[] = [];

    if (!result.page.finalUrl) {
      issues.push("finalUrl is empty");
    }

    if (!result.page.title) {
      issues.push("page title is empty");
    }

    if (!result.page.textExcerpt) {
      issues.push("page excerpt is empty");
    } else {
      const excerptSafety = inspectBrowserExcerptSafety(result.page.textExcerpt);
      issues.push(...excerptSafety.issues);
    }

    if (result.trace.length === 0) {
      issues.push("trace is empty");
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }
}
