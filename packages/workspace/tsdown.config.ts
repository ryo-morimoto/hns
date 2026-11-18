import { defineConfig } from "tsdown";

export default defineConfig({
  // rooted-helper is spawned by path, not imported, so it needs its own entry.
  // This list is also the lint's entry list: knip reads tsdown's entries, so a
  // second copy in the root package.json's "knip" made the same file redundant.
  entry: [
    "src/index.ts",
    "src/checkpoint.ts",
    "src/mirror.ts",
    "src/mirror-push.ts",
    "src/objects.ts",
    "src/pack.ts",
    "src/sandbox.ts",
    "src/protocol.ts",
    "src/rooted-helper.ts",
  ],
  format: ["esm"],
  platform: "node",
  root: "src",
  dts: {
    entry: [
      "src/index.ts",
      "src/checkpoint.ts",
      "src/mirror.ts",
      "src/mirror-push.ts",
      "src/objects.ts",
      "src/pack.ts",
      "src/sandbox.ts",
      "src/protocol.ts",
    ],
  },
  sourcemap: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
  exports: false,
  define: { "import.meta.vitest": "undefined" },
});
