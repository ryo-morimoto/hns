import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Denied } from "@hns/workspace";
import { MachineRefusal } from "./refusal.ts";

/** A path resolved below ROOT: the name as sent, and the absolute path to open. */
export interface ContainedPath {
  /** The normalized ROOT-relative name; `""` is the root itself. */
  readonly relative: string;
  readonly absolute: string;
}

/**
 * Turn a wire path into names below ROOT, or refuse it.
 *
 * @param relativePath - The path as the caller wrote it. A leading `/` is a
 * separator relative to ROOT, not an absolute host path; both separators are
 * accepted.
 * @returns The normalized name, without empty, `.` or `..` segments.
 * @throws {Denied} For a NUL, a Windows drive letter, or any `..` segment. The
 * segment is refused rather than resolved, so the result cannot climb out.
 *
 * @remarks
 * This is syntactic only. Whether the path really stays below ROOT is decided
 * by canonicalizing its parent in `containInRoot`.
 */
export function normalizeRelative(relativePath: string): string {
  if (relativePath.includes("\0")) throw new Denied("invalid path");
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) throw new Denied("absolute path");
  const parts = relativePath.split(/[\\/]+/);
  if (parts.includes("..")) throw new Denied("parent segment");
  return parts.filter((part) => part !== "" && part !== ".").join("/");
}

/**
 * Resolve a wire path below the canonical ROOT.
 *
 * @param root - The canonical root, already resolved with `realpath` at start.
 * @param relativePath - The path from the request.
 * @returns The normalized name and the absolute path, whose parent is the
 * canonical parent.
 * @throws {Denied} When the name cannot be normalized, or when the canonical
 * parent is not the root or below it: a symbolic link in the parent chain must
 * not point outside.
 * @throws {MachineRefusal} With code `not_found` when the parent does not
 * exist. A path whose parent is gone is absent, not a containment violation.
 *
 * @remarks
 * Only the parent is canonicalized. The final component is deliberately not
 * followed: `read` opens with `O_NOFOLLOW` and `stat` reports a symbolic link
 * as such, so a link cannot serve bytes from outside ROOT. A parent swapped
 * between this resolution and the open is not covered here; the workspace's
 * dirfd helper closes that window, and the machine's own reads inherit the
 * same residual race until it runs behind the workspace.
 */
export async function containInRoot(root: string, relativePath: string): Promise<ContainedPath> {
  const relative = normalizeRelative(relativePath);
  if (relative === "") return { relative, absolute: root };
  const candidate = join(root, relative);
  const parent = dirname(candidate);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parent);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const errno = "code" in error ? String(error.code) : "";
    if (errno === "ENOENT" || errno === "ENOTDIR") {
      throw new MachineRefusal("not_found", `${relativePath}: the parent directory does not exist`);
    }
    throw error;
  }
  if (canonicalParent !== root && !canonicalParent.startsWith(root + "/")) {
    throw new Denied("escapes root");
  }
  return { relative, absolute: join(canonicalParent, basename(relative)) };
}
