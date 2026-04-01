import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    daemon: "../app-gateway/src/daemon.ts",
    tui: "../tui/src/tui.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  external: ["playwright-core"],
});
