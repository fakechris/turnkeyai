import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build config for the Control Center dashboard.
//
// `base: "/app/"` matters because the daemon serves the bundle at /app and
// /app/* — index.html's <script src=...> and stylesheet hrefs need to be
// generated as /app/assets/foo.js, NOT /assets/foo.js. Without this, the
// browser would request /assets/foo.js which the daemon's control-center
// route handler doesn't claim, returning a 404.
//
// `build.outDir: "dist"` is the default; we declare it explicitly because
// the CLI's post-build copy-control-center.mjs script reads from
// packages/control-center/dist and copies into packages/cli/dist/control-center.
//
// `build.assetsDir: "assets"` is also the default — keeps the URL shape
// stable in case the CLI dist-copy ever needs to mirror a specific layout.
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    sourcemap: true,
    // Inline very small assets but otherwise let Vite emit them as separate
    // files so the daemon can cache + serve them with proper content-types.
    assetsInlineLimit: 1024,
  },
  // The control center talks to the SAME daemon that served it (`window.location.origin`).
  // No proxy needed because the dev `vite` server isn't the production path;
  // production is always daemon-served. For local component iteration, a dev
  // proxy would point at the daemon — left out of MVP.
  server: {
    port: 5173,
    strictPort: false,
  },
});
