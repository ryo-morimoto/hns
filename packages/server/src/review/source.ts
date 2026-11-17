import type { ReviewCommit, ReviewFailure, ReviewFile, ReviewTreeEntry } from "@hns/core";

/**
 * The review read port: read a checkpoint's commit without knowing where it is stored.
 *
 * @remarks
 * Review reads what a checkpoint recorded, and D106 keeps that in two places: Artifacts (the
 * mirror a machine pushes to) and R2 (the authoritative pack). This port is the seam between
 * them, so the review logic is written once and the source is chosen where the Worker is
 * assembled. It takes a **commit id**, never a ref name: `refs/hns/checkpoints/<runId>` is what
 * the checkpoint path wrote, and a review of a commit must read the bytes that commit names.
 *
 * A read never answers "nothing" for a failure: the expected failures are {@link ReviewFailure}
 * values, so a caller can tell an empty directory from a tree it could not read. A defect (a
 * binding throwing something outside this union) propagates as an exception.
 */
export interface ReviewSource {
  /**
   * Read one commit.
   *
   * @param commit - The git commit id (40 lowercase hex characters).
   * @returns The commit, its root tree, and its message and time.
   */
  log(commit: string): Promise<ReviewCommit>;

  /**
   * Read one directory of one tree.
   *
   * @param commit - The git commit id.
   * @param path - A directory inside the tree, relative with `/` separators; `""` is the root.
   * @returns The directory's entries, in the source's order.
   */
  readTree(commit: string, path: string): Promise<readonly ReviewTreeEntry[]>;

  /**
   * Read one file's bytes.
   *
   * @param commit - The git commit id.
   * @param path - The file's path, relative with `/` separators.
   * @returns The bytes and a content type hint.
   */
  readFile(commit: string, path: string): Promise<ReviewFile>;
}

/**
 * A source failed an expected way.
 *
 * @remarks
 * An adapter turns a store's error into a {@link ReviewFailure} and throws this, so a caller
 * can branch on `code` instead of matching a message. A thrown value that is not this is a
 * defect, not a review failure.
 */
export class ReviewSourceError extends Error {
  /** The closed failure code. */
  readonly code: ReviewFailure;

  constructor(code: ReviewFailure, message: string) {
    super(message);
    this.name = "ReviewSourceError";
    this.code = code;
  }
}

/** Reject a path that could leave the tree or name something that is not a file below it. */
const checkPath = (path: string): void => {
  if (
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === ".." || segment === ".") ||
    path.includes("//")
  ) {
    throw new ReviewSourceError("invalid_request", "path leaves the tree: " + JSON.stringify(path));
  }
};

/**
 * A {@link ReviewSource} over a fixed set of commits, for tests and for a source that has no
 * storage yet.
 *
 * @remarks
 * This is a fake, not an adapter: it answers from a map the test supplies and never reaches a
 * binding, a network, or a process. It still enforces the port's contract — a path that leaves
 * the tree is `invalid_request`, a missing commit or path is `not_found` — so a service
 * written against it sees the same failures it will see from R2 (0247).
 */
export class FakeReviewSource implements ReviewSource {
  readonly #commits: ReadonlyMap<string, ReviewCommit>;
  readonly #trees: ReadonlyMap<string, readonly ReviewTreeEntry[]>;
  readonly #files: ReadonlyMap<string, ReviewFile>;

  /**
   * @param commits - Commits by id.
   * @param trees - Tree entries by `<commit>:<path>`; `""` is the root path.
   * @param files - Files by `<commit>:<path>`.
   */
  constructor(
    commits: ReadonlyMap<string, ReviewCommit>,
    trees: ReadonlyMap<string, readonly ReviewTreeEntry[]>,
    files: ReadonlyMap<string, ReviewFile>,
  ) {
    this.#commits = commits;
    this.#trees = trees;
    this.#files = files;
  }

  log(commit: string): Promise<ReviewCommit> {
    return Promise.resolve().then(() => {
      const found = this.#commits.get(commit);
      if (found === undefined) {
        throw new ReviewSourceError("not_found", "no commit " + JSON.stringify(commit));
      }
      return found;
    });
  }

  readTree(commit: string, path: string): Promise<readonly ReviewTreeEntry[]> {
    return Promise.resolve().then(() => {
      checkPath(path);
      const found = this.#trees.get(commit + ":" + path);
      if (found === undefined) {
        throw new ReviewSourceError("not_found", "no tree " + JSON.stringify(path));
      }
      return found;
    });
  }

  readFile(commit: string, path: string): Promise<ReviewFile> {
    return Promise.resolve().then(() => {
      checkPath(path);
      const found = this.#files.get(commit + ":" + path);
      if (found === undefined) {
        throw new ReviewSourceError("not_found", "no file " + JSON.stringify(path));
      }
      return found;
    });
  }
}
