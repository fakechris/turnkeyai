/**
 * Engine parity runner (Stage 8 cutover, Batch A harness).
 *
 * Runs the role-runtime response-generator suite under the ReAct engine path
 * (TURNKEYAI_REACT_ENGINE=engine) and reports inline-vs-engine parity failures
 * grouped by capability cluster.
 *
 * Why this exists: a single-process full-file engine run dies after ~54 tests.
 * The engine path leaks a timer from an active browser session (not torn down at
 * the parent wall-clock boundary); the timer fires ~2 min into the run and
 * crashes whatever test is executing then, taking the rest of the suite with it.
 * Inline runs all 252 past it, so this is an engine-path defect (Batch E), not a
 * single bad test. To run to completion anyway this runner executes the suite in
 * small CHUNKS, each a fresh process, so a leaked timer at most kills one chunk
 * (and chunks are short enough to finish before it fires). Every chunk also gets
 * --test-force-exit, a per-test timeout, and an OS-level process-group kill
 * backstop. Failures end up "known, categorized, and runnable to completion"
 * instead of a mid-suite deadlock.
 *
 * Usage:
 *   tsx scripts/engine-parity-check.ts                 # engine mode, chunked, all clusters
 *   tsx scripts/engine-parity-check.ts --inline        # inline baseline (single pass)
 *   tsx scripts/engine-parity-check.ts --cluster c5    # only the C5 memory cluster (single pass)
 *   tsx scripts/engine-parity-check.ts --chunk 20      # chunk size for the full engine run
 *   tsx scripts/engine-parity-check.ts --write         # persist the status doc
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const TEST_FILE = "packages/role-runtime/src/llm-response-generator.test.ts";
const STATUS_DOC = "docs/STAGE8B_PARITY_STATUS.md";

/**
 * Tests known to crash/hang the engine path. Skipped by name so the rest of the
 * suite runs. Each entry carries the owning batch + reason so the skip is
 * auditable, not silent. Remove an entry once its batch fixes the defect.
 *
 * The "#55" parent wall-clock boundary test passes in 1s in isolation, but under
 * the engine an active browser session is not aborted/torn down at the parent
 * wall-clock boundary; its leaked timer fires later and crashes the run. Chunking
 * already isolates most leak-crashes, but this specific test reliably triggers it
 * so we skip it outright. Root-causing the abort is the Batch E item.
 */
const KNOWN_HANGS: { pattern: string; batch: string; reason: string }[] = [
  {
    pattern:
      "does not abort active browser sessions at the parent wall-clock boundary",
    batch: "E",
    reason:
      "engine does not abort/tear down the active browser session at the parent wall-clock boundary; its leaked timer crashes the run (#55)",
  },
  {
    pattern: "does not treat resumable partial session output as completion evidence",
    batch: "B",
    reason:
      "engine never terminates on this case even in isolation (churns to maxRounds past the 180s backstop) where inline converges — a continuation-plane convergence divergence; revisit once Batch B lands the continuation-completion recognition",
  },
];

/**
 * Capability clusters. The FIRST matching pattern wins, so order = priority.
 * This map is the single source of truth for both categorization (grouping
 * fails) and `--cluster <key>` filtering (running just one cluster's tests).
 */
// Precedence matters: first match wins, so the order encodes which batch owns an
// ambiguous test. Memory (C5) and budget (T7) keywords are distinctive and go
// first; browser FINALIZATION/visibility (T10) before tool ROUTING (T2) so a
// browser-visibility test that incidentally mentions "session" lands in T10, and
// a spawn-rerouting test lands in T2. Heuristic, not exact — a handful of
// border cases will sit one batch off; that is fine for a worklist.
const CLUSTERS: { key: string; label: string; pattern: RegExp }[] = [
  {
    key: "c5",
    label: "C5 memory / compaction / envelope",
    pattern:
      /envelope|memory|compact|prun(e|es|ing)|reduc(e|es|tion)|tool history|message-count overflow|oversized (tool|session) result|preserves tool history|flush/i,
  },
  {
    key: "t7",
    label: "T7 execution budget / wall-clock",
    pattern:
      /wall.?clock|budget|round limit|tool round limit|execution cap|per-turn tool calls|max (tool|round)|over-?cap|recovery (tool )?budget|final recovery/i,
  },
  {
    key: "t10",
    label: "T10 browser / session finalization & visibility",
    pattern:
      /browser recovery|recovery visible|browser timeout recovery|bucket( visibility)?|residual risk|cold (recreation|session)|unverified( browser)?|browser limitation|surfaces browser|detached-target|cdp timeout|keeps browser/i,
  },
  {
    key: "t2",
    label: "T2 tool normalization / continuation",
    pattern:
      /continuation|sessions?_(send|list|spawn)|session (key|list|lookup|update|alias)|normaliz|canonical|reroute|rewrite|rewrites|follow-up|spawn|alias|directive|web_fetch|private url|loopback|timeout (source|follow-up|key)|duplicate spawn|lists sessions|listed|routes/i,
  },
  {
    key: "other",
    label: "Other (closeout / misc)",
    pattern: /.*/,
  },
];

