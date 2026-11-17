import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A throwaway git repository, for the scenarios that checkpoint real work.
 *
 * @remarks
 * The checkpoint's subject is git itself, so the machine integration tests run against a real
 * repository rather than a fake: the commit, the ref, and the pack are what the Worker will
 * later store. The repository is created inside a scenario's root, which the scenario removes.
 */

/**
 * The environment every fixture's git runs in, with the repository variables removed.
 *
 * @remarks
 * A `GIT_DIR` or `GIT_WORK_TREE` inherited from the process that starts the tests (a commit hook)
 * would make `git init` in a temp directory describe and commit to the *inherited* repository
 * instead. Removing them makes each fixture's git resolve its own repository, the only one it may
 * write.
 */
const fixtureEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
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

/** Run git in a directory and return its stdout. */
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: fixtureEnv(),
  });
}

/**
 * Initialize a repository with one commit at `project` below `root`.
 *
 * @param root - The directory the repository lives in; the machine's ROOT in a scenario.
 * @param name - A subdirectory for the repository; empty means the root itself.
 * @returns The repository's absolute path.
 */
export async function gitRepository(root: string, name = ""): Promise<string> {
  // The machine's ROOT is what the checkpoint snapshots, so by default it is the repository.
  const path = name === "" ? root : join(root, name);
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "hns@example.com"]);
  git(path, ["config", "user.name", "hns"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(path, "tracked.txt"), "tracked\n");
  git(path, ["add", "tracked.txt"]);
  git(path, ["commit", "-q", "-m", "initial"]);
  return path;
}

/**
 * Add or change a file in a repository's working tree, without committing it.
 *
 * @param repository - The repository path.
 * @param name - The file name, relative to the repository.
 * @param content - The bytes to write.
 */
export async function changeFile(
  repository: string,
  name: string,
  content: string | Uint8Array,
): Promise<void> {
  await writeFile(join(repository, name), content);
}

/**
 * Read a ref's commit id, or "" when the ref does not exist.
 *
 * @param repository - The repository path.
 * @param ref - The ref to read.
 * @returns The 40-hex commit id.
 */
export function readRef(repository: string, ref: string): string {
  try {
    return git(repository, ["rev-parse", "--verify", ref]).trim();
  } catch {
    return "";
  }
}

/**
 * Write a pack to a file and let git index it.
 *
 * @param pack - The bytes.
 * @param into - A directory the file may be written in.
 * @returns What git read from the pack: its own id and one entry per object.
 *
 * @remarks
 * `git index-pack` is what restore will run on the R2 copy, so a pack that indexes is a pack
 * that can be restored. The scenario asserts the object count against the answer.
 */
export async function indexPack(
  pack: Uint8Array,
  into: string,
): Promise<{ readonly packHash: string; readonly objectCount: number }> {
  const file = join(into, "received-" + String(pack.byteLength) + ".pack");
  await writeFile(file, pack);
  const packHash = git(into, ["index-pack", file]).trim();
  const listing = git(into, ["verify-pack", "-v", file]);
  const objects = listing.split("\n").filter((line) => /^[0-9a-f]{40} /u.test(line));
  return { packHash, objectCount: objects.length };
}
