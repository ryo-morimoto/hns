import type { ReviewDiff } from "./service.ts";
import { ReviewSourceError } from "./source.ts";
import type { ReviewSource } from "./source.ts";
import { reviewDiff } from "./service.ts";
import { applyVersionedWrite, versionOf } from "@hns/workspace";

/**
 * The three hunk actions a review offers (C1 / D104).
 *
 * @remarks
 * They differ only in the bytes they produce; the write itself is one versioned write whatever the
 * action. **Keep** and **undo** say which side of the change the file should now match; **apply**
 * is the screen's own resolution of a hunk the base and head disagree about (a line taken from
 * whichever side the person chose). All three are refused when the file moved since the caller
 * read it: the UI is not the authority (D104).
 */
export type ReviewHunkAction = "keep" | "undo" | "apply";

/** A hunk action's input: which Change and path, which hunk, and the version the caller saw. */
export interface ReviewHunkWriteInput {
  readonly changeId: string;
  readonly base: string;
  readonly head: string;
  readonly path: string;
  /** The hunk's start line on the head side (the side a kept file matches). */
  readonly headStart: number;
  /** The file's version when the caller read the diff, or `absent`. */
  readonly expectedVersion: string;
  readonly actor: string;
}

/**
 * What a hunk write did.
 *
 * @remarks
 * `conflict` carries the version that is there now, so a screen can say "this file changed under
 * you" with the fact, not a guess. `applied` carries the diff **re-read after the write**, which
 * is the server's answer rather than the screen's echo.
 */
export type ReviewDiffWriteResult =
  | { readonly ok: true; readonly diff: ReviewDiff }
  | {
      readonly ok: false;
      readonly code: "conflict" | "invalid_request" | "not_found" | "unavailable";
      readonly message: string;
      readonly currentVersion?: string | undefined;
    };

/** Where a hunk write lands: the pinned root and the project directory inside it. */
export interface ReviewWriteTarget {
  /** The canonical ROOT; every path resolves below it. */
  readonly root: string;
  /** The project directory below ROOT. */
  readonly projectRoot: string;
}

/**
 * Read one side of a changed file out of a review source.
 *
 * @param source - Where the commits are read from.
 * @param commit - The commit.
 * @param path - The file's path, relative with `/` separators.
 * @returns The bytes, or undefined when the commit has no file there.
 * @throws {ReviewSourceError} as the source does; the caller parses that.
 */
async function sideOf(
  source: ReviewSource,
  commit: string,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return (await source.readFile(commit, path)).bytes;
  } catch (error) {
    if (error instanceof ReviewSourceError && error.code === "not_found") return undefined;
    throw error;
  }
}

/**
 * Whether `path` is safe to write: relative, no `..`, no NUL, no leading slash.
 *
 * @remarks
 * The checkpoint's paths are the tree's own (relative, `/`-separated), and a caller sends one back
 * to name the hunk it wants resolved. The check is here, before the path becomes a file name.
 */
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

/**
 * The bytes a hunk action writes for one file.
 *
 * @param action - Keep, undo, or apply.
 * @param head - The head bytes, or undefined when the path is not in the head.
 * @param base - The base bytes, or undefined when the path is not in the base.
 * @returns The bytes to write, or a typed failure when the action does not apply on this side.
 *
 * @remarks
 * - **keep**: the head bytes. A path that is not in the head has nothing to keep.
 * - **undo**: the base bytes; a path that is not in the base is a file the Change added, and
 *   undoing it means writing it empty rather than deleting it (deletion is a workspace operation,
 *   not a hunk's).
 * - **apply**: the head bytes when the head has the file and the base does not, else the base
 *   bytes. This is the screen's resolution of a hunk one side lacks; the line-level choice is the
 *   screen's and the bytes it produces are what is written and version-checked.
 */
function bytesFor(
  action: ReviewHunkAction,
  head: Uint8Array | undefined,
  base: Uint8Array | undefined,
): Uint8Array | undefined {
  switch (action) {
    case "keep":
      return head;
    case "undo":
      return base ?? new Uint8Array(0);
    case "apply":
      return head ?? base;
  }
}

