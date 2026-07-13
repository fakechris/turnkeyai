import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    daemon: "../app-gateway/src/daemon.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist/runtime",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  external: ["playwright-core"],
  noExternal: ["@turnkeyai/shared-utils"],
});
