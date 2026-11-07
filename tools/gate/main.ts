/** Commit gate: run the checks that the staged changes can break. */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orderByDependency, select } from "./select.ts";
import type { PackageInfo, Selection, StagedEntry } from "./select.ts";
import { stages } from "./stages.ts";

interface Manifest {
  name: string;
  hnsDependencies: string[];
}

const findRoot = (): { root: string; git: boolean } => {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    return { root, git: true };
  } catch {
    console.error("gate: not inside a git repository; every package is in scope");
    return { root: process.cwd(), git: false };
  }
};

const readManifest = (path: string): Manifest => {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: workspace manifest is not an object`);
  }
  const name = "name" in raw ? raw.name : undefined;
  if (typeof name !== "string") {
    throw new Error(`${path}: workspace manifest has no name`);
  }
  const dependencies = "dependencies" in raw ? raw.dependencies : undefined;
  const hnsDependencies =
    typeof dependencies === "object" && dependencies !== null
      ? Object.keys(dependencies).filter((key) => key.startsWith("@hns/"))
      : [];
  return { name, hnsDependencies };
};

const loadPackages = (root: string): PackageInfo[] =>
  readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((dir) => {
      const manifest = readManifest(join(root, "packages", dir, "package.json"));
      return { dir, name: manifest.name, dependsOn: manifest.hnsDependencies };
    });

/**
 * Staged entries only: the working tree may hold unrelated edits.
 * Renames arrive as R<score>\0old\0new; both paths are kept because a move
 * changes the package that lost the file as well as the one that gained it.
 */
const stagedEntries = (root: string): StagedEntry[] => {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-status", "-z", "--diff-filter=ACMRD", "-M"],
    { cwd: root, encoding: "utf8" },
  );
  const tokens = output.split("\0").filter((token) => token !== "");
  const entries: StagedEntry[] = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const previous = tokens[index + 1];
      const path = tokens[index + 2];
      if (path !== undefined && previous !== undefined) {
        entries.push({ status: status.slice(0, 1), path, previousPath: previous });
      }
      index += 3;
    } else {
      const path = tokens[index + 1];
      if (path !== undefined) entries.push({ status: status.slice(0, 1), path });
      index += 2;
    }
  }
  return entries;
};

const everything = (packages: PackageInfo[]): Selection => ({
  packages: orderByDependency(packages),
  changed: packages.map((pkg) => pkg.dir),
  forcedAll: true,
  unknown: [],
  ignored: [],
  total: packages.length,
});

const usage = (): void => {
  console.log(`usage: gate [stage...] [--all]

  gate                 check the staged changes (used by .githooks/pre-commit)
  gate <stage> ...     run only these stages: ${stages.map((stage) => stage.name).join(", ")}
  gate --all           check every package (\`npm run check\`)`);
};

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    usage();
    return;
  }
  const requested = args.filter((arg) => !arg.startsWith("--"));
  const unknownStages = requested.filter((name) => !stages.some((stage) => stage.name === name));
  if (unknownStages.length > 0) {
    console.error(`gate: unknown stage: ${unknownStages.join(", ")}`);
    usage();
    process.exit(2);
  }
  const chosen = requested.length === 0 ? stages : stages.filter((stage) => requested.includes(stage.name));

  const { root, git } = findRoot();
  if (!existsSync(join(root, "node_modules"))) {
    console.error("gate: node_modules is missing; run npm install inside nix develop");
    process.exit(1);
  }
  const packages = loadPackages(root);
  const runAll = args.includes("--all");
  const selection =
    runAll || !git ? everything(packages) : select(stagedEntries(root), packages);

  if (selection.packages.length === 0) {
    console.log(`gate: ${selection.total} staged path(s), no package changes — nothing to check`);
    return;
  }
  if (runAll || !git) {
    console.log(`gate: every package in scope | affected: ${selection.packages.map((pkg) => pkg.dir).join(", ")}`);
  } else {
    const changed = selection.changed.length > 0 ? selection.changed.join(", ") : "none";
    const forced = selection.forcedAll ? " | root trigger: every package" : "";
    console.log(
      `gate: ${selection.total} staged path(s) | changed: ${changed}${forced} | affected: ${selection.packages
        .map((pkg) => pkg.dir)
        .join(", ")}`,
    );
  }

  const all = runAll || selection.forcedAll;
  const started = Date.now();
  for (const stage of chosen) {
    const stageStarted = Date.now();
    for (const run of stage.run({ root, packages: selection.packages, all })) {
      const result = spawnSync(run.argv[0] ?? "", run.argv.slice(1), {
        cwd: run.cwd,
        stdio: "inherit",
      });
      if (result.error !== undefined) {
        console.error(`gate: ${stage.name}: ${result.error.message}`);
        process.exit(1);
      }
      if (result.status !== 0) {
        console.error(`gate: ${stage.name} failed (${Date.now() - stageStarted}ms)`);
        process.exit(result.status ?? 1);
      }
    }
    console.log(`gate: ${stage.name} ok (${Date.now() - stageStarted}ms)`);
  }
  console.log(`gate: ok (${Date.now() - started}ms)`);
};

main();
