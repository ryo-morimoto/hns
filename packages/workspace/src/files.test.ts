import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  DIR_FLAGS,
  FileSystemFailure,
  namesOf,
  openParentChain,
  openTarget,
  versionAt,
} from "./files.ts";

let base = "";

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "hns-files-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The failure code a call raised, or "" when it did not raise. */
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "";
  } catch (error) {
    if (error instanceof FileSystemFailure) return error.code;
    throw error;
  }
}

// Catches: a path that reaches the kernel with a separator or a parent segment,
// so the walk stops being one component per directory.
test("a path is a list of single component names", () => {
  expect(namesOf(["a.txt"])).toStrictEqual(["a.txt"]);
  expect(namesOf(["dir", "a.txt"])).toStrictEqual(["dir", "a.txt"]);
  for (const bad of [[], [""], ["."], [".."], ["dir/a.txt"], ["a\0b"]]) {
    let code = "";
    try {
      namesOf(bad);
    } catch (error) {
      if (!(error instanceof FileSystemFailure)) throw error;
      code = error.code;
    }
    expect(code, JSON.stringify(bad)).toBe("invalid");
  }
});

// Catches: a version that is not the bytes on disk, so expectedVersion can never match.
test("the version of a file is the sha256 of its content", async () => {
  const root = await open(base, DIR_FLAGS);
  try {
    const empty = await versionAt(root, undefined, "missing.txt");
    expect(empty).toBe("absent");
    await writeFile(join(base, "a.txt"), "hello");
    const version = await versionAt(root, undefined, "a.txt");
    expect(version).toBe("sha256:" + createHash("sha256").update("hello").digest("hex"));
  } finally {
    await root.close();
  }
});

// Catches: a directory read as a file, which would let a write replace it.
test("a directory is not a regular file", async () => {
  const root = await open(base, DIR_FLAGS);
  try {
    await mkdir(join(base, "dir"));
    expect(await codeOf(versionAt(root, undefined, "dir"))).toBe("is_directory");
  } finally {
    await root.close();
  }
});

// Catches: a symbolic link resolved during the walk, which would leave the root.
test("a symbolic link is never followed", async () => {
  const outside = await mkdtemp(join(tmpdir(), "hns-files-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await mkdir(join(base, "real"));
  await symlink(outside, join(base, "link"));
  const root = await open(base, DIR_FLAGS);
  try {
    // O_DIRECTORY | O_NOFOLLOW reports a link as "not a directory", never walks it.
    expect(await codeOf(openParentChain(root, ["link"]))).toBe("not_directory");
    const parent = await openParentChain(root, ["real"]);
    try {
      await symlink(join(outside, "secret.txt"), join(base, "real", "a.txt"));
      expect(
        await codeOf(
          openTarget(root, parent, "a.txt").then(async (handle) => {
            await handle.close();
          }),
        ),
      ).toBe("invalid");
    } finally {
      if (parent !== undefined) await parent.close();
    }
  } finally {
    await root.close();
    await rm(outside, { recursive: true, force: true });
  }
});
