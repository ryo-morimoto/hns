import { isoTimestamp } from "@hns/core";
import type {
  IsoTimestamp,
  ReviewCommit,
  ReviewFile,
  ReviewTreeEntry,
  ReviewTreeEntryMode,
} from "@hns/core";
import * as v from "valibot";
import { ReviewSourceError } from "./source.ts";
import type { ReviewSource } from "./source.ts";

/**
 * The review source over Artifacts: the mirror of a workspace's checkpoints, read through the
 * Worker's binding (D106 / 0248).
 *
 * @remarks
 * Artifacts is a **mirror** of the authoritative checkpoint in R2 (D106). A Run's checkpoint is
 * pushed under `refs/heads/hns/run/<runId>` (`@hns/workspace/mirror`), but nothing here reads a ref:
 * every read names a **commit or tree id**, and the binding resolves that id in the repository's
 * own object store, so a ref that moved or was deleted cannot change what a review shows. That is
 * the same rule the R2 source follows, and the reason the mirror's ref name is not this module's
 * business.
 *
 * **The binding's surface is the real one, not a shape invented here.** Artifacts' repository
 * capability (`ArtifactsRepo` in workerd's generated types) answers `get(name)` with a handle
 * (throwing `NOT_FOUND` when the repository is absent), and the handle reads by object id:
 * `readCommit(hash)` for a commit, `readTree(hash)` for one tree's immediate children, and
 * `readFile({ ref, path })` for a file resolved at a branch, tag, or commit. This module maps that
 * surface onto {@link ReviewSource} — a commit id in, `ReviewCommit` / `ReviewTreeEntry[]` /
 * `ReviewFile` out — and does the **tree walk** itself, because the binding reads one tree by its
 * id while a review asks for a path.
 *
 * Every answer is parsed the moment it arrives (the binding is typed by workerd, but a Worker
 * bundle does not carry that type), and its failure is mapped onto the closed {@link ReviewFailure}
 * vocabulary: a binding that cannot answer is `unavailable`, an id the repository does not hold is
 * `not_found`, a refused token is `unauthorized`, and a file over the limit is `too_large`. A
 * throw that is not the binding's own error is a defect and propagates.
 */

/** The largest file `readFile` answers; a larger blob is `too_large`. */
export const ARTIFACTS_REVIEW_MAX_FILE_BYTES = 32 * 1024 * 1024;

const COMMIT_ID = /^[0-9a-f]{40}$/u;

/** The git modes a review may see, as {@link ReviewTreeEntryMode}. */
const TREE_MODES: ReadonlySet<string> = new Set(["40000", "040000"]);
const BLOB_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

/**
 * A commit as the binding's `readCommit` answers it.
 *
 * @remarks
 * `committedAt` is Unix seconds and `treeHash` is the root tree's id — workerd's
 * `ArtifactsCommitMetadata`, narrowed to the fields a review reads.
 */
export interface ArtifactsCommitMetadata {
  readonly hash: string;
  readonly treeHash: string;
  readonly message: string;
  readonly committedAt: number;
}

/**
 * One immediate child of a tree, as the binding's `readTree` answers it.
 *
 * @remarks
 * workerd's `ArtifactsTreeEntry`: the entry's `name` relative to the tree, its git `mode`, its
 * object `hash`, and the binding's own `type` classification. A review reads `mode` for the
 * contract's entry kind rather than trusting `type`, and `hash` for the blob's id.
 */
