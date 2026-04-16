import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface PackCatalogEntry {
  packId: string;
  displayName: string;
  domain: string;
  summary: string;
  manifestPath: string;
}

interface PackCatalog {
  schemaVersion: 1;
  packs: PackCatalogEntry[];
}

interface PackManifestSection {
  id: string;
  summary: string;
}

interface PackManifest {
  schemaVersion: 1;
  packId: string;
  displayName: string;
  domain: string;
  summary: string;
  owner: string;
  creator: {
    tool: "turnkeyai pack create";
    version: 1;
  };
  capabilities: PackManifestSection[];
  workflows: PackManifestSection[];
}

interface PackCreateOptions {
  rootDir: string;
  packId: string;
  displayName: string;
  domain: string;
  summary: string;
  owner: string;
  capabilities: PackManifestSection[];
  workflows: PackManifestSection[];
  force: boolean;
}

interface PackValidateOptions {
  rootDir: string;
  packId?: string;
}

const REQUIRED_PACK_FILES = [
  "pack.json",
  "PACK.md",
  path.join("recipes", "intake.md"),
  path.join("recipes", "execution.md"),
  path.join("references", "domain-model.md"),
  path.join("examples", "request.md"),
] as const;

export async function runPackCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printPackHelp(0);
  }

  if (subcommand === "create") {
    const options = parsePackCreateArgs(rest);
    await createPackWorkspace(options);
    console.log(`Created pack ${options.packId} in ${path.relative(process.cwd(), packDir(options.rootDir, options.packId))}`);
    return;
  }

  if (subcommand === "validate") {
    const options = parsePackValidateArgs(rest);
    await validatePackWorkspace(options);
    const catalogCount = options.packId ? undefined : await countCatalogPacks(options.rootDir);
    console.log(
      options.packId
        ? `Validated pack ${options.packId}`
        : `Validated ${catalogCount} pack${catalogCount === 1 ? "" : "s"}`
    );
    return;
  }

  console.error(`Unknown pack command: ${subcommand}`);
  printPackHelp(1);
}

export async function createPackWorkspace(options: PackCreateOptions): Promise<void> {
  const outputDir = packDir(options.rootDir, options.packId);
  const manifestPath = path.join(outputDir, "pack.json");

  if (!options.force && (await exists(outputDir))) {
    throw new Error(`pack already exists: ${options.packId}`);
  }

  const manifest: PackManifest = {
    schemaVersion: 1,
    packId: options.packId,
    displayName: options.displayName,
    domain: options.domain,
    summary: options.summary,
    owner: options.owner,
    creator: {
      tool: "turnkeyai pack create",
      version: 1,
    },
    capabilities: options.capabilities,
    workflows: options.workflows,
  };

  await mkdir(path.join(outputDir, "recipes"), { recursive: true });
  await mkdir(path.join(outputDir, "references"), { recursive: true });
  await mkdir(path.join(outputDir, "examples"), { recursive: true });

  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(path.join(outputDir, "PACK.md"), buildPackMarkdown(manifest), "utf8"),
    writeFile(path.join(outputDir, "recipes", "intake.md"), buildIntakeRecipe(manifest), "utf8"),
    writeFile(path.join(outputDir, "recipes", "execution.md"), buildExecutionRecipe(manifest), "utf8"),
    writeFile(path.join(outputDir, "references", "domain-model.md"), buildDomainModelReference(manifest), "utf8"),
    writeFile(path.join(outputDir, "examples", "request.md"), buildExampleRequest(manifest), "utf8"),
  ]);

  await upsertCatalog(options.rootDir, {
    packId: manifest.packId,
    displayName: manifest.displayName,
    domain: manifest.domain,
    summary: manifest.summary,
    manifestPath: toPosix(path.relative(options.rootDir, manifestPath)),
  });
}

