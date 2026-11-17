import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  DIR_FLAGS,
  FileSystemFailure,
  applyVersionedWrite,
  namesOf,
  openParentChain,
  openTarget,
  versionAt,
  versionOf,
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
/** Create a file below the temp root, making parents as needed. */
async function seed(relativePath: string, content: string): Promise<void> {
  const target = join(base, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

/** The temp names left anywhere below the base directory. */
async function tempNames(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.startsWith(".hns-tmp-")) found.push(path);
    }
  };
  await walk(base);
  return found;
}

// Catches: a write that renames across directories, or one that leaves its temp.
test("a write replaces the target from its own directory and leaves no temp", async () => {
  await seed("project/a.txt", "one");
  const outcome = await applyVersionedWrite({
    root: base,
    projectRoot: "project",
    path: "a.txt",
    content: new TextEncoder().encode("two"),
    expectedVersion: versionOf(new TextEncoder().encode("one")),
    contentHash: versionOf(new TextEncoder().encode("two")),
  });
  expect(outcome.status).toBe("applied");
  expect(await readFile(join(base, "project/a.txt"), "utf8")).toBe("two");
  expect(await tempNames()).toStrictEqual([]);
});

// Catches: a stale expectedVersion silently overwriting the winner.
test("a stale expected version writes nothing", async () => {
  await seed("project/a.txt", "one");
  const outcome = await applyVersionedWrite({
    root: base,
    projectRoot: "project",
    path: "a.txt",
    content: new TextEncoder().encode("two"),
    expectedVersion: "sha256:" + "0".repeat(64),
    contentHash: versionOf(new TextEncoder().encode("two")),
  });
  expect(outcome.status).toBe("conflict");
  expect(await readFile(join(base, "project/a.txt"), "utf8")).toBe("one");
  expect(await tempNames()).toStrictEqual([]);
});

// Catches: a retry after a crash rewriting the file instead of settling as applied.
test("a retry that finds its own content reports applied", async () => {
  await seed("project/a.txt", "two");
  const outcome = await applyVersionedWrite({
    root: base,
    projectRoot: "project",
    path: "a.txt",
    content: new TextEncoder().encode("two"),
    expectedVersion: "absent",
    contentHash: versionOf(new TextEncoder().encode("two")),
  });
  expect(outcome.status).toBe("applied");
});

// Catches: bytes that do not match the intent's hash being written anyway.
test("bytes that do not match the intent hash are refused before writing", async () => {
  await seed("project/a.txt", "one");
  expect(
    await codeOf(
      applyVersionedWrite({
        root: base,
        projectRoot: "project",
        path: "a.txt",
        content: new TextEncoder().encode("two"),
        expectedVersion: "absent",
        contentHash: "sha256:" + "0".repeat(64),
      }),
    ),
  ).toBe("invalid");
  expect(await readFile(join(base, "project/a.txt"), "utf8")).toBe("one");
});

// Catches: a path or project root that climbs out, and a middle link that redirects
// the write into a sibling project.
test("a path cannot leave its project and a link is not followed", async () => {
  await mkdir(join(base, "one"));
  await mkdir(join(base, "two"));
  await seed("two/secret.txt", "secret");
  await symlink(join(base, "two"), join(base, "one", "link"));
  const content = new TextEncoder().encode("x");
  const attemptWrite = (projectRoot: string, path: string) =>
    applyVersionedWrite({
      root: base,
      projectRoot,
      path,
      content,
      expectedVersion: "absent",
      contentHash: versionOf(content),
    });
  // A parent link reports "not a directory": O_DIRECTORY | O_NOFOLLOW refuses it
  // before walking, which is the same refusal as a parent segment.
  for (const [projectRoot, path, code] of [
    ["one", "../two/secret.txt", "invalid"],
    ["../two", "secret.txt", "invalid"],
    ["one/link", "secret.txt", "not_directory"],
    ["/etc", "passwd", "invalid"],
  ] as const) {
    expect(await codeOf(attemptWrite(projectRoot, path)), projectRoot + " " + path).toBe(code);
  }
  expect(await readFile(join(base, "two/secret.txt"), "utf8")).toBe("secret");
});

// Catches: a final component that is a link or a directory being replaced.
test("a symbolic link or a directory is never the target", async () => {
  await seed("two/secret.txt", "secret");
  await mkdir(join(base, "one"));
  await symlink(join(base, "two/secret.txt"), join(base, "one", "a.txt"));
  await mkdir(join(base, "one", "dir"));
  const content = new TextEncoder().encode("x");
  const attemptWrite = (path: string) =>
    applyVersionedWrite({
      root: base,
      projectRoot: "one",
      path,
      content,
      expectedVersion: "absent",
      contentHash: versionOf(content),
    });
  expect(await codeOf(attemptWrite("a.txt"))).toBe("invalid");
  expect(await codeOf(attemptWrite("dir"))).toBe("is_directory");
  expect(await readFile(join(base, "two/secret.txt"), "utf8")).toBe("secret");
});

// Catches: a replaced root being written through.
test("a root that is no longer the one pinned is refused", async () => {
  await seed("project/a.txt", "one");
  const content = new TextEncoder().encode("two");
  expect(
    await codeOf(
      applyVersionedWrite({
        root: base,
        identity: { dev: 0, ino: 0 },
        projectRoot: "project",
        path: "a.txt",
        content,
        expectedVersion: "absent",
        contentHash: versionOf(content),
      }),
    ),
  ).toBe("root_replaced");
  expect(await readFile(join(base, "project/a.txt"), "utf8")).toBe("one");
});
