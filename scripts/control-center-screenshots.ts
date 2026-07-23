/*
 * Control Center design-baseline screenshots.
 *
 * Renders every main Control Center surface (Chat entry, Team, Settings, and
 * the Mission detail three-pane — desktop + mobile) to PNGs so UI/theme work
 * can be eyeballed and regressions caught. It reuses the control-center UI
 * smoke harness for rendering: that harness already ships a mock backend
 * (fixtures for every API) and injects a session token, so no daemon, LLM, or
 * network is needed. Keeping one source of fixtures avoids drift between the
 * smoke test and these baselines.
 *
 * Usage:
 *   npm run control-center:screenshots                  # build + render to .artifacts/
 *   npm run control-center:screenshots -- --skip-build  # reuse existing dist
 *   npm run control-center:screenshots -- --out-dir /tmp/shots --browser-path "/path/to/Chrome"
 *
 * Note: the smoke harness stubs the Google Fonts request, so screenshots use
 * the system sans fallback rather than the bundled IBM Plex webfont. Layout,
 * color, radius, and spacing are faithful; exact glyph shapes are not.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

interface Options {
  outDir: string;
  skipBuild: boolean;
  browserPath?: string;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  let outDir = ".artifacts/control-center-screenshots";
  let skipBuild = false;
  let browserPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") {
      outDir = requireValue(argv[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg === "--browser-path") {
      browserPath = requireValue(argv[index + 1], arg);
      index += 1;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { outDir, skipBuild, browserPath };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const outDir = path.resolve(process.cwd(), options.outDir);
await mkdir(outDir, { recursive: true });

if (!options.skipBuild) {
  console.log("control-center-screenshots: building control center…");
  await run("npm", ["run", "build:control-center"]);
}

console.log(`control-center-screenshots: rendering surfaces → ${outDir}`);
const smokeArgs = ["run", "control-center:smoke", "--", "--artifact-dir", outDir];
if (options.browserPath) {
  smokeArgs.push("--browser-path", options.browserPath);
}
await run("npm", smokeArgs);

const shots = (await readdir(outDir)).filter((file) => file.endsWith(".png")).sort();
if (shots.length === 0) {
  throw new Error(`no screenshots were written to ${outDir}`);
}
console.log(`control-center-screenshots: wrote ${shots.length} screenshots`);
for (const shot of shots) {
  console.log(`  ${path.join(options.outDir, shot)}`);
}
