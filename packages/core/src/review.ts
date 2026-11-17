import * as v from "valibot";
import { IsoTimestampSchema } from "./codecs.ts";
import type { IsoTimestamp } from "./codecs.ts";

/**
 * The review read contract: what a checkpoint's commit offers a reviewer, independent of where
 * it is read from.
 *
 * @remarks
 * A review reads a commit's log, one tree, and one file at a time. The values here are what
 * those reads answer with; the source that reads them (Artifacts or R2) is a server port, so this
 * module stays a model and does not know a binding. Review reads a **commit id**, never a ref
 * name: a ref moves, and a review must show the bytes the checkpoint recorded.
 *
 * The checkpoint contract is a separate module ({@link ./checkpoint.ts}): a mirror's state says
 * nothing about what a commit holds, and review must not inherit a store's vocabulary.
 */

/**
 * Why a review read failed.
 *
 * @remarks
 * These are expected failures of a source, not defects. `not_found` is a commit, tree, or path
 * the source does not have; `unavailable` is a source that could not be reached at all (the
 * binding failed, the store did not answer); `too_large` is a file over the size a reviewer may
 * read; `invalid_request` is a path that leaves the tree or a value that cannot be a commit id;
 * `unauthorized` is a credential the source refused. A source must return one of these rather
 * than an empty answer, because an empty file list and a failed read look the same to a reviewer.
 */
export const REVIEW_FAILURES = [
  "not_found",
  "unavailable",
  "too_large",
  "invalid_request",
  "unauthorized",
] as const;

/** One reason a review read failed. */
export type ReviewFailure = (typeof REVIEW_FAILURES)[number];

interface ReviewCommitFields {
  readonly commit: string;
  readonly tree: string;
  readonly message: string;
  readonly committedAt: IsoTimestamp;
}

/**
 * One commit a review reads.
 *
 * @remarks
 * `commit` is the git object id the caller asked for; `tree` is the root tree it names. A
 * checkpoint commit has no parents, so a review names both sides of a diff by commit id rather
 * than by ancestry. `committedAt` is the commit time as an ISO 8601 timestamp.
 */
export interface ReviewCommit extends ReviewCommitFields {}

/** One entry of one directory in a tree, as `ls-tree` names them. */
export const REVIEW_TREE_ENTRY_KINDS = ["blob", "tree", "commit"] as const;

/** One git object type a tree entry may name. Symlinks and submodules are not entries a reviewer reads. */
export type ReviewTreeEntryKind = (typeof REVIEW_TREE_ENTRY_KINDS)[number];

interface ReviewTreeEntryFields {
  readonly path: string;
  readonly kind: ReviewTreeEntryKind;
  readonly object: string;
  readonly size: number;
}

/**
 * One entry of a tree.
 *
 * @remarks
 * `path` is relative to the tree the caller asked about, with `/` separators and no leading
 * slash. `object` is the git object id of the entry and `size` its size in bytes (`0` for a tree).
 * One `readTree` answers the entries of one directory, not a recursive walk: a reviewer descends
 * by asking for a `tree` entry's own directory.
 */
export interface ReviewTreeEntry extends ReviewTreeEntryFields {}

interface ReviewFileFields {
  readonly path: string;
  readonly object: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * One file's bytes as a tree names them.
 *
 * @remarks
 * The bytes are raw, not text: a reviewer shows an image or a binary as well as a ``.ts`. The
 * content type is a hint for the viewer, not a guarantee of the bytes. `object` is the blob's git
 * object id, so the same bytes under another path are recognisably the same file.
 */
export interface ReviewFile extends ReviewFileFields {}

/**
 * The review failure as it arrives, parsed at the boundary.
 *
 * @remarks
 * `failure` is the closed code; `message` is diagnostic and never a path the source should
 * leak or a credential.
 */
export const ReviewFailureSchema: v.GenericSchema<unknown, ReviewFailure> =
  v.picklist(REVIEW_FAILURES);

/** The commit as it arrives, parsed at the boundary. */
export const ReviewCommitSchema: v.GenericSchema<unknown, ReviewCommit> = v.object({
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  tree: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  message: v.string(),
  committedAt: IsoTimestampSchema,
});

/** The tree entry as it arrives, parsed at the boundary. */
export const ReviewTreeEntrySchema: v.GenericSchema<unknown, ReviewTreeEntry> = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(REVIEW_TREE_ENTRY_KINDS),
  object: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  size: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
