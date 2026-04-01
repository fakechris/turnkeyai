import type { RoleId, ShardResultRecord } from "./team";

const CONFLICT_KEYWORD_PATTERN = /(?<!\b(?:no|not|none|never|without|no evidence of|no evidence for|without any)\s(?:a\s+|an\s+|any\s+)?)\b(conflict|conflicting|inconsistent|mismatch|disagree|contradict)\b/i;

export function detectDuplicateRoleIds(results: ShardResultRecord[]): RoleId[] {
  const byDigest = new Map<string, RoleId[]>();
  for (const result of results.filter((item) => item.status === "completed" && item.summaryDigest.length > 0)) {
    const current = byDigest.get(result.summaryDigest) ?? [];
    current.push(result.roleId);
    byDigest.set(result.summaryDigest, current);
  }

  return unique(
    [...byDigest.values()]
      .filter((roleIds) => roleIds.length > 1)
      .flat()
  );
}

export function detectConflictRoleIds(results: ShardResultRecord[]): RoleId[] {
  const conflicting = new Set<RoleId>();
  const claims = new Map<string, Map<string, Set<RoleId>>>();

  for (const result of results.filter((item) => item.status === "completed")) {
    if (CONFLICT_KEYWORD_PATTERN.test(result.summary)) {
      conflicting.add(result.roleId);
    }

    for (const claim of extractNumericClaims(result.summary)) {
      const values = claims.get(claim.subject) ?? new Map<string, Set<RoleId>>();
      const roles = values.get(claim.value) ?? new Set<RoleId>();
      roles.add(result.roleId);
      values.set(claim.value, roles);
      claims.set(claim.subject, values);
    }
  }

  for (const valueMap of claims.values()) {
    if (valueMap.size <= 1) {
      continue;
    }
    for (const roles of valueMap.values()) {
      for (const roleId of roles) {
        conflicting.add(roleId);
      }
    }
  }

  return [...conflicting];
}

function extractNumericClaims(summary: string): Array<{ subject: string; value: string }> {
  const claims: Array<{ subject: string; value: string }> = [];
  for (const segment of summary.split(/\n+|[.!?]\s+/)) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const values = trimmed.match(/\$?\d+(?:\.\d+)?(?:\s*\/\s*\w+)?/g);
    if (!values || values.length === 0) {
      continue;
    }
    const subject = trimmed
      .toLowerCase()
      .replace(/\$?\d+(?:\.\d+)?(?:\s*\/\s*\w+)?/g, "#")
      .replace(/^\w+:\s*/, "")
      .replace(/[.!?,;:"']+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    claims.push({
      subject,
      value: values.join("|"),
    });
  }
  return claims;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
