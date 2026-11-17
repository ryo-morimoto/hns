import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { relay } from "./packages/web/vite.relay.ts";
import { doctest } from "vite-plugin-doctest";

// One runner for every layer (docs/testing.md). A project per package keeps
// `npm test -w @hns/store` scoped to that package instead of the whole repo.
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** One path alias: a module pattern and the source file it resolves to. */
interface SourceAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

// Tests import packages by name; resolve them to src so a test run never needs a build first.
const alias: readonly SourceAlias[] = [
  { find: /^@hns\/core$/, replacement: source("./packages/core/src/index.ts") },
  {
    find: /^@hns\/core\/graphql$/,
    replacement: source("./packages/core/src/graphql/index.ts"),
  },
  {
    find: /^@hns\/core\/capability$/,
    replacement: source("./packages/core/src/capability/index.ts"),
  },
  { find: /^@hns\/record$/, replacement: source("./packages/record/src/index.ts") },
  { find: /^@hns\/store$/, replacement: source("./packages/store/src/index.ts") },
  {
    find: /^@hns\/store\/conversation-index$/,
    replacement: source("./packages/store/src/conversation-index/index.ts"),
  },
  { find: /^@hns\/workspace$/, replacement: source("./packages/workspace/src/index.ts") },
  {
    // The checkpoint's subpath runs git; without this alias it falls back to a dist build, and a
    // test would then exercise whatever the last build produced instead of the source.
    find: /^@hns\/workspace\/checkpoint$/,
    replacement: source("./packages/workspace/src/checkpoint.ts"),
  },
  {
    find: /^@hns\/workspace\/sandbox$/,
    replacement: source("./packages/workspace/src/sandbox.ts"),
  },
  {
    // The pack's key is the object store's, so the Workspace object reads it from there rather
    // than spelling `checkpoints/<commit>.pack` a second time.
    find: /^@hns\/workspace\/objects$/,
    replacement: source("./packages/workspace/src/objects.ts"),
  },
  {
    // The pack reader is its own subpath because it imports node:zlib; the root entry stays free
    // of it so the Worker-facing imports keep working.
    find: /^@hns\/workspace\/pack$/,
    replacement: source("./packages/workspace/src/pack.ts"),
  },
  {
    // The mirror's rules are pure (no node:), so the Worker imports them from the root entry's
    // neighbour rather than through the push, which spawns git.
    find: /^@hns\/workspace\/mirror$/,
    replacement: source("./packages/workspace/src/mirror.ts"),
  },
  {
    // The push spawns git, so it is its own subpath like the checkpoint. The alias is the file
    // name, not the export path: a pattern can hold \/ and "push", not a nested export key.
    find: /^@hns\/workspace\/mirror-push$/,
    replacement: source("./packages/workspace/src/mirror-push.ts"),
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
const packageProjects = (name: string) => [
  {
    extends: true,
    test: {
      name,
      include: [`packages/${name}/src/**/*.test.ts`, `packages/${name}/src/**/*.test.tsx`],
      includeSource: [`packages/${name}/src/**/*.{ts,tsx}`],
      exclude: ["**/integration/**"],
    },
  },
  {
    extends: true,
    test: {
      name: `${name}-integration`,
      include: [`packages/${name}/test/integration/**/*.test.{ts,tsx}`],
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
      // The web project runs in a DOM with its test setup; the relay plugin compiles its graphql
      // tags with the same one the bundle uses.
      {
        extends: true,
        plugins: [relay()],
        test: {
          name: "web",
          include: ["packages/web/src/**/*.test.{ts,tsx}"],
          includeSource: ["packages/web/src/**/*.{ts,tsx}"],
          exclude: ["**/integration/**"],
          environment: "jsdom",
          setupFiles: ["packages/web/test/setup.ts"],
        },
      },
      {
        extends: true,
        plugins: [relay()],
        test: {
          name: "web-integration",
          include: ["packages/web/test/integration/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["packages/web/test/setup.ts"],
        },
      },
      { extends: true, test: { name: "tools", include: ["tools/**/*.test.ts"] } },
    ],
  },
});
