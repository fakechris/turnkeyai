/**
 * Engine policy-trace characterization runner (Stage 8 cleanup, Batch 0.5).
 *
 * Builds the deterministic engine policy-trace characterization (the per-hook
 * decision sequence + the cross-module contract order) and writes it to the
 * reviewable golden file. Run with `--write` to regenerate the golden after an
 * intentional, test-proven change to the decision surface; run without to print a
 * diff-friendly dump and fail if the golden is stale.
 *
 * This is the Batch 0.5 safety net: it pins the CURRENT decision sequence so every
 * later batch can prove it re-emits the same policy vocabulary/order through the
 * extracted modules. The 272 byte-identical BEHAVIOR proof stays owned by
 * scripts/engine-parity-check.ts; this golden owns the DECISION-SEQUENCE surface.
 *
 * Usage:
 *   tsx scripts/engine-policy-trace-characterization.ts           # verify (exit 1 if stale)
 *   tsx scripts/engine-policy-trace-characterization.ts --write   # regenerate golden
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPolicyTraceCharacterization,
  renderCharacterizationJson,
} from "../packages/role-runtime/src/react-engine/policy-trace-characterization";

const GOLDEN_PATH = path.resolve(
  "packages/role-runtime/src/react-engine/__golden__/engine-policy-trace.golden.json",
);

async function main(): Promise<void> {
  const write = process.argv.slice(2).includes("--write");
  const characterization = await buildPolicyTraceCharacterization();
  const rendered = renderCharacterizationJson(characterization) + "\n";

  if (write) {
    await writeFile(GOLDEN_PATH, rendered, "utf8");
    console.log(`[policy-trace] wrote ${path.relative(process.cwd(), GOLDEN_PATH)}`);
    console.log(
      `[policy-trace] ${characterization.decisionVocabulary.length} decision rows, ` +
        `${characterization.contractModuleOpOrder.length} contract module ops`,
    );
    return;
  }

  let existing: string;
  try {
    existing = await readFile(GOLDEN_PATH, "utf8");
  } catch {
    console.error(
      `[policy-trace] golden missing: ${path.relative(process.cwd(), GOLDEN_PATH)} — run with --write`,
    );
    process.exit(1);
    return;
  }
  if (existing !== rendered) {
    console.error(
      "[policy-trace] characterization DRIFTED from golden. If this is intentional " +
        "and test-proven, rerun with --write.",
    );
    process.exit(1);
    return;
  }
  console.log("[policy-trace] golden is up to date.");
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
