import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { ReviewCommit, ReviewFile, ReviewTreeEntry } from "@hns/core";
import { FakeReviewSource, ReviewSourceError } from "./source.ts";
import type { ReviewSource } from "./source.ts";
import { reviewDiff } from "./service.ts";

const enc = new TextEncoder();
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

const commit = (id: string, message: string): ReviewCommit => ({
  commit: id,
  tree: id === BASE ? "1".repeat(40) : "2".repeat(40),
  message,
  committedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
});

const blob = (path: string, object: string, size: number): ReviewTreeEntry => ({
  path,
  kind: "blob",
  mode: "100644",
  object,
  size,
});

/** A symlink entry: a blob whose bytes are the link target, told apart by its mode. */
const symlink = (path: string, object: string, size: number): ReviewTreeEntry => ({
  path,
  kind: "blob",
  mode: "120000",
  object,
  size,
});

/** A directory entry. */
const tree = (path: string, object: string): ReviewTreeEntry => ({
  path,
  kind: "tree",
  mode: "40000",
  object,
  size: 0,
});

const file = (path: string, object: string, text: string): ReviewFile => ({
  path,
  object,
  contentType: "text/plain",
  bytes: enc.encode(text),
});

/**
 * A source whose commits are `(trees by path, files by path)` per side, so a diff test names only
 * what it needs.
 */
const sourceOf = (options: {
  readonly base: Readonly<Record<string, string>>;
  readonly head: Readonly<Record<string, string>>;
  readonly baseDirs?: Readonly<Record<string, readonly ReviewTreeEntry[]>>;
  readonly headDirs?: Readonly<Record<string, readonly ReviewTreeEntry[]>>;
}): ReviewSource => {
  const trees = new Map<string, readonly ReviewTreeEntry[]>();
  const files = new Map<string, ReviewFile>();
  const add = (
    id: string,
    contents: Readonly<Record<string, string>>,
    dirs: Readonly<Record<string, readonly ReviewTreeEntry[]>>,
  ): void => {
    const entries: ReviewTreeEntry[] = [];
    for (const [path, text] of Object.entries(contents)) {
      // The object id is derived from the content, not the side: the same bytes on both sides are
      // the same object, which is what a tree says and what the diff compares.
      const object = path + "-" + text;
      entries.push(blob(path, object, text.length));
      files.set(id + ":" + path, file(path, object, text));
    }
    for (const [dir, dirEntries] of Object.entries(dirs)) trees.set(id + ":" + dir, dirEntries);
    // A directory entry is listed in its parent: the root here, one level deep.
    for (const dir of Object.keys(dirs)) entries.push(tree(dir, dir + "-tree"));
    trees.set(id + ":", entries);
  };
  add(BASE, options.base, options.baseDirs ?? {});
  add(HEAD, options.head, options.headDirs ?? {});
  return new FakeReviewSource(
    new Map([
      [BASE, commit(BASE, "before")],
      [HEAD, commit(HEAD, "after")],
    ]),
    trees,
    files,
  );
};

/** The result's diff or the failure code, so an assertion names one thing. */
const diffOf = async (result: Awaited<ReturnType<typeof reviewDiff>>) => {
  if (!result.ok) throw new Error("expected a diff, got " + result.failure + ": " + result.message);
  return result.diff;
};

// Catches: a diff that lists a path whose bytes are the same on both sides, so a reviewer opens
// unchanged files and cannot tell what changed.
test("lists only the paths whose bytes changed, and their hunk lines", async () => {
  const diff = await diffOf(
    await reviewDiff(
      sourceOf({
        base: { "same.txt": "unchanged\n", "edit.txt": "one\ntwo\nthree\n" },
        head: { "same.txt": "unchanged\n", "edit.txt": "one\nTWO\nthree\nfour\n" },
      }),
      BASE,
      HEAD,
    ),
  );
  expect(diff.files.map((file) => file.path)).toStrictEqual(["edit.txt"]);
  const [edit] = diff.files;
  expect(edit?.kind).toBe("modified");
  expect(edit?.hunks).toHaveLength(1);
  expect(edit?.hunks[0]?.lines.map((line) => line.kind + " " + line.text)).toStrictEqual([
    "context one",
    "del two",
    "add TWO",
    "context three",
    "add four",
  ]);
  expect(diff.added).toBe(2);
  expect(diff.removed).toBe(1);
});

