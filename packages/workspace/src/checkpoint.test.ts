import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CheckpointError, checkpointRun } from "./checkpoint.ts";

/**
 * The checkpoint against a real repository.
 *
 * @remarks
 * git is the subject, not a mock: the ref, the parent-less commit, and the pack's objects are
 * what restore will read. Each test makes a throwaway repository outside the hns tree. The tests
 * reach the source by relative path because the subpath export is what the machine's checkpoint
 * operation imports.
 */

const created: string[] = [];

/** A new empty directory, removed after the test. */
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hns-workspace-checkpoint-"));
  created.push(path);
  return path;
}

/**
 * Run git in a directory, with the caller's repository-location variables removed.
 *
 * @param root - The directory git runs in.
 * @param args - The subcommand and its arguments.
 * @param input - Bytes for git's stdin.
 * @returns git's stdout.
 *
 * @remarks
 * A commit hook exports `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` for the repository being
 * committed, and an inherited value would make a throwaway repository under /tmp resolve to that
 * one: `git init` would write nothing and `git add` would stage files in the real tree. The
 * checkpoint itself clears the same variables for the same reason.
 */
function git(root: string, args: readonly string[], input?: Uint8Array): string {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ]) {
    delete env[name];
  }
  return execFileSync("git", ["-C", root, ...args], {
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? { input: "" } : { input }),
  });
}

