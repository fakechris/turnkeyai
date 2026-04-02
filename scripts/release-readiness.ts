import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runReleaseReadiness } from "@turnkeyai/qc-runtime/release-readiness";

const args = process.argv.slice(2);
let jsonPath: string | null = null;
let artifactDirectory: string | null = null;
let skipBuild = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--json") {
    jsonPath = args[index + 1] ?? null;
    index += 1;
    continue;
  }
  if (arg === "--artifact-dir") {
    artifactDirectory = args[index + 1] ?? null;
    index += 1;
    continue;
  }
  if (arg === "--skip-build") {
    skipBuild = true;
  }
}

const result = await runReleaseReadiness({
  artifactDirectory: artifactDirectory ?? undefined,
  ...(skipBuild ? { skipBuild: true } : {}),
});

console.log(`Release readiness: ${result.status} (${result.passedChecks}/${result.totalChecks} checks passed)`);
if (result.artifact) {
  console.log(`artifact: ${result.artifact.filename}`);
}
for (const check of result.checks) {
  console.log(`- ${check.checkId}  status=${check.status}`);
  for (const detail of check.details) {
    console.log(`  ${detail}`);
  }
}

if (jsonPath) {
  const resolvedPath = path.resolve(process.cwd(), jsonPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.exit(result.failedChecks === 0 ? 0 : 1);