export async function validatePackWorkspace(options: PackValidateOptions): Promise<void> {
  const catalog = await readCatalog(path.join(options.rootDir, "packs", "catalog.json"));
  const entries = options.packId
    ? catalog.packs.filter((entry) => entry.packId === normalizePackId(options.packId ?? ""))
    : catalog.packs;

  if (options.packId && entries.length === 0) {
    throw new Error(`pack not found in catalog: ${options.packId}`);
  }

  for (const entry of entries) {
    const manifestPath = path.join(options.rootDir, entry.manifestPath);
    const manifest = await readPackManifest(manifestPath);
    assertManifestMatchesCatalog(entry, manifest, manifestPath);

    const baseDir = path.dirname(manifestPath);
    for (const relativeFile of REQUIRED_PACK_FILES) {
      const targetPath = path.join(baseDir, relativeFile);
      if (!(await exists(targetPath))) {
        throw new Error(`pack ${entry.packId} is missing required file: ${toPosix(path.relative(options.rootDir, targetPath))}`);
      }
    }
  }
}

function parsePackCreateArgs(args: string[]): PackCreateOptions {
  const repeatedCapabilities: string[] = [];
  const repeatedWorkflows: string[] = [];
  let rootDir = process.cwd();
  let packId = "";
  let displayName = "";
  let domain = "";
  let summary = "";
  let owner = "turnkeyai";
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    switch (current) {
      case "--root-dir":
        rootDir = requireValue(args, ++index, current);
        break;
      case "--pack-id":
        packId = requireValue(args, ++index, current);
        break;
      case "--display-name":
        displayName = requireValue(args, ++index, current);
        break;
      case "--domain":
        domain = requireValue(args, ++index, current);
        break;
      case "--summary":
        summary = requireValue(args, ++index, current);
        break;
      case "--owner":
        owner = requireValue(args, ++index, current);
        break;
      case "--capability":
        repeatedCapabilities.push(requireValue(args, ++index, current));
        break;
      case "--workflow":
        repeatedWorkflows.push(requireValue(args, ++index, current));
        break;
      case "--force":
        force = true;
        break;
      case "--help":
      case "-h":
        printPackHelp(0);
        break;
      default:
        throw new Error(`unknown pack create flag: ${current}`);
    }
  }

  const normalizedPackId = normalizePackId(packId);
  if (!normalizedPackId) {
    throw new Error("--pack-id is required");
  }
  if (!displayName.trim()) {
    throw new Error("--display-name is required");
  }
  if (!domain.trim()) {
    throw new Error("--domain is required");
  }
  if (!summary.trim()) {
    throw new Error("--summary is required");
  }

  const normalizedDomain = normalizeDomain(domain);
  return {
    rootDir: path.resolve(rootDir),
    packId: normalizedPackId,
    displayName: displayName.trim(),
    domain: normalizedDomain,
    summary: summary.trim(),
    owner: owner.trim() || "turnkeyai",
    capabilities:
      repeatedCapabilities.length > 0
        ? repeatedCapabilities.map((entry) => parseSection(entry, "capability"))
        : buildDefaultCapabilities(normalizedDomain),
    workflows:
      repeatedWorkflows.length > 0
        ? repeatedWorkflows.map((entry) => parseSection(entry, "workflow"))
        : buildDefaultWorkflows(normalizedDomain),
    force,
  };
}

function parsePackValidateArgs(args: string[]): PackValidateOptions {
  let rootDir = process.cwd();
  let packId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    switch (current) {
      case "--root-dir":
        rootDir = requireValue(args, ++index, current);
        break;
      case "--pack-id":
        packId = requireValue(args, ++index, current);
        break;
      case "--help":
      case "-h":
        printPackHelp(0);
        break;
      default:
        throw new Error(`unknown pack validate flag: ${current}`);
    }
  }

  return packId
    ? {
        rootDir: path.resolve(rootDir),
        packId: normalizePackId(packId),
      }
    : {
        rootDir: path.resolve(rootDir),
      };
}

function buildDefaultCapabilities(domain: string): PackManifestSection[] {
  return [
    {
      id: `${domain}-intake`,
      summary: `Turn an incoming ${domain} request into an executable brief, deliverable matrix, and constraints list.`,
    },
    {
      id: `${domain}-production`,
      summary: `Produce the first-pass ${domain} artifacts with explicit tool choices and handoff fields.`,
    },
    {
      id: `${domain}-qa`,
      summary: `Review ${domain} outputs for quality, packaging, and operator handoff readiness.`,
    },
    {
      id: `${domain}-adaptation`,
      summary: `Adapt ${domain} outputs into derived formats, channels, or downstream deliverables.`,
    },
  ];
}

