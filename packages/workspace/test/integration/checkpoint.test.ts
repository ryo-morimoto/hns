import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkpointRun } from "../../src/checkpoint.ts";

const roots: string[] = [];

const newRepo = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), "hns-checkpoint-"));
  roots.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  return repo;
};

/** Run git in the repository and return its raw stdout. */
const git = (repo: string, args: readonly string[], input?: string | Uint8Array): string =>
  String(
    execFileSync("git", [...args], {
      cwd: repo,
      encoding: "utf8",
      input,
      env: { ...process.env },
    }),
  );

const trimmed = (repo: string, args: readonly string[]): string => git(repo, args).trim();

const write = async (repo: string, path: string, content: string): Promise<void> => {
  const target = join(repo, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const commitAll = (repo: string, message: string): void => {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
};

/** The paths in a tree, relative to the tree root. */
const treeNames = (repo: string, commit: string): string[] =>
  trimmed(repo, ["ls-tree", "-r", "--name-only", commit])
    .split("\n")
    .filter((line) => line.length > 0);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Catches: a checkpoint that commits the index instead of the working tree, or that moves the user's refs.
test("commits the working tree without moving the user's refs", async () => {
  const repo = await newRepo();
  await write(repo, ".gitignore", "ignored.log\n");
  await write(repo, "a.txt", "v1\n");
  await write(repo, "gone.txt", "delete me\n");
  commitAll(repo, "init");

  await write(repo, "a.txt", "v2\n");
  await rm(join(repo, "gone.txt"));
  await write(repo, "new/untracked.txt", "new\n");

  const branch = trimmed(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = trimmed(repo, ["rev-parse", "HEAD"]);
  const branchRef = trimmed(repo, ["rev-parse", "refs/heads/" + branch]);
  const index = git(repo, ["ls-files", "-s"]);
  const status = git(repo, ["status", "--porcelain=v1"]);

  const result = await checkpointRun({ root: repo, runId: "run-1", committedAt: 1_700_000_000 });

  expect(result).toMatchObject({
    runId: "run-1",
    ref: "refs/hns/checkpoints/run-1",
    created: true,
    packKey: "checkpoints/" + result.commit + ".pack",
  });
  expect(trimmed(repo, ["rev-parse", result.ref])).toBe(result.commit);
  expect(result.objectCount).toBeGreaterThan(0);
  expect(result.pack.subarray(0, 4)).toStrictEqual(new TextEncoder().encode("PACK"));

  // The user's branch, HEAD, index, and working tree are exactly as before.
  expect(trimmed(repo, ["rev-parse", "HEAD"])).toBe(head);
  expect(trimmed(repo, ["rev-parse", "refs/heads/" + branch])).toBe(branchRef);
  expect(git(repo, ["ls-files", "-s"])).toBe(index);
  expect(git(repo, ["status", "--porcelain=v1"])).toBe(status);

  // The commit is a root commit, and its tree is the working tree, deletions included.
  expect(
    trimmed(repo, ["rev-list", "--parents", "-n", "1", result.commit]).split(" "),
  ).toHaveLength(1);
  expect(treeNames(repo, result.commit)).toStrictEqual([
    ".gitignore",
    "a.txt",
    "new/untracked.txt",
  ]);
  expect(git(repo, ["cat-file", "-p", result.commit + ":a.txt"]).trim()).toBe("v2");
  expect(git(repo, ["cat-file", "-p", result.commit + ":new/untracked.txt"]).trim()).toBe("new");
});

// Catches: a second checkpoint for one Run overwriting the ref, or two racing calls advancing it twice.
test("re-running a checkpoint for the same run keeps the first commit", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "v1\n");
  commitAll(repo, "init");
  await write(repo, "a.txt", "v2\n");

  const first = await checkpointRun({ root: repo, runId: "run-1", committedAt: 1_700_000_000 });
  await write(repo, "a.txt", "v3\n");
  const second = await checkpointRun({ root: repo, runId: "run-1", committedAt: 1_700_000_000 });

  expect(second.created).toBe(false);
  expect(second.commit).toBe(first.commit);
  expect(second.pack).toStrictEqual(first.pack);
  expect(second.packKey).toBe(first.packKey);
  expect(trimmed(repo, ["rev-parse", first.ref])).toBe(first.commit);
  // The second call did not snapshot v3 over the first checkpoint.
  expect(git(repo, ["cat-file", "-p", first.commit + ":a.txt"]).trim()).toBe("v2");

  const raceRepo = await newRepo();
  await write(raceRepo, "a.txt", "v1\n");
  commitAll(raceRepo, "init");
  await write(raceRepo, "a.txt", "v2\n");
  const [left, right] = await Promise.all([
    checkpointRun({ root: raceRepo, runId: "race", committedAt: 1_700_000_000 }),
    checkpointRun({ root: raceRepo, runId: "race", committedAt: 1_700_000_000 }),
  ]);
  expect(left.commit).toBe(right.commit);
  expect([left.created, right.created].filter((created) => created)).toHaveLength(1);
  expect(trimmed(raceRepo, ["rev-parse", left.ref])).toBe(left.commit);
});

// Catches: a tracked .env / .hns, a gitignored file, or a credential file reaching the checkpoint.
test("leaves ignored, control, environment, and credential files out of the commit", async () => {
  const repo = await newRepo();
  await write(repo, ".gitignore", "ignored.log\n");
  await write(repo, "tracked.txt", "tracked\n");
  // Tracked before the checkpoint: git no longer applies .gitignore to these.
  await write(repo, ".env", "TOKEN=secret\n");
  await write(repo, ".hns/root.json", '{"id":"root"}\n');
  commitAll(repo, "init");

  await write(repo, "nested/.env.local", "TOKEN=secret\n");
  await write(repo, "web/.env.production", "TOKEN=secret\n");
  await write(repo, "nested/.hns/root.json", '{"id":"nested"}\n');
  await write(repo, "id_rsa", "private key\n");
  await write(repo, "certs/server.pem", "certificate\n");
  await write(repo, "credentials.json", '{"token":"secret"}\n');
  await write(repo, ".ssh/id_ed25519", "private key\n");
  await write(repo, "node_modules/pkg/index.js", "dependency\n");
  await write(repo, "ignored.log", "ignored\n");
  await write(repo, "kept/untracked.txt", "kept\n");

  const result = await checkpointRun({ root: repo, runId: "run-1", committedAt: 1_700_000_000 });

  expect(treeNames(repo, result.commit)).toStrictEqual([
    ".gitignore",
    "kept/untracked.txt",
    "tracked.txt",
  ]);
});

// Catches: a checkpoint that replaces the previous Run's ref instead of adding one.
test("keeps one checkpoint ref per run", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "v1\n");
  commitAll(repo, "init");
  const head = trimmed(repo, ["rev-parse", "HEAD"]);

  const first = await checkpointRun({ root: repo, runId: "run-1", committedAt: 1_700_000_000 });
  await write(repo, "a.txt", "v2\n");
  const second = await checkpointRun({ root: repo, runId: "run-2", committedAt: 1_700_000_001 });

  expect(first.created).toBe(true);
  expect(second.created).toBe(true);
  expect(second.commit).not.toBe(first.commit);
  expect(trimmed(repo, ["rev-parse", first.ref])).toBe(first.commit);
  expect(trimmed(repo, ["rev-parse", second.ref])).toBe(second.commit);
  expect(
    trimmed(repo, ["for-each-ref", "--format=%(refname)", "refs/hns/checkpoints"])
      .split("\n")
      .sort(),
  ).toStrictEqual([first.ref, second.ref]);
  expect(trimmed(repo, ["rev-parse", "HEAD"])).toBe(head);
});

