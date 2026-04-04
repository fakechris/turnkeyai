import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ReleaseReadinessCheckResult {
  checkId: string;
  title: string;
  status: "passed" | "failed";
  details: string[];
}

export interface ReleaseReadinessArtifact {
  filename: string;
  packageSize?: number;
  unpackedSize?: number;
  shasum?: string;
  integrity?: string;
  totalFiles?: number;
}

export interface ReleaseReadinessResult {
  status: "passed" | "failed";
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  artifact: ReleaseReadinessArtifact | null;
  checks: ReleaseReadinessCheckResult[];
}

export interface ReleaseReadinessOptions {
  workspaceRoot?: string;
  artifactDirectory?: string;
  expectedPackageName?: string;
  expectedPackageVersion?: string;
  skipBuild?: boolean;
}

interface PackedArtifactMetadata {
  filename: string;
  path: string;
  id?: string;
  name?: string;
  version?: string;
  size?: number;
  unpackedSize?: number;
  shasum?: string;
  integrity?: string;
  entryCount?: number;
}

const DEFAULT_PACKAGE_NAME = "@turnkeyai/cli";
const REQUIRED_PACKAGE_FILES = [
  "package/package.json",
  "package/bin/turnkeyai.js",
  "package/dist/cli.js",
  "package/dist/tui.js",
  "package/dist/daemon.js",
  "package/README.md",
  "package/LICENSE",
] as const;