function buildDefaultWorkflows(domain: string): PackManifestSection[] {
  return [
    {
      id: "brief-intake",
      summary: `Normalize the ${domain} brief, deliverables, references, and hard constraints before execution.`,
    },
    {
      id: "execution-plan",
      summary: `Break the ${domain} request into tool choices, artifact stages, and review gates.`,
    },
    {
      id: "quality-gate",
      summary: `Check the ${domain} output against acceptance criteria and record remaining gaps or risks.`,
    },
  ];
}

function parseSection(raw: string, kind: "capability" | "workflow"): PackManifestSection {
  const [idPart, ...summaryParts] = raw.split(":");
  const id = normalizeSectionId(idPart ?? "");
  if (!id) {
    throw new Error(`${kind} id is required: ${raw}`);
  }
  const summary = summaryParts.join(":").trim() || `Define the ${kind} contract for ${id}.`;
  return { id, summary };
}

function buildPackMarkdown(manifest: PackManifest): string {
  return `# ${manifest.displayName}

## Summary

${manifest.summary}

## Domain

- domain: \`${manifest.domain}\`
- owner: \`${manifest.owner}\`
- creator: \`${manifest.creator.tool}\`

## Capability Map

${manifest.capabilities.map((section) => `- \`${section.id}\`: ${section.summary}`).join("\n")}

## Workflow Map

${manifest.workflows.map((section) => `- \`${section.id}\`: ${section.summary}`).join("\n")}

## Use This Pack When

- The request clearly belongs to the \`${manifest.domain}\` domain.
- Deliverables, constraints, and the review bar can be written down before execution.
- Another agent or pack may need to continue from the same artifacts later.

## Operating Contract

1. Start from a normalized brief with explicit outputs, references, and delivery constraints.
2. Pick the smallest workflow and tool set that can complete the pack without hidden assumptions.
3. Keep intermediate artifacts named and reviewable so another pack can continue from the same state.
4. End every execution with an acceptance pass that states what is complete, inferred, and still missing.
`;
}

function buildIntakeRecipe(manifest: PackManifest): string {
  return `# ${manifest.displayName} Intake

## Inputs

- primary objective
- target audience or downstream consumer
- required deliverables and output formats
- source assets, references, or prior examples
- hard constraints: format, size, duration, latency, budget, legal, policy
- explicit non-goals and out-of-scope requests

## Checklist

1. Restate the objective in one sentence.
2. Enumerate a deliverable matrix: artifact, format, owner, acceptance bar.
3. Inventory required assets, approvals, and external dependencies.
4. Mark every important fact as confirmed, inferred, or missing.
5. Stop if the request is missing a required asset, approval, or output contract.

## Output

- normalized brief
- deliverable matrix
- asset and dependency inventory
- acceptance contract
- explicit execution plan
- open questions
`;
}

function buildExecutionRecipe(manifest: PackManifest): string {
  return `# ${manifest.displayName} Execution

## Workflow Order

${manifest.workflows.map((section, index) => `${index + 1}. \`${section.id}\` - ${section.summary}`).join("\n")}

## Execution Rules

- Preserve source links, input artifacts, and generated artifacts so another pack can continue from the same state.
- Record tool choices and irreversible transforms before applying them.
- Keep confirmed facts separate from inferred assumptions throughout execution.
- Fail fast when a required asset, approval, or dependency is missing.

## Required Handoff Fields

- brief
- confirmed facts
- inferred assumptions
- chosen workflow
- tools and external dependencies
- artifacts produced
- acceptance result
- remaining risks
- next extension ideas
`;
}

function buildDomainModelReference(manifest: PackManifest): string {
  return `# ${manifest.displayName} Domain Model

## Pack Manifest

- packId: stable machine id for the pack
- displayName: human-facing label
- domain: domain boundary for the pack
- capabilities: repeatable domain abilities
- workflows: repeatable execution paths

## Actors

- request owner
- pack operator
- downstream consumer

## Artifact Types

- source inputs
- intermediate working artifacts
- final deliverables
- review notes and acceptance evidence

## Constraint Types

- technical constraints
- policy or compliance constraints
- timeline and budget constraints
- handoff and packaging constraints