// Catches: a pack with an incomplete closure, or bytes git rejects.
test("returns a pack git can index and walk from the checkpoint commit", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "v2\n");
  await write(repo, "dir/b.txt", "b\n");
  commitAll(repo, "init");

  const result = await checkpointRun({ root: repo, runId: "run-1", committedAt: 1_700_000_000 });

  const empty = await mkdtemp(join(tmpdir(), "hns-checkpoint-pack-"));
  roots.push(empty);
  execFileSync("git", ["init", "-q"], { cwd: empty });
  execFileSync("git", ["index-pack", "--stdin"], { cwd: empty, input: result.pack });

  // Every object of the closure is readable in the repository that only has the pack.
  expect(() => git(empty, ["cat-file", "-e", result.commit + "^{commit}"])).not.toThrow();
  expect(() => git(empty, ["cat-file", "-e", result.commit + "^{tree}"])).not.toThrow();
  expect(() => git(empty, ["cat-file", "-e", result.commit + ":a.txt"])).not.toThrow();
  expect(() => git(empty, ["cat-file", "-e", result.commit + ":dir/b.txt"])).not.toThrow();
  expect(git(empty, ["cat-file", "-p", result.commit + ":dir/b.txt"]).trim()).toBe("b");

  const ids = (repository: string): string[] =>
    trimmed(repository, ["rev-list", "--objects", result.commit])
      .split("\n")
      .map((line) => line.split(" ")[0] ?? "")
      .filter((id) => id.length > 0)
      .sort();
  const closure = ids(empty);
  expect(closure).toStrictEqual(ids(repo));
  // The pack carries exactly the checkpoint commit as its only commit.
  const types = git(empty, ["cat-file", "--batch-check=%(objecttype)"], closure.join("\n") + "\n")
    .trim()
    .split("\n");
  expect(types.filter((type) => type === "commit")).toHaveLength(1);
});

