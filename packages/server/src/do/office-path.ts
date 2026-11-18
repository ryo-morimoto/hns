import { officeFailureOf } from "./office-job.ts";
import type { OfficeFailureView } from "./office-job.ts";
/**
 * What a path the caller named means to one workspace (0237, C1).
 *
 * @remarks
 * `ok` carries the path as the workspace spells it; a refusal carries the union member the face
 * answers with and the edge's status for it. The two are one value so no caller can have the
 * path without the check.
 */
export type OfficePathCheck =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly status: "invalid_request" | "not_found";
      readonly failure: OfficeFailureView;
    };

/** The longest path a workspace holds (the contract's `OfficeInputSchema` bound). */
const MAX_PATH_LENGTH = 4096;

/**
 * Check that a path names a file inside one workspace (0237, C1).
 *
 * @param workspaceId - The workspace the caller is acting in (the Session's name).
 * @param path - The path the caller named, workspace-relative.
 * @returns The path, normalised to `/` separators, or the refusal.
 *
 * @remarks
 * **A path that leaves the workspace is `not_authorized`, and no row is written or read for
 * it.** The machine would refuse it too (`path_denied` through its own containment), but the
 * server must not hand a path it has not checked to the machine at all: the machine is one
 * workspace, and a path like `../other/file.docx` that reached it would be resolved against the
 * same ROOT and could name another workspace's file. So the check is here, it is lexical, and it
 * is fail closed: an absolute path, a `..` segment, a backslash, a NUL, a segment that is empty,
 * or a `.hns` segment is refused.
 *
 * A path that fails the check for the **shape** (`invalid_request`) and one that fails it for the
 * **workspace** (`not_authorized`) are the same refusal at the resolver (the contract has one
 * code for it), and `status` is what the edge answers a route with.
 */
export function officePathOf(workspaceId: string, path: string): OfficePathCheck {
  if (workspaceId.length === 0) {
    return refuse("not_found", "not_authorized", "The workspace is not known.");
  }
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return refuse("invalid_request", "not_authorized", "A path is 1 to 4096 characters.");
  }
  if (path.includes("\\u0000") || path.includes("\\")) {
    return refuse("invalid_request", "not_authorized", "A path has no NUL and no backslash.");
  }
  // An absolute path is not a separate branch: its first segment is empty, and the empty-segment
  // rule below refuses it. One rule per property keeps a mutation in either from hiding the
  // other (an absolute path that skipped this check would still be refused there).
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      return refuse("invalid_request", "not_authorized", "A path has no empty segment.");
    }
    if (segment === "..") {
      return refuse("not_found", "not_authorized", "A path stays inside the workspace.");
    }
    if (segment === ".hns") {
      return refuse("not_found", "not_authorized", "A path stays out of the control directory.");
    }
  }
  return { ok: true, path: segments.join("/") };
}

/** One refusal of {@link officePathOf}. */
function refuse(
  status: "invalid_request" | "not_found",
  code: "not_authorized",
  message: string,
): OfficePathCheck {
  return { ok: false, status, failure: officeFailureOf(code, message) };
}
