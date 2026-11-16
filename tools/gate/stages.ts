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

// Order matters: cheap checks fail first. Build and knip only run before a push,
// because a commit should be fast and declaration emit is not proof of correctness.
export const stages: readonly Stage[] = [
  {
    name: "lint",
    hooks: ["pre-commit", "pre-push"],
    run: ({ root, packages, all }) => [
      {
        cwd: root,
        argv: [
          binary(root, "oxlint"),
          ...(all ? ["packages", "tools/deploy", "tools/codegen"] : dirs(packages)),
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
          ...(all ? ["packages", "tools/deploy", "tools/codegen"] : dirs(packages)),
        ],
      },
    ],
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
      }
      return runs;
    },
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
    name: "build",
    hooks: ["pre-push"],
    run: ({ root, packages }) =>
      packages.map((pkg) => ({ cwd: root, argv: ["npm", "run", "build", "-w", pkg.name] })),
  },
  {
    name: "deploy",
    hooks: ["pre-push"],
    run: ({ root }) => [
      {
        cwd: join(root, "tools/deploy"),
        argv: [binary(root, "cf"), "deploy", "--dry-run", "--mode", "development"],
        env: {
          XDG_CONFIG_HOME: join(root, ".work/cf/config"),
          XDG_CACHE_HOME: join(root, ".cache"),
        },
      },
    ],
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