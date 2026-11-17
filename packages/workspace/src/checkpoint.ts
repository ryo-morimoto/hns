/**
 * Checkpoint a Run's working tree as a commit under `refs/hns/checkpoints/<runId>`.
 *
 * @remarks
 * The checkpoint is a git commit built from a private index, so the user's
 * branch, HEAD, index, and stash stay where they are. The commit has no parent:
 * its closure is exactly the snapshot, so the pack that 0153 uploads to R2 does
 * not carry the user's history.
 *
 * Everything git does not ignore is snapshotted, tracked or not; deleted tracked
 * files disappear from the tree, because the tree is a mapping of the working
 * tree. On top of `.gitignore`, a closed list of credential-shaped names and the
 * workspace control directory are removed from the private index. Hiding those
 * in the sandbox is not enough: the disk still has them, and a whole-root
 * snapshot would carry them to R2 (`agent-sandbox-designs.md` R8).
 *
 * The ref is the idempotency key: one Run has one checkpoint. If the ref exists,
 * this returns its commit instead of making a second one; otherwise the ref moves
 * with a compare-and-swap. This module stops at the commit and the pack bytes —
 * uploading to R2 and writing the Journal watermark belong to the orchestration
 * (0157 / 0162). It runs under Node (git, child process, fs) and is therefore a
 * subpath export, not part of the root entry a Worker imports.
 *
 * @remarks
 * **This export has no caller yet.** Restore is its one intended consumer and is
 * not implemented; until it lands, nothing in the tree imports
 * `@hns/workspace/checkpoint`, and the tests reach the source by relative path.
 * The subpath stays because the root entry cannot hold it (the Worker bundle has
 * no `node:child_process`), and a restore face that has to reach in through
 * `src/` would be the deep import the package boundary forbids.
 *
 * The contract restore is expected to use, so a change here is visible as a
 * change to a public shape: {@link checkpointRun} takes the workspace root and
 * the Run id, and returns {@link Checkpoint} — the commit, its ref, the R2 key
 * `checkpoints/<commit>.pack`, the pack bytes, and the pack's size and largest
 * blob, which are what the machine's `checkpoint` operation reports as its
 * metadata (0244). Restore reads that pack back with
 * {@link readCheckpointPack} from `./objects`. A consumer that needs a
 * different input or a different split (for example, uploading here instead of
 * returning bytes) must change this subpath, and that is a public-surface change.
 */

import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, checkpointPackKey, GIT_OBJECT_TYPES } from "./objects.ts";
import type { GitObject, GitObjectType } from "./objects.ts";

/** The names a checkpoint never stores, as git pathspecs relative to the root. */
const EXCLUDED_PATHSPECS = [
  // hns control data (root identity and anything else the workspace keeps there).
  ":(glob)**/.hns",
  ":(glob)**/.hns/**",
  // Environment files carry credentials in practice.
  ":(glob)**/.env",
  ":(glob)**/.env.*",
  // Credential directories and files the standard tools read by name.
  ":(glob)**/.ssh",
  ":(glob)**/.ssh/**",
  ":(glob)**/.aws",
  ":(glob)**/.aws/**",
  ":(glob)**/.gnupg",
  ":(glob)**/.gnupg/**",
  ":(glob)**/.netrc",
  ":(glob)**/.npmrc",
  ":(glob)**/.git-credentials",
  ":(glob)**/.htpasswd",
  ":(glob)**/id_rsa",
  ":(glob)**/id_dsa",
  ":(glob)**/id_ecdsa",
  ":(glob)**/id_ed25519",
  ":(glob)**/*.pem",
  ":(glob)**/*.key",
  ":(glob)**/*.p12",
  ":(glob)**/*.pfx",
  ":(glob)**/*.jks",
  ":(glob)**/*.keystore",
  ":(glob)**/credentials.json",
  ":(glob)**/secrets.json",
  ":(glob)**/secrets.yaml",
  ":(glob)**/secrets.yml",
  ":(glob)**/secrets.toml",
  // An unignored install would put an unbounded tree into one pack.
  ":(glob)**/node_modules",
  ":(glob)**/node_modules/**",
] as const;

