import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDesktopReleaseTag,
  parseDesktopReleaseArgs,
  parseRemoteTagTarget,
} from "./release-tag-lib.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

function printHelp() {
  console.info(`Usage: npm run desktop:release -- [options]

Without --push, this command only runs release preflight checks.

Options:
  --push           Push the current branch and desktop-v<version> tag
  --remote=<name>  Git remote to publish to (default: origin)
  --allow-dirty    Tag committed HEAD even if unrelated local work is present
  --skip-checks    Skip desktop tests and typechecking
  --help           Show this help`);
}

function gitOutput(args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
}

const options = parseDesktopReleaseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const head = gitOutput(["rev-parse", "HEAD"]);
const packageJson = JSON.parse(
  gitOutput(["show", "HEAD:packages/desktop/package.json"])
);
const tag = buildDesktopReleaseTag(packageJson.version);
const dirtyState = gitOutput(["status", "--porcelain"]);

if (dirtyState && !options.allowDirty) {
  throw new Error(
    "Working tree is not clean. Commit/stash changes, or pass --allow-dirty to tag committed HEAD intentionally."
  );
}
if (dirtyState) {
  console.warn("[desktop-release] warning: local changes are not included in the release tag");
}

run(process.execPath, [
  path.join(desktopDir, "scripts", "verify-release-version.mjs"),
  tag,
]);
if (!options.skipChecks) {
  run("npm", ["run", "test", "--workspace", "@turnkeyai/desktop"]);
  run("npm", ["run", "typecheck", "--workspace", "@turnkeyai/desktop"]);
}

const localTarget = gitOutput(["rev-list", "-n", "1", `refs/tags/${tag}`], true);
if (localTarget && localTarget !== head) {
  throw new Error(`Local tag ${tag} already points to ${localTarget}, not HEAD ${head}`);
}

const remoteOutput = gitOutput([
  "ls-remote",
  "--tags",
  options.remote,
  `refs/tags/${tag}`,
  `refs/tags/${tag}^{}`,
]);
const remoteTarget = parseRemoteTagTarget(remoteOutput ?? "", tag);
if (remoteTarget && remoteTarget !== head) {
  throw new Error(`Remote tag ${tag} already points to ${remoteTarget}, not HEAD ${head}`);
}
if (remoteTarget === head) {
  console.info(`[desktop-release] ${tag} already exists on ${options.remote} at ${head}`);
  process.exit(0);
}

if (!options.push) {
  console.info(`[desktop-release] preflight passed for ${tag} at ${head}`);
  console.info("[desktop-release] publish with: npm run desktop:release -- --push");
  process.exit(0);
}

const branch = gitOutput(["branch", "--show-current"]);
if (!branch) throw new Error("Cannot publish a desktop release from detached HEAD");

run("git", ["push", "--set-upstream", options.remote, `HEAD:refs/heads/${branch}`]);
if (!localTarget) {
  run("git", [
    "tag",
    "--annotate",
    tag,
    "--message",
    `TurnkeyAI Desktop ${packageJson.version}`,
    head,
  ]);
}
run("git", ["push", options.remote, `refs/tags/${tag}`]);

console.info(`[desktop-release] published ${tag} at ${head}`);
console.info(`[desktop-release] GitHub Actions will build and publish the DMGs`);
