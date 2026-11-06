import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies /api to the local server; VITE_HNS_FIXTURES=1 bypasses it entirely.
const api = process.env["HNS_API"] ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  // resolve.conditions replaces Vite's client defaults, so repeat them and add "source" to read
  // @hns/core from its exports (the same files tsc and vitest resolve).
  resolve: {
    conditions: ["module", "browser", "development|production", "source"],
  },
  server: { proxy: { "/api": { target: api } } },
});
