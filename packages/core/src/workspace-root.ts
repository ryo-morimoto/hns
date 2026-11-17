/* oxlint-disable anti-slop/no-unknown-parameters --
   These functions are the model's boundary: they take an unknown root and parse it.
*/
import * as v from "valibot";

/**
 * The longest workspace root the model stores, in characters.
 *
 * @remarks
 * A bound, not a security control: the machine resolves the real path below its ROOT.
 */
export const WORKSPACE_ROOT_MAX_LENGTH = 255;

/** The longest single path segment a workspace root may carry, in characters. */
export const WORKSPACE_ROOT_MAX_SEGMENT_LENGTH = 64;

/** A Windows drive-letter segment; the machine refuses it, so the model does too. */
const DRIVE_SEGMENT = /^[A-Za-z]:$/u;

/**
 * Why `value` is not a usable workspace root, or undefined when it is one.
 *
 * @param value - The untrusted root text.
 * @returns A short reason, or undefined for a canonical root.
 *
 * @remarks
 * The check is lexical only. It refuses anything that is not already canonical, so the stored
 * value never needs rewriting: an absolute path, `..` or `.` segments, an empty segment, a
 * backslash, NUL, a `.hns` segment, a Windows drive letter, and a value over the length bounds.
 * Whether the path really stays below the machine's ROOT (a symbolic link, another user's
 * directory) is decided there with `containInRoot` / `applyVersionedWrite`, which resolve the
 * ROOT through a directory fd. The empty string is the machine's ROOT and is valid here.
 */
export function workspaceRootProblem(value: string): string | undefined {
  if (value.length > WORKSPACE_ROOT_MAX_LENGTH) {
    return "workspaceRoot must be at most " + String(WORKSPACE_ROOT_MAX_LENGTH) + " characters";
  }
  if (value.includes("\0")) return "workspaceRoot must not contain NUL";
  if (value.includes("\\")) return "workspaceRoot must not contain a backslash";
  if (value === "") return undefined;
  for (const segment of value.split("/")) {
    if (segment === "") return "workspaceRoot must not contain an empty segment";
    if (segment === "." || segment === "..") {
      return "workspaceRoot must not contain a relative segment";
    }
    if (segment === ".hns") return "workspaceRoot must not name the .hns directory";
    if (DRIVE_SEGMENT.test(segment)) return "workspaceRoot must not contain a drive letter";
    if (segment.length > WORKSPACE_ROOT_MAX_SEGMENT_LENGTH) {
      return (
        "workspaceRoot segments must be at most " +
        String(WORKSPACE_ROOT_MAX_SEGMENT_LENGTH) +
        " characters"
      );
    }
  }
  return undefined;
}

/**
 * A stored workspace root: the machine ROOT (`""`) or a POSIX path below it.
 *
 * @remarks
 * The empty string means the machine's ROOT itself, which is what the default project and every
 * project migrated before roots existed use. Any other value must already be canonical; see
 * {@link workspaceRootProblem}. Parsing throws `ValiError` rather than rewriting the value, so a
 * corrupt row or an unvalidated request fails loudly.
 */
export const WorkspaceRootSchema: v.GenericSchema<unknown, string> = v.pipe(
  v.string(),
  v.check(
    (value) => workspaceRootProblem(value) === undefined,
    "workspaceRoot must be a canonical path below the machine root",
  ),
);

/**
 * A workspace root for a new project: a non-empty path below the machine ROOT.
 *
 * @remarks
 * Creating a project without naming its directory would silently point it at the machine ROOT,
 * so the default project is the only root-level one (it is seeded that way). Moving an existing
 * project to the ROOT is not an operation this model has.
 */
export const ProjectWorkspaceRootSchema: v.GenericSchema<unknown, string> = v.pipe(
  v.string(),
  v.check(
    (value) => value.length > 0 && workspaceRootProblem(value) === undefined,
    "workspaceRoot must name a directory below the machine root",
  ),
);

/**
 * Parse an untrusted workspace root.
 *
 * @param value - The raw value from a row, a request, or a fixture.
 * @returns The same text, which is already canonical.
 * @throws ValiError when `value` is not a string or is not a canonical root.
 */
export function parseWorkspaceRoot(value: unknown): string {
  return v.parse(WorkspaceRootSchema, value);
}

/**
 * Parse a workspace root for a project being created.
 *
 * @param value - The raw value from the mutation's argument.
 * @returns The same text, which is already canonical and non-empty.
 * @throws ValiError when `value` is empty or not a canonical root.
 */
export function parseProjectWorkspaceRoot(value: unknown): string {
  return v.parse(ProjectWorkspaceRootSchema, value);
}
