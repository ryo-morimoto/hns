import { defineConfig } from "tsdown";

export default defineConfig({
  // rooted-helper is spawned by path, not imported, so it needs its own entry.
  entry: ["src/index.ts", "src/sandbox.ts", "src/rooted-helper.ts"],
  format: ["esm"],
  platform: "node",
  root: "src",
  dts: { entry: ["src/index.ts", "src/objects.ts", "src/sandbox.ts"] },
  sourcemap: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
  exports: false,
  define: { "import.meta.vitest": "undefined" },
});