export interface ArtifactsTreeEntry {
  readonly name: string;
  readonly mode: string;
  readonly hash: string;
  readonly type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

/**
 * The part of Artifacts' repository capability a review reads.
 *
 * @remarks
 * The method names, parameters, and answers are workerd's `ArtifactsRepo`'s. `readFile` resolves
 * by `ref` and `path` (so the review can hand it a **commit id** as the ref) and answers a Blob
 * whose `type` is the service's content type; `readCommit` and `readTree` answer `null` for an
 * object the repository does not hold. Every method may throw `ArtifactsError`, which is how a
 * missing repository or an unavailable service is reported.
 */
export interface ArtifactsReviewHandle {
  /** The commit, or null when the repository does not hold that object. */
  readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;
  /** One tree's immediate children, or null when the repository does not hold that tree. */
  readTree(hash: string): Promise<readonly ArtifactsTreeEntry[] | null>;
  /** A file's bytes at `ref`, or null when the path does not resolve to a file. */
  readFile(args: { readonly ref: string; readonly path: string }): Promise<Blob | null>;
}

/**
 * The namespace call a review makes: the repository capability for one name.
 *
 * @remarks
 * workerd's `Artifacts.get` **throws** `NOT_FOUND` when the namespace has no repository of that
 * name; it never answers null. A workspace that never pushed therefore fails the lookup, which the
 * adapter maps to `not_found`.
 */
export interface ArtifactsReviewBinding {
  get(name: string): Promise<ArtifactsReviewHandle>;
}

/** The commit as the binding answers it, parsed at the boundary. */
const CommitAnswerSchema: v.GenericSchema<unknown, ArtifactsCommitMetadata> = v.object({
  hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  treeHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  message: v.string(),
  committedAt: v.pipe(v.number(), v.integer()),
});

/** The tree entry mode as the binding answers it: git's own spelling of the contract's. */
const ModeSchema = v.union([
  v.literal("100644"),
  v.literal("100755"),
  v.literal("120000"),
  v.literal("40000"),
  v.literal("040000"),
  v.literal("160000"),
]);

/** One tree's entries as the binding answers them. */
const TreeAnswerSchema: v.GenericSchema<unknown, readonly ArtifactsTreeEntry[]> = v.array(
  v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    mode: ModeSchema,
    hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
    type: v.picklist(["tree", "blob", "symlink", "gitlink", "exec"]),
  }),
);
/** The binding's own error code, when the error carries one. */
function errorCodeOf(error: Error): string | undefined {
  // SAFETY: an Error value with an own `code` property is what the binding throws; reading it as a
  // string is the check, and the branch uses it only after the check.
  const withCode = error as Error & { readonly code?: unknown };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the binding's error is the boundary: its code is a property on an Error the compiler does not type, so one read checks it here and every caller branches on the domain result.
  return typeof withCode.code === "string" ? withCode.code : undefined;
}

/**
 * Map a binding failure to the review failure it stands for.
 *
 * @param error - What the binding threw.
 * @returns The closed review failure code, or undefined when the throw is not the binding's own.
 *
 * @remarks
 * **One rule for every throw.** A code the binding sets is mapped: `NOT_FOUND` is a repository,
 * commit, tree, or path the repository does not hold; `UPSTREAM_UNAVAILABLE` and `INTERNAL_ERROR`
 * are a binding that could not answer at all; `MEMORY_LIMIT` is an object too large to buffer, and
 * `REMOTE_AUTH_REQUIRED` an authorization refusal (plus the two credential spellings a service
 * may use). Undefined means the throw carried no code, so it is not the binding's expected
 * failure: a defect, which keeps travelling instead of becoming `not_found`.
 *
 * A message is never read: it may quote the request or a token.
 *
 * @internal
 */
export function reviewFailureOfBinding(
  error: Error,
): "not_found" | "unavailable" | "unauthorized" | "too_large" | undefined {
  switch (errorCodeOf(error)) {
    case "NOT_FOUND":
      return "not_found";
    case "MEMORY_LIMIT":
      return "too_large";
    case "UNAUTHENTICATED":
    case "UNAUTHORIZED":
    case "REMOTE_AUTH_REQUIRED":
      return "unauthorized";
    case "ALREADY_EXISTS":
    case "CREATE_IN_PROGRESS":
    case "IMPORT_IN_PROGRESS":
    case "FORK_IN_PROGRESS":
    case "INVALID_INPUT":
    case "INVALID_REPO_NAME":
    case "INVALID_TTL":
    case "INVALID_URL":
    case "UPSTREAM_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return "unavailable";
    default:
      return undefined;
  }
}

/** A content type hint from a path's extension; a generic stream when the extension is unknown. */
function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  const known: ReadonlyMap<string, string> = new Map([
    ["ts", "text/plain"],
    ["tsx", "text/plain"],
    ["js", "text/plain"],
    ["mjs", "text/plain"],
    ["json", "application/json"],
    ["md", "text/markdown"],
    ["css", "text/css"],
    ["html", "text/html"],
    ["txt", "text/plain"],
    ["yml", "text/yaml"],
    ["yaml", "text/yaml"],
    ["toml", "text/plain"],
    ["lock", "text/plain"],
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["svg", "image/svg+xml"],
    ["pdf", "application/pdf"],
  ]);
  return known.get(extension) ?? "application/octet-stream";
}

/** git writes the tree mode without its leading zero; the contract spells it `40000`. */
const normaliseMode = (mode: string): ReviewTreeEntryMode => {
  const normalised = mode === "040000" ? "40000" : mode;
  // SAFETY: the schema admits exactly the modes the contract lists, so this cast only gives the
  // compiler the name of that set; it is checked above by ModeSchema.
  return normalised as ReviewTreeEntryMode;
};

