import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { checkpointPackKey } from "@hns/workspace/objects";
import type { ObjectBody, ObjectMetadata } from "@hns/workspace/objects";
import { R2ReviewSource } from "../../src/review/r2.ts";
import { reviewDiff } from "../../src/review/service.ts";

/**
 * The review path over a pack git produced: the part a fixture cannot prove.
 *
 * @remarks
 * The unit tests build their own packs, so they prove the reader and the service against bytes this
 * repository wrote. This suite takes a real repository, lets git build the pack a checkpoint would
 * upload, and reads it back through `R2ReviewSource` and `reviewDiff`. It needs git, which every
 * machine running hns has; it needs no cf, network, or machine.
 */
const created: string[] = [];

afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

/**
 * The environment every fixture's git runs in, with the repository variables removed.
 *
 * @remarks
 * A `GIT_DIR` or `GIT_WORK_TREE` inherited from the process that starts the tests would make
 * `git init` in a temp directory describe and commit to the *inherited* repository instead. Removing
 * them makes each fixture's git resolve its own repository, the only one it may write.
 */
const fixtureEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
  ]) {
    delete env[name];
  }
  return env;
};

/** Run git in cwd and answer its stdout as text. */
const git = (cwd: string, args: readonly string[], input?: string): string =>
  execFileSync("git", args, { cwd, input, encoding: "utf8", env: fixtureEnv() });

/** Run git in cwd and answer its raw stdout. */
const gitBytes = (cwd: string, args: readonly string[]): Buffer =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: fixtureEnv() });

/** A repository committed twice; each commit stands alone, as a checkpoint commit does. */
const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hns-review-pack-"));
  created.push(root);
  git(root, ["init", "-q"]);
  // A probe first: if git answers with another toplevel, an inherited GIT_* variable redirected it,
  // and every commit below would land in a real repository.
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]).trim();
  if (toplevel !== root) {
    throw new Error("git resolved " + root + " to " + toplevel + " (an inherited GIT_* variable)");
  }
  // Each fixture owns its own object store, so the test never asks git where objects live.
  git(root, ["config", "core.bare", "false"]);
  git(root, ["config", "user.email", "hns@example.com"]);
  git(root, ["config", "user.name", "hns"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "a.txt"), "first\nsecond\nthird\n");
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "nested.txt"), "nested\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "hns checkpoint base"]);
  await writeFile(join(root, "a.txt"), "first\nSECOND\nthird\nfourth\n");
  await writeFile(join(root, "added.txt"), "brand new\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "hns checkpoint head"]);
  return root;
};

/**
 * The pack a checkpoint of commit uploads: the objects reachable from it, as a closure.
 *
 * @remarks
 * pack-objects over a rev-list closure is what the machine sends, so the bytes are the ones
 * checkpoints/<commit>.pack holds in R2. --window lets git delta similar blobs, which is the case
 * a reader has to undo.
 */
const checkpointPack = (root: string, commit: string): Uint8Array => {
  const listing = git(root, ["rev-list", "--objects", commit]);
  const pack = execFileSync("git", ["pack-objects", "--window=50", "--depth=50", "--stdout"], {
    cwd: root,
    env: fixtureEnv(),
    input: listing,
  });
  return new Uint8Array(pack);
};

/** A bucket that answers the packs it holds, and null for a key it does not. */
class PackBucket {
  readonly #stored = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): void {
    this.#stored.set(key, bytes);
  }

  async get(key: string): Promise<ObjectBody | null> {
    const bytes = this.#stored.get(key);
    if (bytes === undefined) return null;
    return { arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array(bytes).buffer };
  }

  head(key: string): Promise<ObjectMetadata | null> {
    const bytes = this.#stored.get(key);
    return Promise.resolve(bytes === undefined ? null : { key, size: bytes.length });
  }
}

// Catches: a reader or a diff that works on its own fixtures but not on the bytes git actually
// writes, so a real checkpoint cannot be reviewed.
test("reads a real checkpoint pack into the same files and bytes git has", async () => {
  const root = await repository();
  const base = git(root, ["rev-parse", "HEAD~1"]).trim();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const bucket = new PackBucket();
  bucket.put(checkpointPackKey(base), checkpointPack(root, base));
  bucket.put(checkpointPackKey(head), checkpointPack(root, head));
  const source = new R2ReviewSource(bucket);

  const log = await source.log(head);
  expect(log.commit).toBe(head);
  expect(log.tree).toBe(git(root, ["rev-parse", head + "^{tree}"]).trim());
  // git stores the message with the newline git wrote after it.
  expect(log.message).toBe("hns checkpoint head\n");

  const result = await reviewDiff(source, base, head);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.diff.files.map((file) => file.path)).toStrictEqual(["a.txt", "added.txt"]);
  for (const path of ["a.txt", "added.txt"]) {
    const read = await source.readFile(head, path);
    const theirs = gitBytes(root, ["cat-file", "blob", head + ":" + path]);
    expect(Buffer.from(read.bytes).equals(theirs), path).toBe(true);
  }
});