/** The ref prefix a checkpoint lives under. */
const REF_PREFIX = "refs/hns/checkpoints/";

/** The author and committer every checkpoint commit uses, so the id is content-derived. */
const IDENTITY = { name: "hns", email: "hns@example.com" } as const;

/** A run id is one ref component: no slash, no traversal, no lock suffix. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Why a checkpoint could not be made.
 *
 * @remarks
 * `invalid-run-id` and `not-a-work-tree` are caller errors; `git-failed` and
 * `missing-object` mean git could not produce a complete snapshot. None of them
 * moves the ref, so a retry starts from the same state.
 */
export const CHECKPOINT_FAILURES = [
  "invalid-run-id",
  "not-a-work-tree",
  "git-failed",
  "missing-object",
] as const;

/** One reason a checkpoint could not be made. */
export type CheckpointFailure = (typeof CHECKPOINT_FAILURES)[number];

/**
 * A checkpoint that could not be made.
 *
 * @remarks
 * The ref has not moved when this is thrown. Callers branch on `code` rather than
 * parsing the message, and can retry a failed Run as a whole.
 */
export class CheckpointError extends Error {
  /** Why the checkpoint failed. */
  readonly code: CheckpointFailure;

  constructor(code: CheckpointFailure, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

/** What a checkpoint produced. */
export interface Checkpoint {
  /** The Run the checkpoint belongs to. */
  readonly runId: string;
  /** The ref that records it: `refs/hns/checkpoints/<runId>`. */
  readonly ref: string;
  /** The checkpoint commit (C in `(C, J)`). */
  readonly commit: string;
  /** Where the pack belongs in the object store: `checkpoints/<commit>.pack`. */
  readonly packKey: string;
  /** A git v2 pack of every object reachable from the commit. */
  readonly pack: Uint8Array;
  /** How many distinct objects the pack holds. */
  readonly objectCount: number;
  /**
   * The pack's size in bytes: `pack.byteLength`, measured here so a caller
   * that sends the pack does not measure it a second way.
   */
  readonly packBytes: number;
  /**
   * The largest blob in the pack.
   *
   * @remarks
   * The mirror reads it against Artifacts' 32 MiB per-file limit (D106): one
   * blob over the limit skips the mirror even when the whole pack fits. It is 0
   * for a pack without a blob, which only an empty tree can produce.
   */
  readonly maxBlobBytes: number;
  /** False when the ref already pointed at a checkpoint, so no commit was made. */
  readonly created: boolean;
}

/** What the caller must provide. */
export interface CheckpointOptions {
  /**
   * The workspace root to snapshot. It may be a subdirectory of a work tree;
   * the commit then contains only that directory.
   */
  readonly root: string;
  /**
   * The Run id. It names `refs/hns/checkpoints/<runId>` and is the idempotency
   * key: a second checkpoint for the same Run returns the first commit.
   */
  readonly runId: string;
  /**
   * Commit time in Unix seconds. Tests inject it; the default is the current
   * time. The commit id is content and time, so an injected value makes it
   * reproducible.
   */
  readonly committedAt?: number | undefined;
}

/** One git invocation, without the repository-location variables of the caller. */
interface GitOptions {
  readonly index?: string | undefined;
  readonly input?: Uint8Array | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** Environment for git: no inherited `GIT_DIR` / index / object overrides, then ours. */
const gitEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
  ]) {
    delete env[name];
  }
  return { ...env, ...extra };
};

/** Run git in `root` and resolve its stdout, or reject with a typed failure. */
const runGit = (root: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const env = gitEnv(
      options.index === undefined
        ? { ...options.env }
        : { ...options.env, GIT_INDEX_FILE: options.index },
    );
    const child = spawn("git", ["-C", root, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: Error) => {
      reject(new CheckpointError("git-failed", "git " + String(args[0]) + ": " + error.message));
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new CheckpointError(
          "git-failed",
          "git " +
            String(args[0]) +
            " exited " +
            String(code) +
            (detail === "" ? "" : ": " + detail),
        ),
      );
    });
    child.stdin.end(options.input);
  });