// Catches: an added or deleted file with no hunks, which a viewer would show as an empty change.
test("an added file is all additions and a deleted file all deletions", async () => {
  const diff = await diffOf(
    await reviewDiff(
      sourceOf({ base: { "gone.txt": "a\nb\n" }, head: { "new.txt": "c\n" } }),
      BASE,
      HEAD,
    ),
  );
  const byPath = new Map(diff.files.map((file) => [file.path, file]));
  expect(byPath.get("new.txt")?.kind).toBe("added");
  expect(byPath.get("new.txt")?.hunks[0]?.lines.map((line) => line.kind)).toStrictEqual(["add"]);
  expect(byPath.get("gone.txt")?.kind).toBe("deleted");
  expect(byPath.get("gone.txt")?.hunks[0]?.lines.map((line) => line.kind)).toStrictEqual([
    "del",
    "del",
  ]);
  expect(diff.added).toBe(1);
  expect(diff.removed).toBe(2);
});

// Catches: hunks that are one run over the whole file, so a one-line change in a large file makes
// the viewer send the whole file.
test("hunks keep three lines of context and skip the unchanged middle", async () => {
  const before =
    Array.from({ length: 20 }, (_, index) => "line " + String(index)).join("\n") + "\n";
  const afterLines = before.split("\n");
  afterLines[10] = "CHANGED";
  const diff = await diffOf(
    await reviewDiff(
      sourceOf({ base: { "a.txt": before }, head: { "a.txt": afterLines.join("\n") } }),
      BASE,
      HEAD,
    ),
  );
  const hunks = diff.files[0]?.hunks ?? [];
  expect(hunks).toHaveLength(1);
  // Three unchanged lines either side of one deletion and one addition: eight lines, not the whole
  // twenty-line file.
  expect(hunks[0]?.lines).toHaveLength(8);
  expect(hunks[0]?.lines.map((line) => line.kind)).toStrictEqual([
    "context",
    "context",
    "context",
    "del",
    "add",
    "context",
    "context",
    "context",
  ]);
  // The hunk starts three lines before the change, so on both sides line 8 (1-based).
  expect(hunks[0]?.baseStart).toBe(8);
  expect(hunks[0]?.headStart).toBe(8);
});

// Catches: a directory walk that reads only the root, so a change under `src/` never appears.
test("walks into a directory on both sides", async () => {
  const source = sourceOf({
    base: { "a.txt": "x\n" },
    head: { "a.txt": "x\n" },
    baseDirs: {
      src: [blob("b.ts", "src-b-base", 1)],
    },
    headDirs: {
      src: [blob("b.ts", "src-b-head", 2)],
    },
  });
  // The nested file needs its own content on each side; the fake reads by `<commit>:<path>`.
  const withFiles = new FakeReviewSource(
    new Map([
      [BASE, commit(BASE, "before")],
      [HEAD, commit(HEAD, "after")],
    ]),
    new Map([
      // The same object id on both sides: the root file is unchanged and must not appear.
      [BASE + ":", [blob("a.txt", "a-same", 2), tree("src", "src-tree")]],
      [HEAD + ":", [blob("a.txt", "a-same", 2), tree("src", "src-tree")]],
      [BASE + ":src", [blob("b.ts", "b-base", 2)]],
      [HEAD + ":src", [blob("b.ts", "b-head", 2)]],
    ]),
    new Map([
      [BASE + ":a.txt", file("a.txt", "a-same", "x\n")],
      [HEAD + ":a.txt", file("a.txt", "a-same", "x\n")],
      [BASE + ":src/b.ts", file("b.ts", "b-base", "one\n")],
      [HEAD + ":src/b.ts", file("b.ts", "b-head", "two\n")],
    ]),
  );
  void source;
  const diff = await diffOf(await reviewDiff(withFiles, BASE, HEAD));
  expect(diff.files.map((file) => file.path)).toStrictEqual(["src/b.ts"]);
  expect(diff.files[0]?.hunks[0]?.lines.map((line) => line.kind + " " + line.text)).toStrictEqual([
    "del one",
    "add two",
  ]);
});

