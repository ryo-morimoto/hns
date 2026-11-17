/**
 * Paths as the capability contract compares them, and the forward-match a scope uses.
 *
 * @remarks
 * A path is **POSIX and relative**: `"`.`"` is the workspace root, a segment is non-empty, and there is
 * no leading `/`, no `\\`, no NUL, no `..` segment, and no glob. `//` is folded and a trailing
 * `/` dropped, so one file has one spelling. Case is significant; symlink resolution is the
 * executor's job (the machine re-checks the resolved path), not this module's.
 */

/** What a path or a match could not be decided as. */
export interface Unsupported {
  readonly kind: "unsupported";
  readonly reason: string;
}

/** A normalized POSIX relative path. */
export interface NormalPath {
  readonly kind: "path";
  readonly value: string;
}

/** The result of reading an untrusted path. */
export type PathResult = NormalPath | Unsupported;

/** What `isUnder` decided. */
export interface Under {
  readonly kind: "under";
  readonly under: boolean;
}

/** The result of a forward-match. */
export type UnderResult = Under | Unsupported;

/** A NUL byte, which no path may carry. */
const NUL = String.fromCharCode(0);

/** A segment containing one of these is a glob (or a pattern this contract does not compare). */
const GLOB_CHARACTERS = ["*", "?", "[", "]", "{", "}"];

function unsupported(reason: string): Unsupported {
  return { kind: "unsupported", reason };
}

/**
 * Normalize an untrusted path.
 *
 * @param input - A path as it arrived from a model, a policy, or a grant.
 * @returns `{kind: "path"}` with the normalized spelling, or `{kind: "unsupported"}` when the path
 * cannot be compared (absolute, a backslash, NUL, `..`, `.` outside the root position, a glob, or
 * empty).
 */
export function normalizePath(input: string): PathResult {
  if (input === "") return unsupported("an empty path");
  if (input === ".") return { kind: "path", value: "." };
  if (input.includes(NUL)) return unsupported("a NUL in a path");
  if (input.includes("\\")) return unsupported("a backslash in a path");
  if (input.startsWith("/")) return unsupported("an absolute path");
  for (const character of GLOB_CHARACTERS) {
    if (input.includes(character)) return unsupported("a glob in a path");
  }
  // "./a" and "a" are the same path; a "." below the root is not a spelling this contract accepts.
  if (input.startsWith("./")) return normalizePath(input.slice(2));
  const segments = input.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return unsupported("a path with no segment");
  for (const segment of segments) {
    if (segment === "..") return unsupported("a '..' segment");
    if (segment === ".") return unsupported("a '.' segment below the root");
  }
  return { kind: "path", value: segments.join("/") };
}

/**
 * Whether `path` is `root` or below it.
 *
 * @remarks
 * `root === "."` is the workspace root and contains every normal path. Otherwise `path` is under
 * `root` when it equals it or starts with `root + "/"`, so `src` does not contain `srcx`. Both sides
 * are normalized first; **a glob on either side, or any path that cannot be normalized, is
 * `unsupported`, never `true`**: a pattern this contract cannot decide must not be read as a match
 * (fail closed).
 *
 * @param path - The path to place.
 * @param root - The root it must be under.
 * @returns `{kind: "under", under}` or `{kind: "unsupported"}`.
 */
export function isUnder(path: string, root: string): UnderResult {
  const target = normalizePath(path);
  if (target.kind === "unsupported") return target;
  const base = normalizePath(root);
  if (base.kind === "unsupported") return base;
  if (base.value === ".") return { kind: "under", under: true };
  return {
    kind: "under",
    under: target.value === base.value || target.value.startsWith(base.value + "/"),
  };
}

/**
 * Whether a path contains a glob character `*` or `**`.
 *
 * @remarks
 * Phase 1 compares no glob at all: any glob makes a diff `unsupported` (`docs/capability.md` §1).
 * This predicate exists so a caller can say *why* a policy was refused, and it recognizes only `*`
 * and `**`; `?`, `[`, and `{` are not globs in this contract (they are reported as an unsupported
 * path by {@link normalizePath}).
 *
 * @param value - A path or root.
 * @returns `true` for `*` or `**` anywhere in `value`.
 */
export function hasGlob(value: string): boolean {
  return value.includes("*");
}