/** The ref's commit, or undefined when the ref does not exist yet. */
const readRef = async (root: string, ref: string): Promise<string | undefined> => {
  try {
    const id = (await runGit(root, ["rev-parse", "--verify", "--quiet", ref]))
      .toString("utf8")
      .trim();
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
};

/** Reject a run id that could leave the checkpoint prefix or break a ref. */
const assertRunId = (runId: string): void => {
  if (
    !RUN_ID.test(runId) ||
    runId.includes("..") ||
    runId.endsWith(".") ||
    runId.endsWith(".lock")
  ) {
    throw new CheckpointError("invalid-run-id", "invalid run id: " + JSON.stringify(runId));
  }
};

/** Resolve the root and prove git sees it as a work tree. */
const resolveRoot = async (root: string): Promise<string> => {
  const info = await stat(root).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new CheckpointError("not-a-work-tree", root + " is not a directory");
  }
  const canonical = await realpath(root);
  let inside: string;
  try {
    inside = (await runGit(canonical, ["rev-parse", "--is-inside-work-tree"]))
      .toString("utf8")
      .trim();
  } catch {
    throw new CheckpointError("not-a-work-tree", root + " is not inside a git work tree");
  }
  if (inside !== "true") {
    throw new CheckpointError("not-a-work-tree", root + " is not inside a git work tree");
  }
  return canonical;
};

/** The tree of the working tree, taken through a private index. */
const snapshotTree = async (root: string, index: string): Promise<string> => {
  await runGit(root, ["add", "-A", "--", "."], { index });
  // `git rm --cached` edits only the private index; the user's index is never opened.
  await runGit(
    root,
    ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...EXCLUDED_PATHSPECS],
    {
      index,
    },
  );
  const written = (await runGit(root, ["write-tree"], { index })).toString("utf8").trim();
  const files = await runGit(root, ["ls-files", "-z"], { index });
  // An empty index writes git's empty tree, which is already the root-relative tree.
  if (files.length === 0) return written;
  const prefix = (await runGit(root, ["rev-parse", "--show-prefix"])).toString("utf8").trim();
  if (prefix === "") return written;
  const subtree = joined(written, prefix);
  return (await runGit(root, ["rev-parse", "--verify", subtree])).toString("utf8").trim();
};

/** `<tree>:<path>` without doubling the slash. */
const joined = (tree: string, prefix: string): string => tree + ":" + prefix.replace(/\/$/u, "");

/** Whether a `cat-file` type word names one of the four git object types. */
const isGitObjectType = (value: string): value is GitObjectType => {
  for (const type of GIT_OBJECT_TYPES) {
    if (type === value) return true;
  }
  return false;
};

/** Parse `git cat-file --batch` output into objects, in input order. */
const parseBatch = (output: Buffer): GitObject[] => {
  const objects: GitObject[] = [];
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) throw new CheckpointError("git-failed", "truncated cat-file header");
    const header = output.subarray(offset, newline).toString("utf8");
    const [id, type, sizeText] = header.split(" ");
    if (type === "missing") {
      throw new CheckpointError("missing-object", "the repository has no object " + String(id));
    }
    if (id === undefined || type === undefined || sizeText === undefined) {
      throw new CheckpointError("git-failed", "unexpected cat-file header: " + header);
    }
    if (!/^[0-9a-f]{40}$/u.test(id) || !isGitObjectType(type)) {
      throw new CheckpointError("git-failed", "unexpected cat-file header: " + header);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new CheckpointError("git-failed", "unexpected cat-file size: " + sizeText);
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length) throw new CheckpointError("git-failed", "truncated cat-file body");
    objects.push({ type, content: new Uint8Array(output.subarray(start, end)) });
    offset = end + 1;
  }
  return objects;
};

/** Read every object reachable from the commit, as git stores it. */
const readObjects = async (root: string, commit: string): Promise<GitObject[]> => {
  const ids = (await runGit(root, ["rev-list", "--objects", "--no-object-names", commit]))
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (ids.length === 0) {
    throw new CheckpointError("git-failed", "the checkpoint commit reaches no object");
  }
  const output = await runGit(root, ["cat-file", "--batch"], {
    input: Buffer.from(ids.join("\n") + "\n"),
  });
  return parseBatch(output);
};

