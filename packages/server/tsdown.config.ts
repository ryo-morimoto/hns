import { defineConfig } from "tsdown";

export default defineConfig({
  // The edge and the checkpoint face are mounted by a worker other than the deploy's own
  // entrypoint (the checkpoint integration test builds exactly that), so they are entries.
  entry: [
    "src/index.ts",
    "src/graphql/index.ts",
    "src/edge/handler.ts",
    "src/checkpoint/face.ts",
    "src/machines/index.ts",
    "src/obs/index.ts",
  ],
  format: ["esm"],
  platform: "neutral",
  root: "src",
  dts: true,
  sourcemap: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
  exports: false,
  define: { "import.meta.vitest": "undefined" },
});
