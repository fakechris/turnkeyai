import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "src/main.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist/app",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  external: ["electron"],
  noExternal: ["@turnkeyai/shared-utils"],
});
