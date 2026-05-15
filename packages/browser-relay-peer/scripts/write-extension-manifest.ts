import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { buildChromeRelayExtensionManifest } from "../src/chrome-extension-manifest";

const outputDir = path.join(import.meta.dirname, "..", "dist", "extension");
const manifestPath = path.join(outputDir, "manifest.json");
const assetsDir = path.join(import.meta.dirname, "..", "assets");

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const daemonOrigin = process.env.TURNKEYAI_RELAY_DAEMON_URL?.trim()
    ? `${process.env.TURNKEYAI_RELAY_DAEMON_URL.trim().replace(/\/+$/, "")}/*`
    : undefined;
  const manifest = buildChromeRelayExtensionManifest({
    version: packageJson.version,
    matches: ["http://*/*", "https://*/*"],
    ...(daemonOrigin ? { daemonOrigins: [daemonOrigin] } : {}),
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.info(`wrote ${manifestPath}`);
  await copyFile(path.join(assetsDir, "popup.html"), path.join(outputDir, "popup.html"));
  console.info(`copied popup.html`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
