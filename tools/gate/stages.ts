/** The stage table: the one place a check is added, removed, or reordered. */

import { join } from "node:path";
import type { PackageInfo } from "./select.ts";

export interface Run {
  cwd: string;
  argv: string[];
}

export interface StageContext {
  root: string;
  /** Affected packages, dependencies first. */
  packages: PackageInfo[];
  /** True when a root trigger or --all put every package in scope. */
  all: boolean;
}

export interface Stage {
  name: string;
  run(context: StageContext): Run[];
}

const binary = (root: string, name: string): string => join(root, "node_modules", ".bin", name);

const dirs = (packages: PackageInfo[]): string[] => packages.map((pkg) => `packages/${pkg.dir}`);

// Order matters: cheap checks fail first, build last, knip after everything.
export const stages: readonly Stage[] = [
  {
    name: "lint",
    run: ({ root, packages, all }) => [
      { cwd: root, argv: [binary(root, "oxlint"), ...(all ? ["packages"] : dirs(packages))] },
    ],
  },
  {
    name: "fmt",
    run: ({ root, packages, all }) => [
      {
        cwd: root,
        argv: [binary(root, "oxfmt"), "--check", ...(all ? ["packages"] : dirs(packages))],
      },
    ],
  },
  {
    name: "typecheck",
    run: ({ root, packages, all }) => {
      const runs: Run[] = packages.map((pkg) => ({
        cwd: join(root, "packages", pkg.dir),
        argv: [binary(root, "tsrs"), "--noEmit"],
      }));
      if (all) runs.push({ cwd: root, argv: [binary(root, "tsrs"), "--noEmit", "-p", "tools/gate/tsconfig.json"] });
      return runs;
    },
  },
  {
    name: "test",
    run: ({ root, packages, all }) => [
      {
        cwd: root,
        argv: all
          ? [binary(root, "vitest"), "run"]
          : [
              binary(root, "vitest"),
              "run",
              ...packages.flatMap((pkg) => ["--project", pkg.dir]),
            ],
      },
    ],
  },
  {
    name: "build",
    run: ({ root, packages }) =>
      packages.map((pkg) => ({ cwd: root, argv: ["npm", "run", "build", "-w", pkg.name] })),
  },
  {
    name: "knip",
    run: ({ root }) => [{ cwd: root, argv: [binary(root, "knip")] }],
  },
];
