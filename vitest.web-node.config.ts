import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { relay } from "./packages/web/vite.relay.ts";

/**
 * The office preview's test over a real machine and a real pack, run by hand.
 *
 * @remarks
 * `vitest.config.ts`'s `web-integration` project runs with a `browser` condition, which resolves
 * `@earendil-works/pi-durable` to a source entry the published package does not ship; this project
 * runs under `node`, which is how every server and machine integration test runs. It is loaded
 * only when named (`--config vitest.web-node.config.ts`), because it needs the office pack, which
 * tools/office-pack/build.sh builds on a host with bubblewrap and Mesa.
 *
 * The aliases are `vitest.config.ts`'s: the same files, the same resolution.
 */
const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ["source"],
    alias: [
      { find: /^@hns\/core\/office$/, replacement: source("./packages/core/src/office.ts") },
      {
        find: /^@hns\/core\/graphql$/,
        replacement: source("./packages/core/src/graphql/index.ts"),
      },
      {
        find: /^@hns\/core\/capability$/,
        replacement: source("./packages/core/src/capability/index.ts"),
      },
      { find: /^@hns\/core$/, replacement: source("./packages/core/src/index.ts") },
      { find: /^@hns\/record$/, replacement: source("./packages/record/src/index.ts") },
      { find: /^@hns\/store$/, replacement: source("./packages/store/src/index.ts") },
      {
        find: /^@hns\/store\/conversation-index$/,
        replacement: source("./packages/store/src/conversation-index/index.ts"),
      },
      {
        find: /^@hns\/store\/edge$/,
        replacement: source("./packages/store/src/edge/trail-lookup.ts"),
      },
      { find: /^@hns\/workspace$/, replacement: source("./packages/workspace/src/index.ts") },
      {
        find: /^@hns\/workspace\/checkpoint$/,
        replacement: source("./packages/workspace/src/checkpoint.ts"),
      },
      {
        find: /^@hns\/workspace\/sandbox$/,
        replacement: source("./packages/workspace/src/sandbox.ts"),
      },
      {
        find: /^@hns\/workspace\/protocol$/,
        replacement: source("./packages/workspace/src/protocol.ts"),
      },
      {
        find: /^@hns\/workspace\/objects$/,
        replacement: source("./packages/workspace/src/objects.ts"),
      },
      { find: /^@hns\/workspace\/pack$/, replacement: source("./packages/workspace/src/pack.ts") },
      {
        find: /^@hns\/workspace\/mirror$/,
        replacement: source("./packages/workspace/src/mirror.ts"),
      },
      {
        find: /^@hns\/workspace\/mirror-push$/,
        replacement: source("./packages/workspace/src/mirror-push.ts"),
      },
      { find: /^@hns\/agent$/, replacement: source("./packages/agent/src/index.ts") },
      { find: /^@hns\/agent\/session$/, replacement: source("./packages/agent/src/session.ts") },
      { find: /^@hns\/machine$/, replacement: source("./packages/machine/src/index.ts") },
      { find: /^@hns\/server$/, replacement: source("./packages/server/src/index.ts") },
      {
        find: /^@hns\/server\/graphql$/,
        replacement: source("./packages/server/src/graphql/index.ts"),
      },
      { find: /^@hns\/server\/obs$/, replacement: source("./packages/server/src/obs/index.ts") },
    ],
  },
  plugins: [relay()],
  test: {
    name: "web-node",
    include: ["packages/web/test/node/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