// Catches: a binary file whose bytes are decoded as text, so the viewer gets replacement characters
// and a hunk that is not the change.
test("a binary file is listed without hunks", async () => {
  const source = new FakeReviewSource(
    new Map([
      [BASE, commit(BASE, "before")],
      [HEAD, commit(HEAD, "after")],
    ]),
    new Map([
      [BASE + ":", [blob("logo.png", "p-base", 4)]],
      [HEAD + ":", [blob("logo.png", "p-head", 4)]],
    ]),
    new Map([
      [
        BASE + ":logo.png",
        {
          path: "logo.png",
          object: "p-base",
          contentType: "image/png",
          bytes: Uint8Array.from([0x89, 0x50, 0x00, 0x01]),
        },
      ],
      [
        HEAD + ":logo.png",
        {
          path: "logo.png",
          object: "p-head",
          contentType: "image/png",
          bytes: Uint8Array.from([0x89, 0x50, 0x00, 0x02]),
        },
      ],
    ]),
  );
  const diff = await diffOf(await reviewDiff(source, BASE, HEAD));
  expect(diff.files.map((file) => file.path)).toStrictEqual(["logo.png"]);
  expect(diff.files[0]?.hunks).toStrictEqual([]);
  expect(diff.added).toBe(0);
});

// Catches: a source failure swallowed into an empty diff, which a reviewer would read as "nothing
// changed" — the one answer a review must never give for a read it could not make.
test("a source failure is the result, not an empty diff", async () => {
  const failing: ReviewSource = {
    log: (id: string) => Promise.resolve(commit(id, "m")),
    readTree: () => Promise.reject(new ReviewSourceError("unavailable", "the store is down")),
    readFile: () => Promise.reject(new ReviewSourceError("not_found", "no file")),
  };
  const result = await reviewDiff(failing, BASE, HEAD);
  expect(result).toStrictEqual({ ok: false, failure: "unavailable", message: "the store is down" });
});

// Catches: a failure on one file being reported as a failure of the whole store, or the path being
// dropped from the message so a caller cannot say which file it was.
test("a failure names the path it happened at", async () => {
  const source: ReviewSource = {
    log: (id: string) => Promise.resolve(commit(id, "m")),
    readTree: (id: string, path: string) => {
      if (path !== "") return Promise.reject(new ReviewSourceError("not_found", "no " + path));
      return Promise.resolve([blob("big.txt", id === BASE ? "b1" : "b2", 1)]);
    },
    readFile: (id: string, path: string) =>
      Promise.reject(new ReviewSourceError("too_large", JSON.stringify(path) + " is too large")),
  };
  const result = await reviewDiff(source, BASE, HEAD);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.failure).toBe("too_large");
  expect(result.message).toContain("big.txt");
});

// Catches: a defect (an exception that is not a review failure) reported as a review failure, so a
// programming error looks like a store condition.
test("a defect is not reported as a review failure", async () => {
  const broken: ReviewSource = {
    log: () => Promise.reject(new TypeError("a defect")),
    readTree: () => Promise.resolve([]),
    readFile: () => Promise.resolve(file("a", "a", "")),
  };
  await expect(reviewDiff(broken, BASE, HEAD)).rejects.toBeInstanceOf(TypeError);
});

// Catches: a diff that reads the same commit twice as two sides and reports every file as changed.
test("the same commit on both sides is no change", async () => {
  const diff = await diffOf(
    await reviewDiff(
      sourceOf({ base: { "a.txt": "same\n" }, head: { "a.txt": "same\n" } }),
      BASE,
      BASE,
    ),
  );
  expect(diff.files).toStrictEqual([]);
});
// Catches: a symlink shown as a file, so a reviewer reads a link as the content it points at and
// approves a change that is not there.
test("a symlink is a symlink in the diff, not a file", async () => {
  const source = new FakeReviewSource(
    new Map([
      [BASE, commit(BASE, "before")],
      [HEAD, commit(HEAD, "after")],
    ]),
    new Map([
      [BASE + ":", [symlink("link", "link-base", 5)]],
      [HEAD + ":", [symlink("link", "link-head", 6)]],
    ]),
    new Map([
      [BASE + ":link", file("link", "link-base", "a.txt")],
      [HEAD + ":link", file("link", "link-head", "b.txt\n")],
    ]),
  );
  const diff = await diffOf(await reviewDiff(source, BASE, HEAD));
  expect(diff.files.map((file) => [file.path, file.kind, file.entryKind])).toStrictEqual([
    ["link", "modified", "symlink"],
  ]);
});
