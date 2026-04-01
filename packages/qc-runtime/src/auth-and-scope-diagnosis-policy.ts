import type { ApiDiagnosisReport, ApiExecutionAttempt, AuthAndScopeDiagnosisPolicy } from "@turnkeyai/core-types/team";

export class DefaultAuthAndScopeDiagnosisPolicy implements AuthAndScopeDiagnosisPolicy {
  diagnose(input: ApiExecutionAttempt): ApiDiagnosisReport | null {
    const issues: string[] = [];
    const suggestedActions: string[] = [];

    if (input.credentialState === "missing") {
      issues.push(`${input.apiName} credentials are missing`);
      suggestedActions.push(`configure credentials for ${input.apiName}`);
      return buildReport("credential", false, issues, suggestedActions);
    }

    if (
      input.credentialState === "invalid" ||
      input.statusCode === 401 ||
      /invalid api key|invalid access token|unrecognized login|wrong password|unauthorized/i.test(input.errorMessage ?? "")
    ) {
      issues.push(`${input.apiName} credentials are invalid`);
      suggestedActions.push(`refresh or replace credentials for ${input.apiName}`);
      return buildReport("credential", false, issues, suggestedActions);
    }

    const missingScopes = (input.requiredScopes ?? []).filter(
      (scope) => !(input.grantedScopes ?? []).includes(scope)
    );
    const scopeLikeError =
      /access denied|missing scope|scope/i.test(input.errorMessage ?? "") ||
      /scope|access denied/i.test(safeSerialize(input.responseBody));
    if (missingScopes.length > 0 || scopeLikeError) {
      issues.push(
        missingScopes.length > 0
          ? `missing scopes: ${missingScopes.join(", ")}`
          : `${input.apiName} rejected the request due to permissions`
      );
      suggestedActions.push(`grant required scopes for ${input.apiName}`);
      return buildReport("scope", false, issues, suggestedActions);
    }

    return null;
  }
}

function safeSerialize(value: unknown): string {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function buildReport(
  category: ApiDiagnosisReport["category"],
  retryable: boolean,
  issues: string[],
  suggestedActions: string[]
): ApiDiagnosisReport {
  return {
    ok: false,
    category,
    retryable,
    issues,
    suggestedActions,
  };
}