// Catches: an empty workspace producing no commit, or failing because it has no tree entries.
test("checkpoints an empty workspace with git's empty tree", async () => {
  const repo = await newRepo();

  const result = await checkpointRun({ root: repo, runId: "empty", committedAt: 1_700_000_000 });

  expect(result.created).toBe(true);
  expect(trimmed(repo, ["rev-parse", result.ref])).toBe(result.commit);
  expect(trimmed(repo, ["rev-parse", result.commit + "^{tree}"])).toBe(
    "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  );
  expect(treeNames(repo, result.commit)).toStrictEqual([]);
});

// Catches: a run id that escapes the checkpoint prefix, or a snapshot taken outside git.
test("refuses an invalid run id or a directory that is not a work tree", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "v1\n");
  commitAll(repo, "init");

  for (const runId of ["", "a/b", "..", ".", "run.lock", "run with space", "-dash"]) {
    await expect(checkpointRun({ root: repo, runId })).rejects.toMatchObject({
      name: "CheckpointError",
      code: "invalid-run-id",
    });
  }
  expect(trimmed(repo, ["for-each-ref", "--format=%(refname)", "refs/hns"])).toBe("");

  const outside = await mkdtemp(join(tmpdir(), "hns-checkpoint-outside-"));
  roots.push(outside);
  await expect(checkpointRun({ root: outside, runId: "run-1" })).rejects.toMatchObject({
    name: "CheckpointError",
    code: "not-a-work-tree",
  });
});

// Catches: a checkpoint of the whole repository when the workspace root is a subdirectory.
test("snapshots the workspace root, not the whole repository", async () => {
  const repo = await newRepo();
  await write(repo, "top.txt", "top\n");
  await write(repo, "sub/inside.txt", "inside\n");
  commitAll(repo, "init");
  await write(repo, "sub/untracked.txt", "untracked\n");
  await write(repo, "outside.txt", "outside\n");
  const head = trimmed(repo, ["rev-parse", "HEAD"]);

  const result = await checkpointRun({
    root: join(repo, "sub"),
    runId: "run-sub",
    committedAt: 1_700_000_000,
  });

  expect(treeNames(repo, result.commit)).toStrictEqual(["inside.txt", "untracked.txt"]);
  expect(trimmed(repo, ["rev-parse", "HEAD"])).toBe(head);
  expect(trimmed(repo, ["rev-parse", result.ref])).toBe(result.commit);
});