/** One tree entry as the review's contract names it, from the binding's `(name, mode, hash)`. */
function treeEntryOf(entry: ArtifactsTreeEntry): ReviewTreeEntry {
  const mode = entry.mode;
  const isTree = TREE_MODES.has(mode);
  if (!isTree && !BLOB_MODES.has(mode) && mode !== SYMLINK_MODE && mode !== GITLINK_MODE) {
    throw new ReviewSourceError("unavailable", "a tree entry has a mode a review cannot read");
  }
  // A symlink is a blob in the contract's kind vocabulary (its bytes are the link target); the
  // mode is what tells it apart. A submodule is a commit in another repository.
  return {
    path: entry.name,
    kind: isTree ? "tree" : mode === GITLINK_MODE ? "commit" : "blob",
    mode: normaliseMode(mode),
    object: entry.hash,
    // The binding does not answer a blob's size for a tree listing, so a file's size is 0 and a
    // reader that shows one asks `readFile` for its bytes; the size is not a review decision.
    size: 0,
  };
}
/**
 * The review source over one workspace's Artifacts repository.
 *
 * @remarks
 * The source holds a **repository name** and the binding's namespace, and resolves the repository
 * on each read through `get`: a workspace that never pushed has none, and the binding answers
 * `NOT_FOUND`, which is the review's `not_found`. Every read is by commit id (the port's contract);
 * a directory is walked here, one tree id at a time, because the binding reads a tree by its id.
 */
export class ArtifactsReviewSource implements ReviewSource {
  readonly #binding: ArtifactsReviewBinding;
  readonly #repo: string;
  readonly #maxFileBytes: number;

  /**
   * @param binding - The Worker's `ARTIFACTS` namespace, or a fake with the same `get`.
   * @param repo - The workspace's repository name ({@link artifactsRepoName} derives it).
   * @param maxFileBytes - The largest file `readFile` answers; defaults to Artifacts' 32 MiB.
   */
  constructor(
    binding: ArtifactsReviewBinding,
    repo: string,
    maxFileBytes: number = ARTIFACTS_REVIEW_MAX_FILE_BYTES,
  ) {
    this.#binding = binding;
    this.#repo = repo;
    this.#maxFileBytes = maxFileBytes;
  }

