import type {
  ApiDiagnosisReport,
  ApiExecutionAttempt,
  ApiExecutionVerifier,
  AuthAndScopeDiagnosisPolicy,
} from "@turnkeyai/core-types/team";

import { DefaultAuthAndScopeDiagnosisPolicy } from "./auth-and-scope-diagnosis-policy";

export class DefaultApiExecutionVerifier implements ApiExecutionVerifier {
  private readonly authPolicy: AuthAndScopeDiagnosisPolicy;

  constructor(options?: { authPolicy?: AuthAndScopeDiagnosisPolicy }) {
    this.authPolicy = options?.authPolicy ?? new DefaultAuthAndScopeDiagnosisPolicy();
  }

  verify(input: ApiExecutionAttempt): ApiDiagnosisReport {
    const authDiagnosis = this.authPolicy.diagnose(input);
    if (authDiagnosis) {
      return authDiagnosis;
    }

    const issues = [
      ...(input.schemaErrors ?? []),
      ...extractResponseErrors(input.responseBody),
      ...(input.businessErrors ?? []),
    ];

    if (input.schemaErrors && input.schemaErrors.length > 0) {
      return {
        ok: false,
        category: "schema",
        retryable: false,
        issues,
        suggestedActions: [`update request schema for ${input.apiName}`],
      };
    }

    if (input.statusCode != null && input.statusCode >= 500) {
      return {
        ok: false,
        category: "network",
        retryable: true,
        issues: issues.length > 0 ? issues : [`${input.apiName} returned ${input.statusCode}`],
        suggestedActions: [`retry ${input.operation} for ${input.apiName}`],
      };
    }

    if (input.statusCode != null && input.statusCode >= 400) {
      if (input.statusCode === 408 || input.statusCode === 429) {
        return {
          ok: false,
          category: "network",
          retryable: true,
          issues: issues.length > 0 ? issues : [`${input.apiName} returned ${input.statusCode}`],
          suggestedActions: [
            input.statusCode === 429
              ? `retry ${input.operation} for ${input.apiName} with backoff and respect Retry-After`
              : `retry ${input.operation} for ${input.apiName} with backoff`,
          ],
        };
      }

      return {
        ok: false,
        category: "business",
        retryable: false,
        issues: issues.length > 0 ? issues : [`${input.apiName} returned ${input.statusCode}`],
        suggestedActions: [`inspect ${input.apiName} response body`],
      };
    }

    if (issues.length > 0) {
      return {
        ok: false,
        category: "business",
        retryable: false,
        issues,
        suggestedActions: [`inspect business rules for ${input.apiName}`],
      };
    }

    if (input.errorMessage) {
      return {
        ok: false,
        category: "unknown",
        retryable: true,
        issues: [input.errorMessage],
        suggestedActions: [`inspect ${input.apiName} error details`],
      };
    }

    return {
      ok: true,
      category: "ok",
      retryable: false,
      issues: [],
      suggestedActions: [],
    };
  }
}

function extractResponseErrors(responseBody: unknown): string[] {
  if (!responseBody || typeof responseBody !== "object") {
    return [];
  }

  const issues: string[] = [];
  const record = responseBody as Record<string, unknown>;

  if (Array.isArray(record.errors)) {
    for (const value of record.errors) {
      if (typeof value === "string") {
        issues.push(value);
      } else if (value && typeof value === "object") {
        const message = (value as Record<string, unknown>).message;
        if (typeof message === "string") {
          issues.push(message);
        }
      }
    }
  }

  if (Array.isArray(record.userErrors)) {
    for (const value of record.userErrors) {
      const message = value && typeof value === "object" ? (value as Record<string, unknown>).message : null;
      if (typeof message === "string" && message.length > 0) {
        issues.push(message);
      }
    }
  }

  return issues;
}
