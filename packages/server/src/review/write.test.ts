import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import type { ReviewCommit, ReviewFile, ReviewTreeEntry } from "@hns/core";
import { versionOf } from "@hns/workspace";
import { FakeReviewSource } from "./source.ts";
import { writeHunkAt, writeHunk } from "./write.ts";

/**
 * The hunk writes (C1) against the Workspace's real versioned write and a real file.
 *
 * @remarks
 * `applyVersionedWrite` is the production function: it resolves the project directory with
 * `O_NOFOLLOW`, compares the file's version, writes a temp, and renames below the held parent.
 * The bytes it writes are read from the commits (a `FakeReviewSource`: a checkpoint pack needs R2
 * and a machine), and the file is a temporary directory, so what is proven is the rule the UI
 * must not bypass: **the write is conditional on the version the caller saw, and a file that
 * moved is a conflict.**
 */

const enc = new TextEncoder();
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const PROJECT = "review-face";

const commit = (id: string): ReviewCommit => ({
  commit: id,
  tree: id === BASE ? "1".repeat(40) : "2".repeat(40),
  message: "checkpoint",
  committedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
});

const blob = (path: string, object: string, size: number): ReviewTreeEntry => ({
  path,
  kind: "blob",
  mode: "100644",
  object,
  size,
});

const file = (path: string, object: string, text: string): ReviewFile => ({
  path,
  object,
  contentType: "text/plain",
  bytes: enc.encode(text),
});

/**
 * A source whose `src/app.ts` differs between base and head, and whose `added.txt` is new.
 *
 * @remarks
 * The head side is three lines and the base one, so the diff has a hunk with an add and a del;
 * `added.txt` is a path the base does not have, which is what `undo` has to define (write it
 * empty rather than delete it).
 */
