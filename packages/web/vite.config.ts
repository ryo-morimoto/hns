import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { proxyFor } from "./vite.proxy.ts";
import { relay } from "./vite.relay.ts";

// The web build is the Worker's static asset directory; cf serves it through ASSETS (D094).
export default defineConfig({
  // The relay plugin turns graphql tags into artifact imports; without it the tags throw.
  plugins: [relay(), react()],
  // resolve.conditions replaces Vite's client defaults, so repeat them and add "source" to read
  // @hns/core from its exports (the same files tsc and vitest resolve).
  resolve: {
    conditions: ["module", "browser", "development|production", "source"],
  },
  build: {
    outDir: "../../deploy/assets",
    emptyOutDir: true,
    assetsDir: "assets",
    // Production serves the hashed bundle only; no map is uploaded or reachable (D094).
    sourcemap: false,
  },
  // Same-origin in development, so the session cookie and the WebSocket behave as in production.
  server: {
    proxy: proxyFor(process.env.HNS_API),
  },
});