export async function runReleaseReadiness(
  options: ReleaseReadinessOptions = {}
): Promise<ReleaseReadinessResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const sourcePackageJson = await readSourceCliPackageJson(workspaceRoot);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-release-readiness-"));
  const extractDir = path.join(tempRoot, "extract");
  const packDir = options.artifactDirectory
    ? path.resolve(workspaceRoot, options.artifactDirectory)
    : path.join(tempRoot, "artifacts");
  await mkdir(extractDir, { recursive: true });
  await mkdir(packDir, { recursive: true });

  const checks: ReleaseReadinessCheckResult[] = [];
  let artifact: ReleaseReadinessArtifact | null = null;

  try {
    if (!options.skipBuild) {
      await recordCheck(checks, "build-cli", "Build publishable CLI package", async () => {
        await execFile("npm", ["run", "build", "--workspace", "@turnkeyai/cli"], {
          cwd: workspaceRoot,
          maxBuffer: 8 * 1024 * 1024,
        });
        return {
          status: "passed" as const,
          details: ["npm run build --workspace @turnkeyai/cli"],
        };
      });
    }

    const packed = await recordCheck(checks, "pack-cli", "Pack publishable CLI tarball", async () => {
      const metadata = await packCliArtifact(workspaceRoot, packDir);
      return {
        status: "passed",
        details: [
          `filename=${metadata.filename}`,
          `packageSize=${metadata.size ?? 0}`,
          `unpackedSize=${metadata.unpackedSize ?? 0}`,
          `files=${metadata.entryCount ?? 0}`,
        ],
        metadata,
      };
    });

    if (!packed?.metadata) {
      return finalizeReleaseReadinessResult(checks, artifact);
    }

    artifact = {
      filename: packed.metadata.filename,
      ...(packed.metadata.size !== undefined ? { packageSize: packed.metadata.size } : {}),
      ...(packed.metadata.unpackedSize !== undefined ? { unpackedSize: packed.metadata.unpackedSize } : {}),
      ...(packed.metadata.shasum ? { shasum: packed.metadata.shasum } : {}),
      ...(packed.metadata.integrity ? { integrity: packed.metadata.integrity } : {}),
      ...(packed.metadata.entryCount !== undefined ? { totalFiles: packed.metadata.entryCount } : {}),
    };

    const extracted = await recordCheck(checks, "extract-package", "Extract packed CLI artifact", async () => {
      await extractPackedArtifact(packed.metadata.path, extractDir);
      const extractedPackageDir = path.join(extractDir, "package");
      const packageJsonPath = path.join(extractedPackageDir, "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        name?: string;
        version?: string;
        license?: string;
        bin?: Record<string, string>;
        files?: string[];
        publishConfig?: { access?: string };
        engines?: { node?: string };
      };
      return {
        status: "passed" as const,
        details: [
          `artifact=${packed.metadata.filename}`,
          `packageJson=${path.relative(workspaceRoot, packageJsonPath)}`,
        ],
        metadata: {
          extractedPackageDir,
          packageJson,
        },
      };
    });
    if (!extracted?.metadata) {
      return finalizeReleaseReadinessResult(checks, artifact);
    }

    const { extractedPackageDir, packageJson } = extracted.metadata;
    const expectedPackageName = options.expectedPackageName ?? DEFAULT_PACKAGE_NAME;
    const expectedPackageVersion = options.expectedPackageVersion ?? sourcePackageJson.version;

    await recordCheck(checks, "package-metadata", "Validate packaged CLI metadata", async () => {
      const failures: string[] = [];
      if (packageJson.name !== expectedPackageName) {
        failures.push(`expected name ${expectedPackageName}, got ${packageJson.name ?? "missing"}`);
      }
      if (!packageJson.version) {
        failures.push("missing packaged version");
      } else if (expectedPackageVersion && packageJson.version !== expectedPackageVersion) {
        failures.push(`expected version ${expectedPackageVersion}, got ${packageJson.version ?? "missing"}`);
      }
      if (packageJson.license !== "Apache-2.0") {
        failures.push(`expected license Apache-2.0, got ${packageJson.license ?? "missing"}`);
      }
      if (packageJson.publishConfig?.access !== "public") {
        failures.push(`expected publish access public, got ${packageJson.publishConfig?.access ?? "missing"}`);
      }
      if (packageJson.engines?.node !== ">=24") {
        failures.push(`expected node engine >=24, got ${packageJson.engines?.node ?? "missing"}`);
      }
      if (packageJson.bin?.turnkeyai !== "bin/turnkeyai.js") {
        failures.push(`expected bin.turnkeyai to equal bin/turnkeyai.js, got ${packageJson.bin?.turnkeyai ?? "missing"}`);
      }

      return {
        status: failures.length === 0 ? "passed" : "failed",
        details: failures.length > 0
          ? failures
          : [
              `name=${packageJson.name}`,
              `version=${packageJson.version}`,
              `license=${packageJson.license}`,
              `publishAccess=${packageJson.publishConfig?.access}`,
              `node=${packageJson.engines?.node}`,
            ],
      };
    });

    await recordCheck(checks, "package-files", "Validate packaged CLI file set", async () => {
      const missing: string[] = [];
      for (const relativePath of REQUIRED_PACKAGE_FILES) {
        try {
          await access(path.join(extractDir, relativePath));
        } catch {
          missing.push(relativePath);
        }
      }

      return {
        status: missing.length === 0 ? "passed" : "failed",
        details: missing.length === 0
          ? REQUIRED_PACKAGE_FILES.map((file) => `present=${file}`)
          : missing.map((file) => `missing=${file}`),
      };
    });

    await recordCheck(checks, "bin-help-smoke", "Run packaged bin help smoke test", async () => {
      const stdout = await runNodeCommand(
        [path.join(extractedPackageDir, "bin/turnkeyai.js"), "--help"],
        extractedPackageDir
      );
      const ok = stdout.includes("TurnkeyAI CLI") && stdout.includes("turnkeyai daemon") && stdout.includes("turnkeyai tui");
      return {
        status: ok ? "passed" : "failed",
        details: ok ? ["packaged bin returned expected help output"] : ["packaged bin help output was missing expected commands"],
      };
    });

    await recordCheck(checks, "dist-help-smoke", "Run packaged dist help smoke test", async () => {
      const stdout = await runNodeCommand(
        [path.join(extractedPackageDir, "dist/cli.js"), "--help"],
        extractedPackageDir
      );
      const ok = stdout.includes("TurnkeyAI CLI") && stdout.includes("turnkeyai daemon") && stdout.includes("turnkeyai tui");
      return {
        status: ok ? "passed" : "failed",
        details: ok ? ["packed dist/cli.js returned expected help output"] : ["packed dist/cli.js help output was missing expected commands"],
      };
    });

    await recordCheck(checks, "publish-dry-run", "Run npm publish dry-run", async () => {
      const dryRunVersion = createDryRunVersion(packageJson.version ?? expectedPackageVersion ?? "0.0.0");
      const combinedOutput = await runPublishDryRun(extractedPackageDir, packageJson, dryRunVersion);
      const failedReasons: string[] = [];
      if (!combinedOutput.includes(`${expectedPackageName}@${dryRunVersion}`)) {
        failedReasons.push("dry-run output did not include package coordinates");
      }
      if (combinedOutput.includes("auto-corrected")) {
        failedReasons.push("npm publish dry-run auto-corrected package metadata");
      }
      if (combinedOutput.includes("invalid and removed")) {
        failedReasons.push("npm publish dry-run removed an invalid package entry");
      }
      return {
        status: failedReasons.length === 0 ? "passed" : "failed",
        details: failedReasons.length > 0
          ? failedReasons
          : [
              "npm publish --dry-run completed without metadata correction warnings",
              `dryRunVersion=${dryRunVersion}`,
            ],
      };
    });

    return finalizeReleaseReadinessResult(checks, artifact);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function packCliArtifact(workspaceRoot: string, packDir: string): Promise<PackedArtifactMetadata> {
  const { stdout } = await execFile(
    "npm",
    ["pack", "--workspace", "@turnkeyai/cli", "--pack-destination", packDir, "--json"],
    { cwd: workspaceRoot, maxBuffer: 8 * 1024 * 1024 }
  );
  const match = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
  if (!match) {
    throw new Error("npm pack did not emit trailing JSON metadata");
  }
  const jsonPayload = match[1];
  if (!jsonPayload) {
    throw new Error("npm pack did not include a JSON payload");
  }
  const parsed = JSON.parse(jsonPayload) as Array<{
    filename: string;
    id?: string;
    name?: string;
    version?: string;
    size?: number;
    unpackedSize?: number;
    shasum?: string;
    integrity?: string;
    entryCount?: number;
  }>;
  const metadata = parsed[0];
  if (!metadata?.filename) {
    throw new Error("npm pack did not return a tarball filename");
  }
  return {
    ...metadata,
    path: path.join(packDir, metadata.filename),
  };
}

async function extractPackedArtifact(tarballPath: string, extractDir: string): Promise<void> {
  await execFile("tar", ["-xzf", tarballPath, "-C", extractDir], {
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function runPublishDryRun(
  extractedPackageDir: string,
  packageJson: {
    name?: string;
    version?: string;
    license?: string;
    bin?: Record<string, string>;
    files?: string[];
    publishConfig?: { access?: string };
    engines?: { node?: string };
  },
  dryRunVersion: string
): Promise<string> {
  const packageJsonPath = path.join(extractedPackageDir, "package.json");
  const dryRunPackageJson = {
    ...packageJson,
    version: dryRunVersion,
  };
  await writeFile(packageJsonPath, `${JSON.stringify(dryRunPackageJson, null, 2)}\n`, "utf8");
  const { stdout, stderr } = await execFile(
    "npm",
    ["publish", "--access", "public", "--dry-run", "--ignore-scripts", "--tag", "dryrun"],
    {
      cwd: extractedPackageDir,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
      killSignal: "SIGTERM",
    }
  );
  return `${stdout}\n${stderr}`;
}

function createDryRunVersion(version: string): string {
  const sanitizedVersion = version.split("+")[0] ?? version;
  const suffix = `${Date.now()}${process.pid}`;
  return sanitizedVersion.includes("-")
    ? `${sanitizedVersion}.dryrun.${suffix}`
    : `${sanitizedVersion}-dryrun.${suffix}`;
}

async function readSourceCliPackageJson(workspaceRoot: string): Promise<{ version?: string }> {
  const packageJsonPath = path.join(workspaceRoot, "packages/cli/package.json");
  return JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
}

async function runNodeCommand(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFile(process.execPath, args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
  });
  return `${stdout}\n${stderr}`;
}

async function recordCheck<T extends { status: "passed" | "failed"; details: string[] }>(
  checks: ReleaseReadinessCheckResult[],
  checkId: string,
  title: string,
  run: () => Promise<T>
): Promise<(T & ReleaseReadinessCheckResult) | null> {
  try {
    const result = await run();
    const record = {
      checkId,
      title,
      ...result,
    };
    checks.push(record);
    return record;
  } catch (error) {
    const record = {
      checkId,
      title,
      status: "failed" as const,
      details: [error instanceof Error ? error.message : String(error)],
    };
    checks.push(record);
    return null;
  }
}

function finalizeReleaseReadinessResult(
  checks: ReleaseReadinessCheckResult[],
  artifact: ReleaseReadinessArtifact | null
): ReleaseReadinessResult {
  return {
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    totalChecks: checks.length,
    passedChecks: checks.filter((check) => check.status === "passed").length,
    failedChecks: checks.filter((check) => check.status === "failed").length,
    artifact,
    checks,
  };
}
