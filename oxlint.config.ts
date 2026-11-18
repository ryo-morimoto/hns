import { defineConfig } from "oxlint";

// Vendored from https://github.com/dmmulroy/anti-slop (MIT). See tools/oxlint/anti-slop/.
// PoC code under work/ is historical and excluded; product code is packages/ and apps/.
// `require-readable-spacing` is disabled: oxfmt owns whitespace, and the two disagree on blank lines.
export default defineConfig({
  ignorePatterns: [".work/**", "node_modules/**", "work/**", "tools/oxlint/anti-slop/**"],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  // Dependency direction from docs/packages.md. A package may import only the @hns/*
  // entries on its row; add a package or edge here and in that table together (0042).
  overrides: [
    {
      // Core's own tests are the one place an @hns import is allowed: 0234's "the production parts
      // against each other" test reads the workspace's version function, so the two packages'
      // spellings of a content hash are compared rather than copied. Production code in core still
      // takes the block below, which has no exception.
      files: ["packages/core/**/*.ts"],
      excludeFiles: ["packages/core/**/*.test.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              { group: ["@hns/*"], message: "core depends on no @hns package (docs/packages.md)" },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/record/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@hns/*", "!@hns/core"],
                message: "record may import core only (docs/packages.md)",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/store/**/*.ts", "packages/workspace/**/*.ts", "packages/web/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@hns/*", "!@hns/core"],
                message: "only @hns/core is allowed here (docs/packages.md)",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/agent/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@hns/*", "!@hns/core", "!@hns/workspace"],
                message: "agent may import core and workspace only (docs/packages.md)",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/machine/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@hns/*", "!@hns/core", "!@hns/workspace"],
                message: "machine may import core and workspace only (docs/packages.md)",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/server/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@hns/*", "!@hns/core", "!@hns/agent", "!@hns/store", "!@hns/workspace"],
                message:
                  "server may import core, agent, store, and workspace only (docs/packages.md)",
              },
            ],
          },
        ],
      },
    },
    {
      // The Session object writes the index through the narrow subpath and reads no control
      // data (0145's index exception, D078). The root would hand it every repository.
      files: ["packages/server/src/do/session-index.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["@hns/store"],
                message:
                  "the Session index uses @hns/store/conversation-index only (docs/durability.md)",
              },
            ],
          },
        ],
      },
    },
  ],
});