function sourceOf(): FakeReviewSource {
  return new FakeReviewSource(
    new Map([
      [BASE, commit(BASE)],
      [HEAD, commit(HEAD)],
    ]),
    new Map<string, readonly ReviewTreeEntry[]>([
      [BASE + ":", [blob("src/app.ts", "app-base", 13)]],
      [HEAD + ":", [blob("src/app.ts", "app-head", 39), blob("added.txt", "added", 6)]],
    ]),
    new Map<string, ReviewFile>([
      [BASE + ":src/app.ts", file("src/app.ts", "app-base", "const a = 1;\n")],
      [
        HEAD + ":src/app.ts",
        file("src/app.ts", "app-head", "const a = 1;\nconst b = 2;\nconst c = 3;\n"),
      ],
      [HEAD + ":added.txt", file("added.txt", "added", "new\n")],
    ]),
  );
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hns-review-write-"));
  await mkdir(join(root, PROJECT, "src"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The input every write names: the Change, the path, and the version the caller saw. */
function inputFor(path: string, expectedVersion: string) {
  return {
    changeId: "change-1",
    base: BASE,
    head: HEAD,
    path,
    headStart: 1,
    expectedVersion,
    actor: "owner",
  };
}

/** The path the test's file lives at, below the project directory in the root. */
const appPath = (): string => join(root, PROJECT, "src", "app.ts");

/** The bytes a file holds now. */
async function read(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

/**
 * Keep writes the head side, when the file is where the caller saw it.
 *
 * @remarks
 * Catches a keep that writes the base (an undo), a keep that writes nothing, and a diff re-read
 * that is not the server's answer.
 */
test("keep writes the head side when the file is at the version the caller saw", async () => {
  const before = "const a = 1;\n";
  await writeFile(appPath(), before);
  const result = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "keep",
    inputFor("src/app.ts", versionOf(enc.encode(before))),
  );
  expect(result.ok).toBe(true);
  expect(await read(appPath())).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
});

/**
 * Undo writes the base side: the hunk is reverted to the commit the Trail started from.
 *
 * @remarks
 * Catches an undo that keeps the head, and a path the base does not have being left alone: a file
 * the Change added is written empty (deleting a file is a workspace operation, not a hunk's).
 */
test("undo writes the base side, and a file the base lacks is written empty", async () => {
  const after = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
  await writeFile(appPath(), after);
  const reverted = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "undo",
    inputFor("src/app.ts", versionOf(enc.encode(after))),
  );
  expect(reverted.ok).toBe(true);
  expect(await read(appPath())).toBe("const a = 1;\n");

  await writeFile(join(root, PROJECT, "added.txt"), "new\n");
  const added = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "undo",
    inputFor("added.txt", versionOf(enc.encode("new\n"))),
  );
  expect(added.ok).toBe(true);
  expect(await read(join(root, PROJECT, "added.txt"))).toBe("");
});

/**
 * A file that moved since the caller read it is a conflict, and nothing is written.
 *
 * @remarks
 * **This is the rule C1 rests on** (D104: the UI is not the authority). Catches a hunk write that
 * overwrites whatever is on disk — a keep that silently throws away an edit made after the diff
 * was read. The conflict names the version that is there now, for the screen to say.
 */
test("a file that moved is a conflict, and its bytes are untouched", async () => {
  const seen = "const a = 1;\n";
  await writeFile(appPath(), seen);
  // Someone else saves between the read and the write.
  await writeFile(appPath(), "const a = 0; // edited elsewhere\n");
  const result = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "keep",
    inputFor("src/app.ts", versionOf(enc.encode(seen))),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a conflict");
  expect(result.code).toBe("conflict");
  expect(result.currentVersion).toBe(versionOf(enc.encode("const a = 0; // edited elsewhere\n")));
  expect(await read(appPath())).toBe("const a = 0; // edited elsewhere\n");
});

/**
 * Apply resolves a hunk from the side that has the file.
 *
 * @remarks
 * Catches an apply that always takes one side: a path the head has is the head's bytes, and a path
 * only the base has is the base's. The line-level choice is the screen's; what the server writes
 * is the bytes of the side the screen resolved to, and it is still versioned.
 */
test("apply writes the side that has the file", async () => {
  // The file is the empty file `versionOf` names for zero bytes, which is what a caller that read
  // it reports; the write then lands because the file is still that empty file.
  await writeFile(appPath(), "");
  const applied = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "apply",
    inputFor("src/app.ts", versionOf(new Uint8Array(0))),
  );
  expect(applied.ok).toBe(true);
  expect(await read(appPath())).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
});

/**
 * A path outside the project, or one neither commit has, is refused before any write.
 *
 * @remarks
 * Catches a path that leaves the tree (`../x`, an absolute path) reaching the file system, and a
 * hunk of a path no side has being written as an empty file.
 */
test("a path outside the tree and a path neither commit has are refused", async () => {
  const escaped = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "keep",
    inputFor("../escape.txt", "absent"),
  );
  expect(escaped).toMatchObject({ ok: false, code: "invalid_request" });
  const absolute = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "keep",
    inputFor("/etc/passwd", "absent"),
  );
  expect(absolute).toMatchObject({ ok: false, code: "invalid_request" });
  const missing = await writeHunkAt(
    sourceOf(),
    { root, projectRoot: PROJECT },
    "keep",
    inputFor("src/none.ts", "absent"),
  );
  expect(missing).toMatchObject({ ok: false, code: "not_found" });
});

/**
 * The Worker's port has no writable workspace, and says so rather than pretending.
 *
 * @remarks
 * Catches a production `hunk` that reports success it did not achieve: with no target, `writeHunk`
 * answers `unavailable` and writes nothing, which is what the report says is not yet turned on.
 */
test("without a writable workspace the write is unavailable, not a success", async () => {
  const result = await writeHunk(sourceOf(), "keep", inputFor("src/app.ts", "absent"), "request-1");
  expect(result).toMatchObject({ ok: false, code: "unavailable" });
});
