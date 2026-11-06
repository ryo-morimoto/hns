import { defineConfig } from "vitest/config";

// One runner for every layer (docs/testing.md). A project per package keeps
// `npm test -w @hns/store` scoped to that package instead of the whole repo.
export default defineConfig({
  resolve: {
    // Packages export their source under this condition; Vite must read the same files tsc does.
    conditions: ["source"],
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
