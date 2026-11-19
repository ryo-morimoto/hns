import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import { relay } from "./packages/web/vite.relay.ts";
import { doctest } from "vite-plugin-doctest";
import webNode from "./vitest.web-node.config.ts";

// One runner for every layer (docs/testing.md). A project per package keeps
// `npm test -w @hns/store` scoped to that package instead of the whole repo.
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Build the web app before its project runs.
 *
 * @returns A plugin whose `buildStart` runs the app's own build once.
 *
 * @remarks
 * One web test asserts **what the build ships** (the bundle, the PDF.js worker, the page's own
 * script): a worker that never reaches `deploy/assets` is a preview that dies in production, and
 * a stale directory would let that test pass on an older build. The build is the app's
 * `npm run build` — the same command the gate's build stage runs — and it is skipped where the
 * output is already newer than every file it is made from.
 */
function webBuild(): Plugin {
  return {
    name: "hns-web-build",
    buildStart() {
      execFileSync("npm", ["run", "build", "--silent"], {
        cwd: source("./packages/web"),
        stdio: "pipe",
      });
    },
  };
}

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
  {
    // The office contract (0234): four lanes import it, and a test must read the source rather
    // than whatever the last build left in dist/.
    find: /^@hns\/core\/office$/,
    replacement: source("./packages/core/src/office.ts"),
  },
  { find: /^@hns\/record$/, replacement: source("./packages/record/src/index.ts") },
  { find: /^@hns\/store$/, replacement: source("./packages/store/src/index.ts") },
  {
    find: /^@hns\/store\/conversation-index$/,
    replacement: source("./packages/store/src/conversation-index/index.ts"),
  },
  {
    // The Trail lookup the Workspace object is started with (0272n): the edge reads the store
    // through it, so a test reaches the source rather than a dist build.
    find: /^@hns\/store\/edge$/,
    replacement: source("./packages/store/src/edge/trail-lookup.ts"),
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
    // The granted call's wire: one envelope the Session object relays and the machine parses, so the
    // two sides cannot drift. It imports only core, so every package may read it.
    find: /^@hns\/workspace\/protocol$/,
    replacement: source("./packages/workspace/src/protocol.ts"),
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
  {
    find: /^@hns\/server\/obs$/,
    replacement: source("./packages/server/src/obs/index.ts"),
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
      include: [
        `packages/${name}/test/integration/**/*.test.{ts,tsx}`,
        `packages/${name}/test/security/**/*.test.{ts,tsx}`,
      ],
      // A suite that starts cf dev takes a machine-wide lock (tools/test/cf-dev.ts), so running
      // two of them at once only makes the second queue behind the first. They are rare and short;
      // one file at a time keeps the lock from timing out under a full check.
      fileParallelism: false,
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
        plugins: [webBuild(), relay()],
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
      // The office preview's real-machine test runs under node conditions and needs the pack;
      // it is loaded only when named, so a full run never builds one (its file says how).
      webNode,
    ],
  },
});
