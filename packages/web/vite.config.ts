import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { relay } from "./vite.relay.ts";

// No server exists yet. The GraphQL endpoint adds its proxy when it lands.

export default defineConfig({
  // The relay plugin turns graphql tags into artifact imports; without it the tags throw.
  plugins: [relay(), react()],
  // resolve.conditions replaces Vite's client defaults, so repeat them and add "source" to read
  // @hns/core from its exports (the same files tsc and vitest resolve).
  resolve: {
    conditions: ["module", "browser", "development|production", "source"],
  },
});