/** A repository with one commit and one untracked file. */
async function repository(): Promise<string> {
  const root = await directory();
  git(root, ["init", "-q"]);
  // A probe first: a repository that is not this directory means git was redirected, and every
  // later assertion would be measuring the wrong tree.
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]).trim();
  if (toplevel !== root) {
    throw new Error("git resolved " + root + " to " + toplevel + " (an inherited GIT_* variable)");
  }
  git(root, ["config", "user.email", "hns@example.com"]);
  git(root, ["config", "user.name", "hns"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  await writeFile(join(root, "untracked.txt"), "untracked\n");
  return root;
}

/** The objects of a pack, as `git index-pack` reports them. */
interface IndexedPack {
  readonly packHash: string;
  readonly objectCount: number;
  readonly types: readonly string[];
}

/**
 * Write a pack to a file and let git list what is in it.
 *
 * @param pack - The bytes the checkpoint produced.
 * @returns The pack's own id, its object count, and one entry per object.
 *
 * @remarks
 * `git index-pack` proves the bytes are a well-formed pack git can read: that is what restore
 * will do with the R2 copy, so the checkpoint test runs it here rather than trusting the pack
 * builder's own output.
 */
async function indexPack(pack: Uint8Array): Promise<IndexedPack> {
  const work = await directory();
  const file = join(work, "checkpoint.pack");
  await writeFile(file, pack);
  const packHash = git(work, ["index-pack", file]).trim();
  const listing = git(work, ["verify-pack", "-v", file]);
  // A verify-pack line is `<id> <type> <size> <offset> [<depth> <base>]`; the trailing summary
  // lines ("non delta: N objects", "chain length = ...") do not have a 40-hex id.
  const objects = listing.split("\n").filter((line) => /^[0-9a-f]{40} /u.test(line));
  return {
    packHash,
    objectCount: objects.length,
    types: objects.map((line) => (line.split(" ")[1] ?? "").trim()),
  };
}

afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

// Catches: a checkpoint result that leaves the pack's size or its largest blob for the caller
// to guess, which is what the machine's prepare answer has to report (0244).
test("a checkpoint reports the pack's size and its largest blob", async () => {
  const root = await repository();
  const checkpoint = await checkpointRun({ root, runId: "run-1", committedAt: 1_700_000_000 });

  await writeFile(join(root, "big.bin"), Buffer.alloc(5000, 7));
  const second = await checkpointRun({ root, runId: "run-2", committedAt: 1_700_000_001 });

  expect(checkpoint.packBytes).toBe(checkpoint.pack.byteLength);
  expect(second.packBytes).toBe(second.pack.byteLength);
  expect(second.maxBlobBytes).toBe(5000);
  // Both small text files are in the first pack; the second run's tree holds the larger one.
  expect(checkpoint.maxBlobBytes).toBeLessThan(second.maxBlobBytes);
  expect(checkpoint.maxBlobBytes).toBeGreaterThan(0);
});

// Catches: a pack the checkpoint claims is complete but git cannot index, which would make the
// R2 copy unusable for restore.
test("the pack is a git pack that indexes back to the commit's objects", async () => {
  const root = await repository();
  const checkpoint = await checkpointRun({ root, runId: "run-1", committedAt: 1_700_000_000 });

  const indexed = await indexPack(checkpoint.pack);
  expect(indexed.objectCount).toBe(checkpoint.objectCount);
  expect(indexed.types).toContain("commit");
  expect(indexed.types).toContain("tree");
  expect(indexed.types).toContain("blob");
  // The commit travels inside the pack, so restore needs only the key.
  expect(indexed.packHash).toMatch(/^[0-9a-f]{40}$/u);
});

// Catches: a second checkpoint of one Run making a second commit, which would break the
// idempotency key the Worker relies on when it retries.
test("a second checkpoint of one Run answers the same commit and bytes", async () => {
  const root = await repository();
  const first = await checkpointRun({ root, runId: "run-1", committedAt: 1_700_000_000 });
  await writeFile(join(root, "later.txt"), "later\n");
  const second = await checkpointRun({ root, runId: "run-1", committedAt: 1_700_000_900 });

  expect(second.commit).toBe(first.commit);
  expect(second.packKey).toBe(first.packKey);
  expect(second.packBytes).toBe(first.packBytes);
  expect(second.maxBlobBytes).toBe(first.maxBlobBytes);
  expect(second.objectCount).toBe(first.objectCount);
  expect(createHash("sha256").update(second.pack).digest("hex")).toBe(
    createHash("sha256").update(first.pack).digest("hex"),
  );
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
});

// Catches: a checkpoint that moves the user's branch or index, which would make a Run's
// snapshot change what the user sees.
test("the user's HEAD, branch, index, and work tree stay where they are", async () => {
  const root = await repository();
  const headBefore = git(root, ["rev-parse", "HEAD"]).trim();
  const branchBefore = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const statusBefore = git(root, ["status", "--porcelain"]);

  const checkpoint = await checkpointRun({ root, runId: "run-1", committedAt: 1_700_000_000 });

  expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(branchBefore);
  expect(git(root, ["status", "--porcelain"])).toBe(statusBefore);
  expect(git(root, ["rev-parse", checkpoint.ref]).trim()).toBe(checkpoint.commit);
  expect(git(root, ["rev-list", "--parents", "-n", "1", checkpoint.commit]).trim()).toBe(
    checkpoint.commit,
  );
});

// Catches: an unusable Run id reaching the ref namespace. The ref is not moved, so the Run can
// be retried once the id is valid.
test("an unusable Run id or a directory outside git is refused without moving a ref", async () => {
  const root = await repository();
  for (const runId of ["../escape", "with/slash", ".hidden", "trailing.", "x.lock", ""]) {
    await expect(checkpointRun({ root, runId, committedAt: 1_700_000_000 })).rejects.toBeInstanceOf(
      CheckpointError,
    );
  }
  const outside = await directory();
  await expect(
    checkpointRun({ root: outside, runId: "run-1", committedAt: 1_700_000_000 }),
  ).rejects.toMatchObject({ code: "not-a-work-tree" });
  expect(git(root, ["for-each-ref", "refs/hns/checkpoints"]).trim()).toBe("");
});

// Catches: a subdirectory checkpoint that snapshots the whole repository. The commit must hold
// only the directory the root names.
test("a checkpoint of a subdirectory holds only that directory", async () => {
  const root = await repository();
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "inside.txt"), "inside\n");
  const checkpoint = await checkpointRun({
    root: join(root, "project"),
    runId: "run-1",
    committedAt: 1_700_000_000,
  });

  const listing = git(root, ["ls-tree", "-r", "--name-only", checkpoint.commit]).trim();
  expect(listing).toBe("inside.txt");
});
