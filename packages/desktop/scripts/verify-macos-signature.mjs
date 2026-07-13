import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("macOS signature verification must run on macOS");
}

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const artifactDirArg = args.find((arg) => !arg.startsWith("--"));
const artifactDir = path.resolve(artifactDirArg ?? path.join(desktopDir, "dist", "release"));
const requiredArchitectures = args
  .filter((arg) => arg.startsWith("--require-arch="))
  .map((arg) => arg.slice("--require-arch=".length));
const supportedArchitectures = new Set(["arm64", "x86_64"]);
for (const architecture of requiredArchitectures) {
  if (!supportedArchitectures.has(architecture)) {
    throw new Error(`Unsupported required architecture: ${architecture}`);
  }
}

async function findApps(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      found.push(fullPath);
    } else if (entry.isDirectory()) {
      found.push(...(await findApps(fullPath)));
    }
  }
  return found;
}

function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
  return { status: result.status ?? 1, output };
}

const apps = await findApps(artifactDir);
if (apps.length === 0) throw new Error(`No .app bundles found below ${artifactDir}`);

const observedArchitectures = new Set();
for (const app of apps.sort()) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const details = run("codesign", ["-dv", "--verbose=4", app]).output;
  if (!details.includes("Signature=adhoc")) {
    throw new Error(`Expected an ad-hoc signature for ${app}:\n${details}`);
  }
  if (!details.includes("TeamIdentifier=not set")) {
    throw new Error(`Expected no Apple TeamIdentifier for ${app}:\n${details}`);
  }

  const executable = path.join(app, "Contents", "MacOS", "TurnkeyAI");
  const architectures = run("lipo", ["-archs", executable]).output;
  for (const architecture of architectures.split(/\s+/).filter(Boolean)) {
    observedArchitectures.add(architecture);
  }
  const gatekeeper = run("spctl", ["--assess", "--type", "execute", "--verbose=4", app], true);
  console.info(`[desktop] verified ad-hoc signature: ${app}`);
  console.info(`[desktop] architectures: ${architectures}`);
  console.info(
    `[desktop] Gatekeeper assessment: ${gatekeeper.status === 0 ? "accepted" : "rejected as expected for an unnotarized ad-hoc build"}`
  );
}

const artifactNames = await readdir(artifactDir);
for (const architecture of requiredArchitectures) {
  if (!observedArchitectures.has(architecture)) {
    throw new Error(`Required architecture was not found in any app bundle: ${architecture}`);
  }
  const artifactArchitecture = architecture === "x86_64" ? "x64" : architecture;
  if (!artifactNames.some((name) => name.endsWith(`-${artifactArchitecture}.dmg`))) {
    throw new Error(`Required DMG artifact was not found for architecture: ${architecture}`);
  }
}