interface Args {
  inline: boolean;
  cluster: string | null;
  chunkSize: number;
  chunkTimeoutSec: number;
  perTestSec: number;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    inline: false,
    cluster: null,
    chunkSize: 20,
    chunkTimeoutSec: 180,
    perTestSec: 30,
    write: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--inline") args.inline = true;
    else if (a === "--write") args.write = true;
    else if (a === "--cluster") args.cluster = (argv[++i] ?? "").toLowerCase();
    else if (a === "--chunk") args.chunkSize = Number(argv[++i] ?? "20");
    else if (a === "--chunk-timeout") args.chunkTimeoutSec = Number(argv[++i] ?? "180");
    else if (a === "--per-test") args.perTestSec = Number(argv[++i] ?? "30");
  }
  return args;
}

interface TapResult {
  ok: boolean;
  name: string;
}

/** Parse the node:test TAP stream into top-level test points. */
function parseTap(stdout: string): TapResult[] {
  const results: TapResult[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimStart();
    const m = /^(not )?ok (\d+) - (.+?)(?:\s+#.*)?$/.exec(line);
    if (!m) continue;
    const name = m[3].trim();
    if (!name) continue;
    results.push({ ok: !m[1], name });
  }
  return results;
}

function clusterFor(name: string): { key: string; label: string } {
  for (const c of CLUSTERS) {
    if (c.pattern.test(name)) return { key: c.key, label: c.label };
  }
  return { key: "other", label: "Other / unclustered" };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSkipped(name: string): boolean {
  return KNOWN_HANGS.some((h) => name.includes(h.pattern));
}

interface ChildRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Spawn one `tsx --test` child, capture its TAP, and reap the whole process
 * group on the OS-timeout backstop. detached:true is required so the backstop
 * can kill the grandchild test workers (npx -> tsx -> node), not just the direct
 * child — otherwise an orphaned worker holds the stdout pipe open and deadlocks
 * this runner.
 */
function runChild(
  extraArgs: string[],
  useEngine: boolean,
  osTimeoutSec: number,
  perTestSec: number,
): Promise<ChildRun> {
  const childArgs = [
    "tsx",
    "--test",
    "--test-reporter=tap",
    `--test-timeout=${perTestSec * 1000}`,
    "--test-force-exit",
    ...extraArgs,
    TEST_FILE,
  ];
  const env = { ...process.env };
  if (useEngine) env.TURNKEYAI_REACT_ENGINE = "engine";
  else delete env.TURNKEYAI_REACT_ENGINE;

  const child = spawn("npx", childArgs, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const killTree = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, osTimeoutSec * 1000);

  return new Promise<ChildRun>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

/** Discover the full ordered list of test names via a reliable inline TAP run. */
async function discoverNames(osTimeoutSec: number, perTestSec: number): Promise<string[]> {
  const r = await runChild([], false, osTimeoutSec, perTestSec);
  return parseTap(r.stdout).map((t) => t.name);
}

interface Report {
  results: TapResult[];
  incomplete: string[];
  crashedChunks: number;
  note: string;
}

function renderReport(mode: string, rep: Report): string {
  const fails = rep.results.filter((r) => !r.ok);
  const passCount = rep.results.length - fails.length;

  const grouped = new Map<string, string[]>();
  for (const c of CLUSTERS) grouped.set(c.key, []);
  for (const f of fails) grouped.get(clusterFor(f.name).key)!.push(f.name);

  const lines: string[] = [];
  lines.push(`# Stage 8B engine-parity status (${mode} mode)`);
  lines.push("");
  lines.push(
    `Ran ${rep.results.length} test points: **${passCount} pass / ${fails.length} fail**.` +
      (rep.note ? ` ${rep.note}` : ""),
  );
  lines.push("");
  if (mode === "engine" && KNOWN_HANGS.length) {
    lines.push(`Skipped ${KNOWN_HANGS.length} known engine crash/non-termination test(s):`);
    for (const h of KNOWN_HANGS)
      lines.push(`- (Batch ${h.batch}) \`${h.pattern}\` — ${h.reason}`);
    lines.push("");
  }
  if (rep.incomplete.length) {
    lines.push(
      `## ⚠️ Incomplete — ${rep.incomplete.length} test(s) never reported (${rep.crashedChunks} chunk(s) crashed)`,
    );
    lines.push("");
    for (const n of rep.incomplete) lines.push(`- ${n}`);
    lines.push("");
  }
  lines.push("## Fail clusters");
  lines.push("");
  let any = false;
  for (const c of CLUSTERS) {
    const names = grouped.get(c.key)!;
    if (!names.length) continue;
    any = true;
    lines.push(`### ${c.label} — ${names.length}`);
    for (const n of names) lines.push(`- ${n}`);
    lines.push("");
  }
  if (!any) {
    lines.push("✅ No parity failures.");
    lines.push("");
  }
  return lines.join("\n");
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.inline ? "inline" : "engine";

  // --- Single-pass paths: inline baseline, or a targeted cluster run. ---
  if (args.inline || args.cluster) {
    const extra: string[] = [];
    if (args.cluster) {
      const cf = CLUSTERS.find((c) => c.key === args.cluster);
      if (!cf || cf.key === "other") {
        console.error(
          `Unknown --cluster "${args.cluster}". Known: ${CLUSTERS.filter((c) => c.key !== "other")
            .map((c) => c.key)
            .join(", ")}`,
        );
        process.exit(2);
      }
      extra.push(`--test-name-pattern=${cf.pattern.source}`);
    }
    if (!args.inline) for (const h of KNOWN_HANGS) extra.push(`--test-skip-pattern=${h.pattern}`);

    console.log(
      `[parity] mode=${mode}${args.cluster ? ` cluster=${args.cluster}` : ""} single-pass ` +
        `per-test=${args.perTestSec}s os-backstop=${args.chunkTimeoutSec}s`,
    );
    const r = await runChild(extra, !args.inline, args.chunkTimeoutSec, args.perTestSec);
    const results = parseTap(r.stdout);
    const note = r.timedOut ? "⚠️ OS-timeout backstop fired (run incomplete)." : `child exit=${r.exitCode}.`;
    await finish(mode, { results, incomplete: [], crashedChunks: 0, note }, args, r.timedOut);
    return;
  }

  // --- Chunked engine run: discover names, then run small fresh-process chunks. ---
  console.log(`[parity] mode=engine chunked discover... per-test=${args.perTestSec}s`);
  const allNames = await discoverNames(args.chunkTimeoutSec, args.perTestSec);
  if (!allNames.length) {
    console.error("[parity] discovery found no test names (inline run failed?)");
    process.exit(2);
  }
  const toRun = allNames.filter((n) => !isSkipped(n));
  const chunks: string[][] = [];
  for (let i = 0; i < toRun.length; i += args.chunkSize) {
    chunks.push(toRun.slice(i, i + args.chunkSize));
  }
  console.log(
    `[parity] discovered ${allNames.length} tests (${allNames.length - toRun.length} skipped) ` +
      `-> ${chunks.length} chunks of <=${args.chunkSize}`,
  );

  const seen = new Map<string, boolean>();
  let crashedChunks = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const pattern = "^(?:" + chunk.map(escapeRegex).join("|") + ")$";
    const r = await runChild([`--test-name-pattern=${pattern}`], true, args.chunkTimeoutSec, args.perTestSec);
    const results = parseTap(r.stdout);
    for (const t of results) seen.set(t.name, t.ok);
    const reported = results.length;
    const crashed = reported < chunk.length || r.timedOut;
    if (crashed) crashedChunks++;
    console.log(
      `[parity] chunk ${ci + 1}/${chunks.length}: ${reported}/${chunk.length} reported` +
        (crashed ? ` ⚠️ exit=${r.exitCode}${r.timedOut ? " timeout" : ""}` : ""),
    );
  }

  // Recovery: re-run any test a crashed/timed-out chunk never reported, one per
  // process. A cross-test leaked-timer crash usually does NOT reproduce when the
  // blameless neighbour runs alone, so this recovers most of them and isolates
  // the genuine crasher/churner down to a single test.
  const firstPassIncomplete = toRun.filter((n) => !seen.has(n));
  if (firstPassIncomplete.length) {
    console.log(
      `[parity] recovering ${firstPassIncomplete.length} incomplete test(s) individually...`,
    );
    for (let i = 0; i < firstPassIncomplete.length; i++) {
      const name = firstPassIncomplete[i];
      const pattern = "^(?:" + escapeRegex(name) + ")$";
      const r = await runChild(
        [`--test-name-pattern=${pattern}`],
        true,
        args.chunkTimeoutSec,
        args.perTestSec,
      );
      const rr = parseTap(r.stdout);
      for (const t of rr) seen.set(t.name, t.ok);
      if (!rr.length) {
        console.log(
          `[parity] recover ${i + 1}/${firstPassIncomplete.length}: STILL incomplete — ${name}`,
        );
      }
    }
  }

  const results: TapResult[] = [];
  const incomplete: string[] = [];
  for (const name of toRun) {
    if (seen.has(name)) results.push({ ok: seen.get(name)!, name });
    else incomplete.push(name);
  }
  const note =
    crashedChunks > 0
      ? `${crashedChunks} chunk(s) crashed; ${incomplete.length} test(s) incomplete.`
      : "All chunks completed.";
  await finish("engine", { results, incomplete, crashedChunks, note }, args, incomplete.length > 0);
}

async function finish(mode: string, rep: Report, args: Args, incomplete: boolean): Promise<void> {
  const report = renderReport(mode, rep);
  console.log("\n" + report);
  if (args.write) {
    await writeFile(path.resolve(STATUS_DOC), report + "\n", "utf8");
    console.log(`[parity] wrote ${STATUS_DOC}`);
  }
  const fails = rep.results.filter((r) => !r.ok).length;
  process.exit(incomplete ? 3 : fails ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(2);
});
