import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
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
