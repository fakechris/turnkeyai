import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
let startUrl = "https://example.com";
let profileDir: string | null = null;
let chromePath: string | null = null;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--url") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --url");
    }
    startUrl = value;
    index += 1;
    continue;
  }
  if (arg === "--profile-dir") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --profile-dir");
    }
    profileDir = path.resolve(process.cwd(), value);
    index += 1;
    continue;
  }
  if (arg === "--chrome-path") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --chrome-path");
    }
    chromePath = value;
    index += 1;
    continue;
  }
}

const extensionDir = path.resolve(process.cwd(), "packages/browser-relay-peer/dist/extension");
await access(path.join(extensionDir, "manifest.json"));

const resolvedChromePath = await resolveChromePath(chromePath ?? process.env.TURNKEYAI_BROWSER_PATH);
const resolvedProfileDir =
  profileDir ?? path.join(os.tmpdir(), "turnkeyai-relay-chrome-profile");

await mkdir(resolvedProfileDir, { recursive: true });

const launchArgs = [
  `--user-data-dir=${resolvedProfileDir}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  startUrl,
];

const child = spawn(resolvedChromePath, launchArgs, {
  detached: true,
  stdio: "ignore",
});
child.unref();

console.log(`launched Chrome relay smoke browser`);
console.log(`chrome: ${resolvedChromePath}`);
console.log(`extension: ${extensionDir}`);
console.log(`profile: ${resolvedProfileDir}`);
console.log(`url: ${startUrl}`);
console.log(`next: start daemon with TURNKEYAI_BROWSER_TRANSPORT=relay and inspect relay-peers / relay-targets`);

async function resolveChromePath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error("no local Chrome executable found; pass --chrome-path or set TURNKEYAI_BROWSER_PATH");
}
