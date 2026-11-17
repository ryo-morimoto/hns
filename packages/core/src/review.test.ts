import * as v from "valibot";
import { expect, test } from "vitest";
import { isoTimestamp } from "./codecs.ts";
import { MIRROR_STATUSES } from "./checkpoint.ts";
import {
  REVIEW_FAILURES,
  REVIEW_TREE_ENTRY_KINDS,
  ReviewCommitSchema,
  ReviewFailureSchema,
  ReviewTreeEntrySchema,
} from "./review.ts";
import type {
  ReviewCommit,
  ReviewFailure,
  ReviewFile,
  ReviewTreeEntry,
  ReviewTreeEntryKind,
} from "./review.ts";

// Catches: the failure codes a source can answer with drifting from the ones a reviewer handles,
// which would turn a failed read into an empty view.
test("the review failures are the closed set the contract names", () => {
  expect(REVIEW_FAILURES).toStrictEqual([
    "not_found",
    "unavailable",
    "too_large",
    "invalid_request",
    "unauthorized",
  ]);
  for (const code of REVIEW_FAILURES) expect(v.parse(ReviewFailureSchema, code)).toBe(code);
  expect(() => v.parse(ReviewFailureSchema, "offline")).toThrow(v.ValiError);
  expect(REVIEW_FAILURES).not.toContain("mirror_failed");
});

// Catches: a review read sharing the checkpoint module's vocabulary, so a mirror state could be
// mistaken for a review state.
test("review does not inherit the mirror's states", () => {
  for (const status of MIRROR_STATUSES) expect(REVIEW_FAILURES).not.toContain(status);
});

// Catches: a tree entry kind a reviewer cannot read (a symlink rendered as a file), or a kind
// widening to a free string.
test("a tree entry names one of the object kinds a reviewer reads", () => {
  expect(REVIEW_TREE_ENTRY_KINDS).toStrictEqual(["blob", "tree", "commit"]);
  const entry: ReviewTreeEntry = {
    path: "src/a.ts",
    kind: "blob",
    mode: "100644",
    object: "1".repeat(40),
    size: 12,
  };
  expect(v.parse(ReviewTreeEntrySchema, entry)).toStrictEqual(entry);
  // A mode outside git's closed set is refused, so a source cannot invent one.
  expect(() => v.parse(ReviewTreeEntrySchema, { ...entry, mode: "100600" })).toThrow(v.ValiError);
});

// Catches: a commit read that loses its tree id or its time, so a review cannot name the root it
// descends or show when the checkpoint was made.
test("a review commit carries its root tree and time", () => {
  const commit: ReviewCommit = {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    message: "hns checkpoint run-1",
    committedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
  };
  expect(v.parse(ReviewCommitSchema, commit)).toStrictEqual(commit);
  expect(() => v.parse(ReviewCommitSchema, { ...commit, tree: "short" })).toThrow(v.ValiError);
  expect(() => v.parse(ReviewCommitSchema, { ...commit, committedAt: "yesterday" })).toThrow(
    v.ValiError,
  );
});

// Compile-time only: the kinds and the failure stay closed at every call site.
const kinds: readonly ReviewTreeEntryKind[] = REVIEW_TREE_ENTRY_KINDS;
const failures: readonly ReviewFailure[] = REVIEW_FAILURES;
const file: ReviewFile = {
  path: "a.png",
  object: "c".repeat(40),
  contentType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
};
void kinds;
void failures;
void file;