  /** Check a caller's commit id before it becomes a binding argument. */
  static #commitId(commit: string): string {
    if (!COMMIT_ID.test(commit)) {
      throw new ReviewSourceError("invalid_request", "not a commit id: " + JSON.stringify(commit));
    }
    return commit;
  }

  /** Reject a path that leaves the tree, with the rule the port's fake and the R2 source use. */
  static #checkPath(path: string): void {
    if (
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").some((segment) => segment === ".." || segment === ".") ||
      path.includes("//")
    ) {
      throw new ReviewSourceError(
        "invalid_request",
        "path leaves the tree: " + JSON.stringify(path),
      );
    }
  }

  /**
   * Run one binding call, mapping its failure to a review failure.
   *
   * @internal
   * @remarks
   * **One rule for every throw**, the namespace lookup included (which is why the lookup goes
   * through here rather than catching on its own): a {@link ReviewSourceError} is the port's own
   * vocabulary and travels unchanged; an `Error` the binding threw with one of its codes becomes
   * the review failure that code stands for; **anything else** — a binding error with no code, or
   * a value that is not an `Error` at all — is a defect and is rethrown, so the request answers
   * 500 instead of "not found". There is no second place in this module that decides this.
   */
  async #call<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (thrown) {
      if (thrown instanceof ReviewSourceError) throw thrown;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this is the throw boundary: the
      // binding may throw any value, and only an Error may name one of its codes.
      if (!(thrown instanceof Error)) throw thrown;
      const failure = reviewFailureOfBinding(thrown);
      if (failure === undefined) throw thrown;
      throw new ReviewSourceError(
        failure,
        "the Artifacts binding could not read " + what + " (" + (errorCodeOf(thrown) ?? "") + ")",
      );
    }
  }

  /** The repository's capability, or `not_found` when the namespace has no repository of that name. */
  async #repository(): Promise<ArtifactsReviewHandle> {
    return await this.#call("the repository", () => this.#binding.get(this.#repo));
  }

  /** The commit, or `not_found` when the repository does not hold it. */
  async #commit(handle: ArtifactsReviewHandle, id: string): Promise<ReviewCommit> {
    const answer = await this.#call("commit " + id, () => handle.readCommit(id));
    if (answer === null) {
      throw new ReviewSourceError("not_found", "no commit " + id + " in the Artifacts repository");
    }
    const parsed = v.safeParse(CommitAnswerSchema, answer);
    if (!parsed.success) {
      throw new ReviewSourceError("unavailable", "the Artifacts commit answer is not a commit");
    }
    if (parsed.output.hash !== id) {
      // The answer must be the commit asked for: a binding that answers another id would have the
      // review read bytes the Change did not name.
      throw new ReviewSourceError(
        "unavailable",
        "the Artifacts commit answer names another commit",
      );
    }
    const committedAt = new Date(parsed.output.committedAt * 1000);
    if (Number.isNaN(committedAt.getTime())) {
      throw new ReviewSourceError("unavailable", "the Artifacts commit has no valid time");
    }
    const at: IsoTimestamp = isoTimestamp(committedAt.toISOString());
    return {
      commit: id,
      tree: parsed.output.treeHash,
      message: parsed.output.message,
      committedAt: at,
    };
  }

  /** One tree's entries, or `not_found` when the repository does not hold it. */
  async #tree(
    handle: ArtifactsReviewHandle,
    hash: string,
    path: string,
  ): Promise<readonly ArtifactsTreeEntry[]> {
    const answer = await this.#call("tree " + JSON.stringify(path), () => handle.readTree(hash));
    if (answer === null) {
      throw new ReviewSourceError("not_found", "no tree " + hash + " in the Artifacts repository");
    }
    const parsed = v.safeParse(TreeAnswerSchema, answer);
    if (!parsed.success) {
      throw new ReviewSourceError("unavailable", "the Artifacts tree answer is not a tree");
    }
    return parsed.output;
  }

  /**
   * Walk `path` from the commit's root tree, one directory at a time.
   *
   * @returns The entry the path names, and the entries of its directory when the path is a
   * directory.
   *
   * @remarks
   * The binding reads a tree by its id, so a path is resolved here: each segment is looked up in
   * the directory above it, and every earlier segment must be a tree. A missing segment is
   * `not_found`; a file read of a directory is `not_found` as well (a directory is not a file).
   */
  async #walk(
    handle: ArtifactsReviewHandle,
    root: string,
    path: string,
  ): Promise<{ readonly entries: readonly ArtifactsTreeEntry[]; readonly directory: string }> {
    const segments = path === "" ? [] : path.split("/");
    let treeId = root;
    let entries = await this.#tree(handle, treeId, "");
    for (const segment of segments) {
      const found = entries.find((entry) => entry.name === segment);
      if (found === undefined) {
        throw new ReviewSourceError("not_found", "no " + JSON.stringify(path) + " in the tree");
      }
      if (!TREE_MODES.has(found.mode)) {
        throw new ReviewSourceError("not_found", JSON.stringify(path) + " is not a directory");
      }
      treeId = found.hash;
      entries = await this.#tree(handle, treeId, path);
    }
    return { entries, directory: treeId };
  }

  async log(commit: string): Promise<ReviewCommit> {
    const id = ArtifactsReviewSource.#commitId(commit);
    return await this.#commit(await this.#repository(), id);
  }

  async readTree(commit: string, path: string): Promise<readonly ReviewTreeEntry[]> {
    const id = ArtifactsReviewSource.#commitId(commit);
    ArtifactsReviewSource.#checkPath(path);
    const handle = await this.#repository();
    const root = (await this.#commit(handle, id)).tree;
    const { entries } = await this.#walk(handle, root, path);
    return entries.map(treeEntryOf);
  }

  async readFile(commit: string, path: string): Promise<ReviewFile> {
    const id = ArtifactsReviewSource.#commitId(commit);
    ArtifactsReviewSource.#checkPath(path);
    if (path === "") {
      throw new ReviewSourceError("invalid_request", "a file read needs a path");
    }
    const handle = await this.#repository();
    // The commit first, so a commit the repository does not hold is `not_found` for the commit and
    // not for the path; then the path walk, so a directory is refused as a file.
    await this.#commit(handle, id);
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const { entries } = await this.#walk(handle, (await this.#commit(handle, id)).tree, directory);
    const entry = entries.find(
      (candidate) => candidate.name === path.slice(path.lastIndexOf("/") + 1),
    );
    if (entry === undefined || TREE_MODES.has(entry.mode) || entry.mode === GITLINK_MODE) {
      throw new ReviewSourceError("not_found", JSON.stringify(path) + " is not a file");
    }
    const answer = await this.#call("file " + JSON.stringify(path), () =>
      handle.readFile({ ref: id, path }),
    );
    if (answer === null) {
      throw new ReviewSourceError("not_found", "no " + JSON.stringify(path) + " at " + id);
    }
    if (answer.size > this.#maxFileBytes) {
      throw new ReviewSourceError("too_large", JSON.stringify(path) + " is too large to show");
    }
    return {
      path,
      object: entry.hash,
      contentType: contentTypeOf(path),
      bytes: new Uint8Array(await answer.arrayBuffer()),
    };
  }
}

/** Render a workspace's stored Artifacts repository name, for the selector. */
export { artifactsRepoName } from "../artifacts/repos.ts";
