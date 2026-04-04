import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "extension/service-worker": "src/extension-service-worker-entry.ts",
    "extension/content-script": "src/extension-content-script-entry.ts",
  },
  format: ["esm"],
  platform: "browser",
  target: "chrome120",
  outDir: "dist",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
  define: {
    __TURNKEYAI_RELAY_DAEMON_URL__: JSON.stringify(process.env.TURNKEYAI_RELAY_DAEMON_URL ?? ""),
  },
});