## Review Rubric

- Does the output satisfy the requested deliverables and formats?
- Can another agent trace how the output was produced?
- Are policy-sensitive or low-confidence claims clearly marked?
- Is the handoff concrete enough to continue without hidden context?
`;
}

function buildExampleRequest(manifest: PackManifest): string {
  return `# Example Request

Use \`${manifest.displayName}\` when you need a ${manifest.domain} deliverable with explicit acceptance criteria.

Example:

> Build a ${manifest.domain} deliverable for <goal>.
> Audience or consumer: <audience>.
> Required outputs: <deliverables>.
> Source assets or references: <inputs>.
> Constraints: <constraints>.
> Acceptance bar: <acceptance>.
`;
}

async function upsertCatalog(rootDir: string, entry: PackCatalogEntry): Promise<void> {
  const catalogPath = path.join(rootDir, "packs", "catalog.json");
  const current = await readCatalog(catalogPath);
  const nextEntries = current.packs.filter((item) => item.packId !== entry.packId).concat(entry);
  nextEntries.sort((left, right) => left.packId.localeCompare(right.packId));
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await writeFile(
    catalogPath,
    `${JSON.stringify({ schemaVersion: 1, packs: nextEntries } satisfies PackCatalog, null, 2)}\n`,
    "utf8"
  );
}

async function readCatalog(catalogPath: string): Promise<PackCatalog> {
  try {
    const raw = await readFile(catalogPath, "utf8");
    const parsed = JSON.parse(raw) as PackCatalog;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.packs)) {
      return parsed;
    }
  } catch {}

  return {
    schemaVersion: 1,
    packs: [],
  };
}

async function readPackManifest(manifestPath: string): Promise<PackManifest> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as PackManifest;

  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.packId !== "string" ||
    typeof parsed.displayName !== "string" ||
    typeof parsed.domain !== "string" ||
    typeof parsed.summary !== "string" ||
    typeof parsed.owner !== "string" ||
    !parsed.creator ||
    parsed.creator.tool !== "turnkeyai pack create" ||
    parsed.creator.version !== 1 ||
    !Array.isArray(parsed.capabilities) ||
    !Array.isArray(parsed.workflows)
  ) {
    throw new Error(`invalid pack manifest: ${manifestPath}`);
  }

  return parsed;
}

function assertManifestMatchesCatalog(entry: PackCatalogEntry, manifest: PackManifest, manifestPath: string): void {
  if (manifest.packId !== entry.packId) {
    throw new Error(`catalog packId mismatch for ${manifestPath}: expected ${entry.packId}, found ${manifest.packId}`);
  }
  if (manifest.displayName !== entry.displayName) {
    throw new Error(`catalog displayName mismatch for ${manifest.packId}`);
  }
  if (manifest.domain !== entry.domain) {
    throw new Error(`catalog domain mismatch for ${manifest.packId}`);
  }
  if (manifest.summary !== entry.summary) {
    throw new Error(`catalog summary mismatch for ${manifest.packId}`);
  }
}

async function countCatalogPacks(rootDir: string): Promise<number> {
  const catalog = await readCatalog(path.join(rootDir, "packs", "catalog.json"));
  return catalog.packs.length;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function normalizePackId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function normalizeSectionId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function packDir(rootDir: string, packId: string): string {
  return path.join(rootDir, "packs", packId);
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function printPackHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI pack tooling",
    "",
    "Usage:",
    "  turnkeyai pack create --pack-id <id> --display-name <name> --domain <domain> --summary <text> [options]",
    "  turnkeyai pack validate [--pack-id <id>] [options]",
    "",
    "Create options:",
    "  --owner <owner>              Override manifest owner (default: turnkeyai)",
    "  --capability <id:summary>    Add a capability section; repeatable",
    "  --workflow <id:summary>      Add a workflow section; repeatable",
    "  --root-dir <dir>             Override target workspace root",
    "  --force                      Overwrite an existing pack directory",
    "",
    "Validate options:",
    "  --pack-id <id>               Validate a single pack from the catalog",
    "  --root-dir <dir>             Override target workspace root",
  ];
  const output = exitCode === 0 ? console.log : console.error;
  output(lines.join("\n"));
  process.exit(exitCode);
}