/** The largest blob among the objects a pack holds. */
const largestBlob = (objects: readonly GitObject[]): number => {
  let largest = 0;
  for (const object of objects) {
    if (object.type === "blob" && object.content.byteLength > largest) {
      largest = object.content.byteLength;
    }
  }
  return largest;
};

/** Turn a commit into the checkpoint value, rebuilding the deterministic pack. */
const buildCheckpoint = async (
  root: string,
  runId: string,
  ref: string,
  commit: string,
  created: boolean,
): Promise<Checkpoint> => {
  const objects = await readObjects(root, commit);
  const pack = await buildPack(objects);
  return {
    runId,
    ref,
    commit,
    packKey: checkpointPackKey(commit),
    pack: pack.bytes,
    objectCount: pack.objects.length,
    packBytes: pack.bytes.byteLength,
    maxBlobBytes: largestBlob(objects),
    created,
  };
};

/**
 * Snapshot the working tree as a checkpoint commit and move its Run ref.
 *
 * @param options - The workspace root, the Run id, and an optional commit time.
 * @returns The commit, its ref, and the pack bytes to upload for it, with the
 * pack's size and its largest blob measured for the caller.
 * @throws {@link CheckpointError} `invalid-run-id` for an unusable id,
 * `not-a-work-tree` when the root is outside git, and `git-failed` /
 * `missing-object` when git cannot produce the closure. The ref is not moved in
 * any of those cases.
 *
 * @remarks
 * The user's branch, HEAD, index, and stash are not touched; only the private
 * index and the checkpoint ref change. The commit has no parent, so the pack is
 * the snapshot alone and restore does not need the user's history.
 *
 * A second call for the same `runId` returns the first commit with
 * `created: false`, even if the tree changed in between. Two calls racing on one
 * Run create at most one ref update: the loser reads the winner's ref and
 * returns it.
 *
 * Call this at every Run end that the process survives: success, failure,
 * cancellation, lease release, and a handled SIGTERM. There is no success flag,
 * because the U of a failed Run is still work in the workspace. A crash does not
 * reach this call, so that Run has no checkpoint and its U is not durable
 * (`docs/durability.md` §3.3).
 *
 * The bytes are returned, not uploaded. The orchestration may skip the write
 * when `packKey` already exists, then put the pack and advance the Journal
 * watermark (0153 / 0157 / 0162).
 */
export const checkpointRun = async (options: CheckpointOptions): Promise<Checkpoint> => {
  const { runId } = options;
  assertRunId(runId);
  const root = await resolveRoot(options.root);
  const ref = REF_PREFIX + runId;

  const existing = await readRef(root, ref);
  if (existing !== undefined) return await buildCheckpoint(root, runId, ref, existing, false);

  const seconds =
    options.committedAt === undefined ? Math.floor(Date.now() / 1000) : options.committedAt;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError("committedAt must be a non-negative integer of Unix seconds");
  }
  const date = String(seconds) + " +0000";
  const identity = {
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_COMMITTER_DATE: date,
  };

  const temporary = await mkdtemp(join(tmpdir(), "hns-checkpoint-"));
  try {
    const tree = await snapshotTree(root, join(temporary, "index"));
    const commit = (
      await runGit(root, ["commit-tree", tree, "-m", "hns checkpoint " + runId], {
        env: identity,
      })
    )
      .toString("utf8")
      .trim();

    // Pack before moving the ref: a failure here leaves the ref where it was.
    const checkpoint = await buildCheckpoint(root, runId, ref, commit, true);
    try {
      // The empty old value asks git to fail unless the ref does not exist yet.
      await runGit(root, ["update-ref", ref, commit, ""]);
    } catch (error) {
      const winner = await readRef(root, ref);
      if (winner !== undefined) return await buildCheckpoint(root, runId, ref, winner, false);
      throw error;
    }
    return checkpoint;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
