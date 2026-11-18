import { expect, expectTypeOf, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { ReviewCommit, ReviewFile, ReviewTreeEntry } from "@hns/core";
import { artifactsRepoName } from "../artifacts/repos.ts";
import { ArtifactsReviewSource, type ArtifactsReviewBinding } from "./artifacts.ts";
import { ReviewSourceError, type ReviewSource } from "./source.ts";
import { fakeArtifactsReview, reviewArtifactError } from "../../test/support/artifacts-review.ts";

/**
 * C3: the Artifacts source reads by commit id, and the bytes are the commit's own (0248).
 *
 * @remarks
 * The binding is a fake, but the fake has the **real binding's surface**: `get(name)` throws
 * `NOT_FOUND` for a repository the namespace does not have, `readCommit(hash)` and
 * `readTree(hash)` read by object id, and `readFile({ ref, path })` answers a `Blob`. The test's
 * job is the adapter's contract — that a commit id is what travels, never a ref name, that the
 * three reads answer the port's values, and that each binding failure becomes one code of the
 * closed `ReviewFailure` vocabulary.
 */

const COMMIT = "b".repeat(40);
const BASE = "a".repeat(40);
const TREE = "c".repeat(40);
const SRC_TREE = "e".repeat(40);
const BLOB = "d".repeat(40);
const APP = "1".repeat(40);
const LINK = "f".repeat(40);
const REPO = artifactsRepoName("workspace-1");

/** A repository holding the heads of {@link COMMIT}: a root, one directory, a link, and files. */
function repository() {
  const binding = fakeArtifactsReview();
  const at = (committedAt: number) => ({
    hash: COMMIT,
    treeHash: TREE,
    message: "hns checkpoint head",
    committedAt,
  });
  binding.put(REPO, COMMIT, { kind: "commit", metadata: at(1_760_000_000) });
  binding.put(REPO, BASE, {
    kind: "commit",
    metadata: { ...at(1_700_000_000), hash: BASE, message: "hns checkpoint base" },
  });
  binding.put(REPO, TREE, {
    kind: "tree",
    entries: [
      { name: "README.md", mode: "100644", hash: BLOB, type: "blob" },
      { name: "src", mode: "40000", hash: SRC_TREE, type: "tree" },
      { name: "link", mode: "120000", hash: LINK, type: "symlink" },
    ],
  });
  binding.put(REPO, SRC_TREE, {
    kind: "tree",
    entries: [{ name: "app.ts", mode: "100755", hash: APP, type: "exec" }],
  });
  const enc = new TextEncoder();
  binding.put(REPO, "blob:" + COMMIT + ":README.md", {
    kind: "blob",
    bytes: enc.encode("hns\n"),
    type: "text/plain;charset=utf-8",
  });
  binding.put(REPO, "blob:" + COMMIT + ":src/app.ts", {
    kind: "blob",
    bytes: enc.encode("const a = 1;\n"),
    type: "text/plain;charset=utf-8",
  });
  binding.put(REPO, "blob:" + COMMIT + ":link", {
    kind: "blob",
    bytes: enc.encode("README.md"),
    type: "application/octet-stream",
  });
  return binding;
}

/** The source over a fake namespace. */
const sourceOf = (binding = repository()): ReviewSource => new ArtifactsReviewSource(binding, REPO);

/** Read the failure a source refused with, or undefined when it answered. */
type ReviewRead = ReviewCommit | readonly ReviewTreeEntry[] | ReviewFile;
const failureOf = async (read: () => Promise<ReviewRead>): Promise<string | undefined> => {
  try {
    await read();
    return undefined;
  } catch (error) {
    return error instanceof ReviewSourceError ? error.code : "not-a-review-failure";
  }
};

// Catches: a source that reads a ref, or answers a commit it was not asked for, so the review
// would show bytes the Change does not name.
test("C3: a commit is read by its id, and the answer is the commit asked for", async () => {
  const binding = repository();
  const read = await sourceOf(binding).log(COMMIT);
  expect(read).toStrictEqual<ReviewCommit>({
    commit: COMMIT,
    tree: TREE,
    message: "hns checkpoint head",
    // The binding answers Unix seconds; the port answers an ISO timestamp.
    committedAt: isoTimestamp("2025-10-09T08:53:20.000Z"),
  });
  expect(binding.calls).toStrictEqual(["get " + REPO, "readCommit " + COMMIT]);
  expect(await failureOf(() => sourceOf().log("refs/hns/run/run-1"))).toBe("invalid_request");
  expect(await failureOf(() => sourceOf().log("0".repeat(40)))).toBe("not_found");
});

// Catches: a tree read that follows a symlink or walks recursively, so a reviewer sees different
// bytes than the tree names.
test("C3: one directory is read at a time, by walking the tree ids", async () => {
  const binding = repository();
  const read = sourceOf(binding);
  expect(await read.readTree(COMMIT, "")).toStrictEqual<readonly ReviewTreeEntry[]>([
    { path: "README.md", kind: "blob", mode: "100644", object: BLOB, size: 0 },
    { path: "src", kind: "tree", mode: "40000", object: SRC_TREE, size: 0 },
    { path: "link", kind: "blob", mode: "120000", object: LINK, size: 0 },
  ]);
  expect((await read.readTree(COMMIT, "src")).map((entry) => entry.mode)).toStrictEqual(["100755"]);
  expect(await failureOf(() => read.readTree(COMMIT, "missing"))).toBe("not_found");
  // The binding is asked for the tree by its id, never for a path.
  expect(binding.calls).toContain("readTree " + SRC_TREE);
});

// Catches: a file read by path alone, so two commits with the same path would answer one's bytes
// for the other, and a file read that returns text rather than bytes.
test("C3: a file is read as bytes from the commit asked for", async () => {
  const binding = repository();
  const read = sourceOf(binding);
  const file: ReviewFile = await read.readFile(COMMIT, "src/app.ts");
  expect(new TextDecoder().decode(file.bytes)).toBe("const a = 1;\n");
  expect(file.contentType).toBe("text/plain");
  expect(file.object).toBe(APP);
  expectTypeOf(file).toEqualTypeOf<ReviewFile>();
  expect(binding.calls).toContain("readFile " + COMMIT + ":src/app.ts");
  // The base commit does not hold that file: the same path in the other commit is not an answer.
  expect(await failureOf(() => read.readFile(BASE, "src/app.ts"))).toBe("not_found");
  expect(await failureOf(() => read.readFile(COMMIT, ""))).toBe("invalid_request");
  expect(await failureOf(() => read.readFile(COMMIT, "src"))).toBe("not_found");
});

// Catches: a path that leaves the tree being read as one inside it, so a source could answer with
// another project's bytes.
test("C3: a path that leaves the tree is refused, with no binding call", async () => {
  const binding = repository();
  const read = sourceOf(binding);
  binding.calls.length = 0;
  for (const path of ["../a.txt", "/etc/passwd", "src/../../a.txt", "./a.txt", "a//b"]) {
    expect(await failureOf(() => read.readFile(COMMIT, path)), path).toBe("invalid_request");
    expect(await failureOf(() => read.readTree(COMMIT, path)), path).toBe("invalid_request");
  }
  expect(binding.calls).toStrictEqual([]);
});

// Catches: a binding failure reported as "nothing there", which a review would show as an empty
// commit rather than as a read that could not be made.
test("C3: each binding failure is one closed review failure", async () => {
  const cases: readonly (readonly [string, string])[] = [
    ["NOT_FOUND", "not_found"],
    ["UPSTREAM_UNAVAILABLE", "unavailable"],
    ["INTERNAL_ERROR", "unavailable"],
    ["MEMORY_LIMIT", "too_large"],
    ["REMOTE_AUTH_REQUIRED", "unauthorized"],
    ["INVALID_INPUT", "unavailable"],
  ];
  for (const [code, expected] of cases) {
    const binding = repository();
    binding.failNext("readCommit", reviewArtifactError(code));
    expect(await failureOf(() => sourceOf(binding).log(COMMIT)), code).toBe(expected);
  }
  // The namespace's own NOT_FOUND (no repository yet) is not_found, not unavailable.
  const empty = fakeArtifactsReview();
  expect(await failureOf(() => new ArtifactsReviewSource(empty, REPO).log(COMMIT))).toBe(
    "not_found",
  );
});

// Catches: a binding that throws something that is not its own error being reported as a review
// failure, which turns a defect into "the commit is not there".
test("a defect is not a review failure", async () => {
  const binding = repository();
  binding.failNext("readTree", new TypeError("the binding is wired wrong"));
  await expect(sourceOf(binding).readTree(COMMIT, "")).rejects.toBeInstanceOf(TypeError);
});

// Catches: an answer the binding changed shape for being trusted, so a review reads fields that
// are not there.
test("an answer that is not the shape is unavailable, not a commit", async () => {
  // A binding whose answer ignores the type it promises: the adapter parses every answer at the
  // boundary, so a shape the service would never send is refused instead of read through.
  const loose = {
    get: () =>
      Promise.resolve({
        readCommit: () => Promise.resolve({ what: "not a commit" }),
        readTree: () => Promise.resolve([]),
        readFile: () => Promise.resolve(null),
      }),
  };
  // SAFETY: the answers are the shapes this case is about; the fake stands in for a binding whose
  // answer ignores the type it promises, which is exactly what the parse below refuses.
  const binding: ArtifactsReviewBinding = loose as never;
  const read = new ArtifactsReviewSource(binding, REPO);
  expect(await failureOf(() => read.log(COMMIT))).toBe("unavailable");
});

// Catches: a file larger than the limit answered whole, which the Worker cannot hold.
test("a file over the limit is too_large", async () => {
  const binding = repository();
  const small = new ArtifactsReviewSource(binding, REPO, 3);
  expect(await failureOf(() => small.readFile(COMMIT, "README.md"))).toBe("too_large");
  const read = sourceOf(binding);
  expect(new TextDecoder().decode((await read.readFile(COMMIT, "README.md")).bytes)).toBe("hns\n");
});

// Catches: the namespace lookup keeping its own error rule, so a `get` that throws something
// other than the binding's error is reported as a review failure instead of a defect (NB2).
test("the repository lookup follows the same throw rule as a read", async () => {
  const missing = fakeArtifactsReview();
  expect(await failureOf(() => new ArtifactsReviewSource(missing, REPO).log(COMMIT))).toBe(
    "not_found",
  );
  const broken = fakeArtifactsReview();
  broken.failNext("get", new TypeError("the namespace is wired wrong"));
  await expect(new ArtifactsReviewSource(broken, REPO).log(COMMIT)).rejects.toBeInstanceOf(
    TypeError,
  );
  const refused = fakeArtifactsReview();
  refused.failNext("get", reviewArtifactError("REMOTE_AUTH_REQUIRED"));
  expect(await failureOf(() => new ArtifactsReviewSource(refused, REPO).log(COMMIT))).toBe(
    "unauthorized",
  );
});