// Catches: a diff whose hunks differ from what the file changed, so a reviewer approves a change
// they did not see.
test("the hunks of a real change name every changed line", async () => {
  const root = await repository();
  const base = git(root, ["rev-parse", "HEAD~1"]).trim();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const bucket = new PackBucket();
  bucket.put(checkpointPackKey(base), checkpointPack(root, base));
  bucket.put(checkpointPackKey(head), checkpointPack(root, head));
  const result = await reviewDiff(new R2ReviewSource(bucket), base, head);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const edit = result.diff.files.find((file) => file.path === "a.txt");
  expect(edit?.kind).toBe("modified");
  const lines = (edit?.hunks ?? []).flatMap((hunk) =>
    hunk.lines.map((line) => line.kind + " " + line.text),
  );
  expect(lines).toStrictEqual([
    "context first",
    "del second",
    "add SECOND",
    "context third",
    "add fourth",
  ]);
  const added = result.diff.files.find((file) => file.path === "added.txt");
  expect(added?.kind).toBe("added");
  const addedLines = (added?.hunks ?? []).flatMap((hunk) =>
    hunk.lines.map((line) => line.kind + " " + line.text),
  );
  expect(addedLines).toStrictEqual(["add brand new"]);
});

// Catches: a directory read that only works on a fixture tree, so a repository with subdirectories
// cannot be browsed.
test("lists a real repository one directory at a time", async () => {
  const root = await repository();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const bucket = new PackBucket();
  bucket.put(checkpointPackKey(head), checkpointPack(root, head));
  const source = new R2ReviewSource(bucket);

  const expected = git(root, ["ls-tree", head])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("\t");
      const meta = (parts[0] ?? "").split(" ");
      const name = parts[1] ?? "";
      const object = meta[2] ?? "";
      const isTree = meta[1] === "tree";
      const size = isTree ? 0 : gitBytes(root, ["cat-file", "blob", object]).length;
      const mode = meta[0] === "040000" ? "40000" : (meta[0] ?? "");
      return { path: name, kind: isTree ? "tree" : "blob", mode, object, size };
    });
  expect(await source.readTree(head, "")).toStrictEqual(expected);
  expect((await source.readTree(head, "dir")).map((entry) => entry.path)).toStrictEqual([
    "nested.txt",
  ]);
});

// Catches: a missing pack read as an empty commit, which a review would show as nothing exists.
test("a commit whose pack is absent is not_found, not an empty tree", async () => {
  const root = await repository();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  void root;
  const source = new R2ReviewSource(new PackBucket());
  const failure = await source.log(head).then(
    () => undefined,
    (cause: { code?: string }) => cause.code,
  );
  expect(failure).toBe("not_found");
  const result = await reviewDiff(source, head, head);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.failure).toBe("not_found");
});
// Catches: a real repository whose symlink or binary file is shown as text, so the diff a reviewer
// reads is not the change git recorded.
test("a real symlink and a real binary file are diffed by their kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "hns-review-kinds-"));
  created.push(root);
  git(root, ["init", "-q"]);
  if (git(root, ["rev-parse", "--show-toplevel"]).trim() !== root) {
    throw new Error("git resolved " + root + " to a repository it did not create");
  }
  git(root, ["config", "user.email", "hns@example.com"]);
  git(root, ["config", "user.name", "hns"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "target.txt"), "one\n");
  await writeFile(join(root, "logo.png"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "hns checkpoint base"]);
  // A symlink is written by the filesystem, not by git, so git records its mode as 120000.
  await import("node:fs/promises").then((fs) => fs.symlink("target.txt", join(root, "link")));
  await writeFile(join(root, "logo.png"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "hns checkpoint head"]);
  const base = git(root, ["rev-parse", "HEAD~1"]).trim();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const bucket = new PackBucket();
  bucket.put(checkpointPackKey(base), checkpointPack(root, base));
  bucket.put(checkpointPackKey(head), checkpointPack(root, head));

  const source = new R2ReviewSource(bucket);
  // The walk is a directory read; it must never follow a symlink, so the root listing is asked for
  // and the link is inspected there.
  const listing = await source.readTree(head, "");
  const link = listing.find((entry) => entry.path === "link");
  expect(link?.mode).toBe("120000");
  expect(link?.kind).toBe("blob");
  expect(new TextDecoder().decode((await source.readFile(head, "link")).bytes)).toBe("target.txt");

  const result = await reviewDiff(source, base, head);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const kinds = result.diff.files.map((file) => [file.path, file.entryKind]);
  expect(kinds).toStrictEqual([
    ["link", "symlink"],
    ["logo.png", "blob"],
  ]);
  // The binary change is listed, with no hunks: decoding it as text would invent lines.
  expect(result.diff.files.find((file) => file.path === "logo.png")?.hunks).toStrictEqual([]);
});
