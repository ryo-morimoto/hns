import { expect, expectTypeOf, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { ReviewCommit, ReviewFile, ReviewTreeEntry } from "@hns/core";
import { FakeReviewSource, ReviewSourceError, type ReviewSource } from "./source.ts";

/** What a review read of either shape answers with; the failure probe ignores the value. */
type ReviewRead = ReviewCommit | readonly ReviewTreeEntry[] | ReviewFile;

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const tree = "c".repeat(40);

const commit = (id: string, message: string): ReviewCommit => ({
  commit: id,
  tree,
  message,
  committedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
});

const blob = (path: string, object: string, size: number): ReviewTreeEntry => ({
  path,
  kind: "blob",
  object,
  size,
});

const file = (path: string, text: string): ReviewFile => ({
  path,
  object: "d".repeat(40),
  contentType: "text/plain",
  bytes: new TextEncoder().encode(text),
});

const source = (): ReviewSource =>
  new FakeReviewSource(
    new Map([
      [BASE, commit(BASE, "before")],
      [HEAD, commit(HEAD, "hns checkpoint run-1")],
    ]),
    new Map([
      [HEAD + ":", [blob("a.txt", "1".repeat(40), 2)]],
      [HEAD + ":src", [blob("a.ts", "2".repeat(40), 4)]],
    ]),
    new Map([[HEAD + ":a.txt", file("a.txt", "hi")]]),
  );

/** Read the failure a source refused with, or undefined when it answered. */
const failureOf = async (read: () => Promise<ReviewRead>): Promise<string | undefined> => {
  try {
    await read();
    return undefined;
  } catch (error) {
    return error instanceof ReviewSourceError ? error.code : "not-a-review-failure";
  }
};

// Catches: a source that only answers a ref name, so a moved ref would show different bytes.
test("the fake source reads a commit by its id", async () => {
  const read = await source().log(HEAD);
  expect(read).toStrictEqual(commit(HEAD, "hns checkpoint run-1"));
  expect(await source().log(BASE)).toStrictEqual(commit(BASE, "before"));
  expect(await failureOf(() => source().log("refs/hns/checkpoints/run-1"))).toBe("not_found");
});

// Catches: a tree read that walks recursively or refuses the root, so a reviewer cannot descend
// one directory at a time.
test("the fake source reads one directory at a time", async () => {
  const read = source();
  expect(await read.readTree(HEAD, "")).toStrictEqual([blob("a.txt", "1".repeat(40), 2)]);
  expect(await read.readTree(HEAD, "src")).toStrictEqual([blob("a.ts", "2".repeat(40), 4)]);
  expect(await failureOf(() => read.readTree(HEAD, "missing"))).toBe("not_found");
});

// Catches: a file read that returns text, which would corrupt an image or a binary file.
test("the fake source reads a file as bytes with a content type", async () => {
  const read = source().readFile(HEAD, "a.txt");
  expect(await read).toStrictEqual(file("a.txt", "hi"));
  expect(new TextDecoder().decode((await read).bytes)).toBe("hi");
  expectTypeOf(read).toEqualTypeOf<Promise<ReviewFile>>();
  expect(await failureOf(() => source().readFile(HEAD, "missing.txt"))).toBe("not_found");
});

// Catches: a path that leaves the tree being read as a path inside it, so a source could answer
// with another project's bytes.
test("the fake source refuses a path that leaves the tree", async () => {
  const read = source();
  for (const path of ["../a.txt", "/etc/passwd", "src/../../a.txt", "./a.txt", "a//b"]) {
    expect(await failureOf(() => read.readFile(HEAD, path)), path).toBe("invalid_request");
    expect(await failureOf(() => read.readTree(HEAD, path)), path).toBe("invalid_request");
  }
});

// Catches: a source whose failure carries no code, so a caller has to match a message.
test("a review failure is a typed error", async () => {
  const error = await source()
    .log(HEAD)
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  expect(error).toBeUndefined();
  const missing = await source()
    .log("0".repeat(40))
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  expect(missing).toBeInstanceOf(ReviewSourceError);
  expect(missing).toBeInstanceOf(Error);
  if (!(missing instanceof ReviewSourceError)) throw new Error("expected a review failure");
  expect(missing.code).toBe("not_found");
  expect(missing.name).toBe("ReviewSourceError");
});
