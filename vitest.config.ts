import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// One runner for every layer (docs/testing.md). A project per package keeps
// `npm test -w @hns/store` scoped to that package instead of the whole repo.
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Tests import packages by name; resolve them to src so a test run never needs a build first.
const alias = [
  { find: /^@hns\/core$/, replacement: source("./packages/core/src/index.ts") },
  { find: /^@hns\/store$/, replacement: source("./packages/store/src/index.ts") },
  { find: /^@hns\/workspace$/, replacement: source("./packages/workspace/src/index.ts") },
  {
    find: /^@hns\/workspace\/sandbox$/,
    replacement: source("./packages/workspace/src/sandbox.ts"),
  },
  { find: /^@hns\/agent$/, replacement: source("./packages/agent/src/index.ts") },
];

export default defineConfig({
  resolve: {
    // Packages export their source under this condition; Vite must read the same files tsc does.
    conditions: ["source"],
    alias,
  },
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      { extends: true, test: { name: "core", include: ["packages/core/test/**/*.test.ts"] } },
      { extends: true, test: { name: "store", include: ["packages/store/test/**/*.test.ts"] } },
      {
        extends: true,
        test: { name: "workspace", include: ["packages/workspace/test/**/*.test.ts"] },
      },
      { extends: true, test: { name: "agent", include: ["packages/agent/test/**/*.test.ts"] } },
      { extends: true, test: { name: "server", include: ["packages/server/test/**/*.test.ts"] } },
      { extends: true, test: { name: "web", include: ["packages/web/test/**/*.test.ts"] } },
    ],
  },
});
