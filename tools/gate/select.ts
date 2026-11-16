/**
 * Pure selection logic for the commit gate: staged paths -> affected packages.
 * No IO here so the rules stay testable (tools/gate/test/select.test.ts).
 */

export interface StagedEntry {
  /** Index status letter: A, M, D, R, or C. */
  status: string;
  /** Path as it exists after the commit (the new path for renames). */
  path: string;
  /** Old path for renames and copies: the package that lost the file needs checking too. */
  previousPath?: string;
}

export interface PackageInfo {
  /** Workspace directory and vitest project name, e.g. "core". */
  dir: string;
  /** npm name, e.g. "@hns/core". */
  name: string;
  /** @hns packages this one imports directly. */
  dependsOn: string[];
}

export interface Selection {
  /** Affected packages, dependencies first. Empty means nothing to check. */
  packages: PackageInfo[];
  /** Packages whose own files changed, before dependents were added. */
  changed: string[];
  /** True when a root-level trigger put every package in scope. */
  forcedAll: boolean;
  /** Changed paths under packages/ that belong to no known package. */
  unknown: string[];
  /** Changed paths that no check depends on. */
  ignored: string[];
  /** Number of staged entries considered. */
  total: number;
}

/** A root file whose change can affect every package. */
const ROOT_TRIGGERS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "flake.nix",
  "flake.lock",
  "vitest.config.ts",
  "relay.config.json",
  "oxlint.config.ts",
  ".oxfmtrc.json",
  ".pre-commit-config.yaml",
];

/** Directories whose contents can affect every package (the gate itself, tooling). */
const TRIGGER_PREFIXES: readonly string[] = ["tools/", ".githooks/"];

/** Directories that no check reads. */
const IGNORED_PREFIXES: readonly string[] = ["docs/", "work/", ".work/"];

/** Workspace roots this gate does not model yet; a change there checks everything. */
const UNMODELLED_PREFIXES: readonly string[] = ["apps/"];

// Package Markdown is inside oxfmt's scope (oxfmt --check packages), so only
// Markdown outside packages/ can be ignored.
const isIgnored = (path: string): boolean =>
  IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
  (path.endsWith(".md") && !path.startsWith("packages/"));

const isRootTrigger = (path: string): boolean =>
  ROOT_TRIGGERS.includes(path) ||
  /^tsconfig(\..+)?\.json$/.test(path) ||
  TRIGGER_PREFIXES.some((prefix) => path.startsWith(prefix));

/** "packages/core/src/x.ts" -> "core"; anything else -> undefined. */
const packageDirOf = (path: string): string | undefined => {
  const match = /^packages\/([^/]+)\//.exec(path);
  return match?.[1];
};

/**
 * Packages that import any of the changed packages, transitively.
 * The model is the one docs/packages.md fixes: an edge points at a dependency.
 */
export function withDependents(
  changedDirs: readonly string[],
  packages: readonly PackageInfo[],
): PackageInfo[] {
  const affected = new Set<string>();
  for (const dir of changedDirs) {
    const pkg = packages.find((candidate) => candidate.dir === dir);
    if (pkg !== undefined) affected.add(pkg.name);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (affected.has(pkg.name)) continue;
      if (pkg.dependsOn.some((dep) => affected.has(dep))) {
        affected.add(pkg.name);
        grew = true;
      }
    }
  }
  return packages.filter((pkg) => affected.has(pkg.name));
}

/** Dependencies before dependents, so build and typecheck see a fresh dist. */
export function orderByDependency(packages: readonly PackageInfo[]): PackageInfo[] {
  const inScope = new Set(packages.map((pkg) => pkg.name));
  const ordered: PackageInfo[] = [];
  const seen = new Set<string>();
  const visit = (pkg: PackageInfo): void => {
    if (seen.has(pkg.name)) return;
    seen.add(pkg.name);
    for (const dep of pkg.dependsOn) {
      if (!inScope.has(dep)) continue;
      const next = packages.find((candidate) => candidate.name === dep);
      if (next !== undefined) visit(next);
    }
    ordered.push(pkg);
  };
  for (const pkg of packages) visit(pkg);
  return ordered;
}

/**
 * Decide what the commit touches.
 * Unknown paths under packages/ are treated as a package we cannot reason about,
 * so every check runs rather than silently skipping one.
 */
export function select(
  entries: readonly StagedEntry[],
  packages: readonly PackageInfo[],
): Selection {
  const known = new Set(packages.map((pkg) => pkg.dir));
  const ignored: string[] = [];
  const unknown: string[] = [];
  const changed = new Set<string>();
  let forcedAll = false;

  for (const entry of entries) {
    // A rename affects two packages: the one that lost the file and the one that gained it.
    const paths =
      entry.previousPath === undefined ? [entry.path] : [entry.previousPath, entry.path];
    for (const path of paths) {
      if (isIgnored(path)) {
        ignored.push(path);
        continue;
      }
      if (isRootTrigger(path) || UNMODELLED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        forcedAll = true;
        continue;
      }
      const dir = packageDirOf(path);
      if (dir === undefined) {
        ignored.push(path);
        continue;
      }
      if (!known.has(dir)) {
        unknown.push(path);
        forcedAll = true;
        continue;
      }
      changed.add(dir);
    }
  }

  const changedDirs = [...changed].sort();
  const inScope = forcedAll ? [...packages] : withDependents(changedDirs, packages);
  return {
    packages: orderByDependency(inScope),
    changed: changedDirs,
    forcedAll,
    unknown,
    ignored,
    total: entries.length,
  };
}