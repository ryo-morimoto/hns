import { defineConfig } from "tsdown";

export default defineConfig({
  // The edge's Trail lookup is its own entry (0272n): the Worker imports it by name, so the
  // package must build it, not only its index.
  entry: ["src/index.ts", "src/conversation-index/index.ts", "src/edge/trail-lookup.ts"],
  format: ["esm"],
  platform: "node",
  root: "src",
  dts: true,
  sourcemap: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
  exports: false,
  define: { "import.meta.vitest": "undefined" },
});
