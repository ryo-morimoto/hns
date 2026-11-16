import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { relay } from "./packages/web/vite.relay.ts";
import { doctest } from "vite-plugin-doctest";

// One runner for every layer (docs/testing.md). A project per package keeps
// `npm test -w @hns/store` scoped to that package instead of the whole repo.
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Tests import packages by name; resolve them to src so a test run never needs a build first.
const alias = [
  { find: /^@hns\/core$/, replacement: source("./packages/core/src/index.ts") },
  {
    find: /^@hns\/core\/graphql$/,
    replacement: source("./packages/core/src/graphql/index.ts"),
  },
  { find: /^@hns\/record$/, replacement: source("./packages/record/src/index.ts") },
  { find: /^@hns\/store$/, replacement: source("./packages/store/src/index.ts") },
  { find: /^@hns\/workspace$/, replacement: source("./packages/workspace/src/index.ts") },
  {
    find: /^@hns\/workspace\/sandbox$/,
    replacement: source("./packages/workspace/src/sandbox.ts"),
  },
  { find: /^@hns\/agent$/, replacement: source("./packages/agent/src/index.ts") },
  {
    find: /^@hns\/agent\/session$/,
    replacement: source("./packages/agent/src/session.ts"),
  },
  { find: /^@hns\/machine$/, replacement: source("./packages/machine/src/index.ts") },
  { find: /^@hns\/server$/, replacement: source("./packages/server/src/index.ts") },
  {
    find: /^@hns\/server\/graphql$/,
    replacement: source("./packages/server/src/graphql/index.ts"),
  },
];

// Two projects per package: the in-process tests a commit runs, and the
// integration tests that spawn a helper, a daemon, or bubblewrap. A scenario
// runs in exactly one project.
const packageProjects = (name: string, extra: Record<string, unknown> = {}) => [
  {
    extends: true,
    test: {
      name,
      include: [
        `packages/${name}/src/**/*.test.ts`,
        `packages/${name}/src/**/*.test.tsx`,
      ],
      includeSource: [`packages/${name}/src/**/*.{ts,tsx}`],
      exclude: ["**/integration/**"],
      ...extra,
    },
  },
  {
    extends: true,
    test: {
      name: `${name}-integration`,
      include: [`packages/${name}/test/integration/**/*.test.{ts,tsx}`],
      ...extra,
    },
  },
];

export default defineConfig({
  plugins: [doctest()],
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
      ...packageProjects("core"),
      ...packageProjects("record"),
      ...packageProjects("store"),
      ...packageProjects("workspace"),
      ...packageProjects("agent"),
      ...packageProjects("machine"),
      ...packageProjects("server"),
      ...packageProjects("web", {
        environment: "jsdom",
        setupFiles: ["packages/web/test/setup.ts"],
      }).map((project) => ({
        ...project,
        // The web project compiles graphql tags with the same babel plugin the bundle uses.
        plugins: [relay()],
      })),
      { extends: true, test: { name: "tools", include: ["tools/**/*.test.ts"] } },
    ],
  },
});