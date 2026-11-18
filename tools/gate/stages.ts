/** The stage table: the one place a check is added, removed, reordered, or moved between hooks. */

import { join } from "node:path";
import type { PackageInfo } from "./select.ts";

/** The hook that triggers the gate. Each stage names the hooks it belongs to. */
export type Hook = "pre-commit" | "pre-push";

export interface Run {
  cwd: string;
  argv: string[];
  /** Extra environment for the child only. */
  env?: Record<string, string>;
}

/** Which tier the test stage runs: the commit only sees the in-process tests. */
export type Tier = "unit" | "all";

export interface StageContext {
  root: string;
  /** Affected packages, dependencies first. */
  packages: PackageInfo[];
  /** True when a root trigger or --all put every package in scope. */
  all: boolean;
  tier: Tier;
}

export interface Stage {
  name: string;
  hooks: readonly Hook[];
  run(context: StageContext): Run[];
}

const binary = (root: string, name: string): string => join(root, "node_modules", ".bin", name);

const dirs = (packages: PackageInfo[]): string[] => packages.map((pkg) => `packages/${pkg.dir}`);

/** Packages whose documents or model the GraphQL artifacts derive from. */
const CODEGEN_PACKAGES = ["web", "core", "server"];

// Order matters: cheap checks fail first, and build runs before test. The cf dev
// integration tests bundle packages from dist/, so on a fresh worktree the build must
// land before them; a commit still skips building because it runs the unit tests only.
export const stages: readonly Stage[] = [
  {
    name: "lint",
    hooks: ["pre-commit", "pre-push"],
    run: ({ root, packages, all }) => [
      {
        cwd: root,
        argv: [
          binary(root, "oxlint"),
          ...(all ? ["packages", "tools/deploy", "tools/codegen", "tools/test"] : dirs(packages)),
        ],
      },
    ],
  },
  {
    name: "fmt",
    hooks: ["pre-commit", "pre-push"],
    run: ({ root, packages, all }) => [
      {
        cwd: root,
        argv: [
          binary(root, "oxfmt"),
          "--check",
          ...(all ? ["packages", "tools/deploy", "tools/codegen", "tools/test"] : dirs(packages)),
        ],
      },
    ],
  },
  {
    name: "codegen",
    hooks: ["pre-commit", "pre-push"],
    // Regenerate before the code that reads the artifacts is checked, so a stale artifact cannot
    // pass. The work is skipped when the change cannot affect the schema or a document.
    run: ({ root, packages, all }) => {
      if (!all && !packages.some((pkg) => CODEGEN_PACKAGES.includes(pkg.dir))) return [];
      return [
        {
          cwd: root,
          argv: [process.execPath, "--conditions=source", "tools/codegen/graphql.ts"],
        },
        { cwd: root, argv: [binary(root, "relay-compiler")] },
        {
          cwd: root,
          argv: [process.execPath, "--conditions=source", "tools/codegen/verify.ts"],
        },
      ];
    },
  },
  {
    name: "typecheck",
    hooks: ["pre-commit", "pre-push"],
    run: ({ root, packages, all }) => {
      const runs: Run[] = packages.map((pkg) => ({
        cwd: join(root, "packages", pkg.dir),
        argv: [binary(root, "tsrs"), "--noEmit"],
      }));
      if (all) {
        runs.push({
          cwd: root,
          argv: [binary(root, "tsrs"), "--noEmit", "-p", "tools/gate/tsconfig.json"],
        });
        runs.push({
          cwd: root,
          argv: [binary(root, "tsrs"), "--noEmit", "-p", "tools/deploy/tsconfig.json"],
        });
        runs.push({
          cwd: root,
          argv: [binary(root, "tsrs"), "--noEmit", "-p", "tools/codegen/tsconfig.json"],
        });
        runs.push({
          cwd: root,
          argv: [binary(root, "tsrs"), "--noEmit", "-p", "tools/test/tsconfig.json"],
        });
      }
      return runs;
    },
  },
  {
    name: "build",
    hooks: ["pre-push"],
    run: ({ root, packages }) =>
      packages.map((pkg) => ({ cwd: root, argv: ["npm", "run", "build", "-w", pkg.name] })),
  },
  {
    name: "test",
    hooks: ["pre-commit", "pre-push"],
    run: ({ root, packages, tier }) => [
      {
        cwd: root,
        // A root trigger widens the packages but must not widen the tier at commit time.
        argv:
          tier === "all"
            ? [binary(root, "vitest"), "run"]
            : [binary(root, "vitest"), "run", ...packages.flatMap((pkg) => ["--project", pkg.dir])],
      },
    ],
  },
  {
    name: "deploy",
    hooks: ["pre-push"],
    // Both Workers are checked: the gateway's config is its own cf project because one
    // cloudflare.config.ts describes one Worker. The machine id is the dry run's placeholder: the
    // config requires it in every mode (0270n; a default would let a development Worker address a
    // machine the operator did not name), and this stage builds no Worker that would dial it.
    run: ({ root }) => {
      const env = {
        XDG_CONFIG_HOME: join(root, ".work/cf/config"),
        XDG_CACHE_HOME: join(root, ".cache"),
        HNS_MACHINE_ID: "machine-dry-run",
      };
      return ["tools/deploy", "tools/deploy/gateway"].map((dir) => ({
        cwd: join(root, dir),
        argv: [binary(root, "cf"), "deploy", "--dry-run", "--mode", "development"],
        env,
      }));
    },
  },
  {
    name: "knip",
    hooks: ["pre-push"],
    run: ({ root }) => [{ cwd: root, argv: [binary(root, "knip")] }],
  },
];

/** Stages that run for a hook, in table order. */
export const stagesFor = (hook: Hook): readonly Stage[] =>
  stages.filter((stage) => stage.hooks.includes(hook));

export const stageNamed = (name: string): Stage | undefined =>
  stages.find((stage) => stage.name === name);