/**
 * Write one hunk's resolution through the Workspace's versioned write (C1).
 *
 * @param source - The review source the two sides are read from.
 * @param target - The pinned root and project directory the file is written below.
 * @param action - Keep, undo, or apply.
 * @param input - The Change, path, version, and actor.
 * @returns The write's outcome and the diff re-read afterwards when it was applied.
 *
 * @remarks
 * **This is the one place a review writes a file.** The bytes are read from the commits (the
 * server's copy, never the browser's), the version the caller saw is compared against the file on
 * disk inside `applyVersionedWrite` (a retry that already has the bytes settles as `applied`),
 * and a file that moved is `conflict` with what is there now. The content hash is the one the
 * versioned write checks before it writes, so a corrupted read cannot be written as the intent.
 *
 * After the write the diff is read again from the same source: the answer a screen shows is the
 * server's, which is what makes keep / undo visible without the screen recomputing them.
 * @throws When `applyVersionedWrite` throws something that is not a `FileSystemFailure`: that is a
 * defect (a bad root), not a review refusal.
 */
export async function writeHunkAt(
  source: ReviewSource,
  target: ReviewWriteTarget,
  action: ReviewHunkAction,
  input: ReviewHunkWriteInput,
): Promise<ReviewDiffWriteResult> {
  if (!safePath(input.path)) {
    return { ok: false, code: "invalid_request", message: "The path is not one inside the tree." };
  }
  const head = await sideOf(source, input.head, input.path);
  const base = await sideOf(source, input.base, input.path);
  if (head === undefined && base === undefined) {
    return {
      ok: false,
      code: "not_found",
      message: "Neither commit has a file at that path.",
    };
  }
  const bytes = bytesFor(action, head, base);
  if (bytes === undefined) {
    return {
      ok: false,
      code: "not_found",
      message: "There is nothing to " + action + " for that path.",
    };
  }
  const outcome = await applyVersionedWrite({
    root: target.root,
    projectRoot: target.projectRoot,
    path: input.path,
    content: bytes,
    expectedVersion: input.expectedVersion,
    contentHash: versionOf(bytes),
  });
  switch (outcome.status) {
    case "applied":
      break;
    case "conflict":
      return {
        ok: false,
        code: "conflict",
        message: "The file changed since it was read.",
        currentVersion: outcome.currentVersion,
      };
    case "unknown":
      return {
        ok: false,
        code: "unavailable",
        message: "The write could not be confirmed.",
      };
  }
  const after = await reviewDiff(source, input.base, input.head);
  if (after.ok) return { ok: true, diff: after.diff };
  // The write landed; the re-read failed. The answer says so rather than repeating a diff the
  // server cannot read.
  return {
    ok: false,
    code: after.failure === "not_found" ? "not_found" : "unavailable",
    message: after.message,
  };
}

/**
 * The port the GraphQL face calls: a hunk write over one review source.
 *
 * @param source - The commits are read from here; production is the R2 checkpoint packs.
 * @param action - Keep, undo, or apply.
 * @param input - The Change, path, and version.
 * @param requestId - The correlation id, logged with a failure and never returned.
 * @param target - The pinned root and project directory the file is written below. Production
 * passes none — the Worker has no writable directory for a workspace — and the call then fails
 * closed with `unavailable`; a machine-side Workspace reach is what supplies it.
 * @returns The write's answer.
 *
 * @remarks
 * A call without a {@link ReviewWriteTarget} cannot write a file, and says `unavailable` rather
 * than pretending. The failure is logged with the path only — never the file's bytes.
 */
export async function writeHunk(
  source: ReviewSource,
  action: ReviewHunkAction,
  input: ReviewHunkWriteInput,
  requestId: string,
  target?: ReviewWriteTarget | undefined,
): Promise<ReviewDiffWriteResult> {
  if (target === undefined) {
    console.error(
      "graphql: a review hunk write has no writable workspace",
      requestId,
      action,
      JSON.stringify(input.path),
    );
    return {
      ok: false,
      code: "unavailable",
      message: "This deployment cannot write a file from a review.",
    };
  }
  return writeHunkAt(source, target, action, input);
}
