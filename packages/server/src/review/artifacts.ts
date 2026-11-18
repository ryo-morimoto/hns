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
 * every read names a **commit id**, and the binding resolves that id in the repository's own
 * object store, so a ref that moved or was deleted cannot change what a review shows. That is the
 * same rule the R2 source follows, and the reason the mirror's ref name is not this module's
 * business.
 *
 * The three calls a review makes — `log`, `readTree`, `readFile` — are the binding's own, narrowed
 * structurally like {@link ArtifactsRepoHandle} narrows the repository's lifecycle. Each answer
 * is parsed the moment it arrives (the binding is not typed by this package), and its failure is
 * mapped onto the closed {@link ReviewFailure} vocabulary: a binding that cannot answer is
 * `unavailable`, an id the repository does not hold is `not_found`, a refused token is
 * `unauthorized`, and a commit, tree, or file over the limits is `too_large`. A binding that
 * throws something outside its own error shape is a defect and propagates.
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
 * The part of Artifacts' repository handle a review reads.
 *
 * @remarks
 * The answers stay `unknown` on purpose: they are the binding's, and the schemas below are the
 * one place they become values. `readFile` takes the commit as well as the path because a mirror
 * holds many commits of one repository, and the review must show the bytes the commit names.
 */
export interface ArtifactsReviewHandle {
  /** The commit `commit` as the repository holds it. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the binding's boundary: the value is untrusted until CommitAnswerSchema parses it.
  log(commit: string): Promise<unknown>;
  /** One directory of one commit's tree. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the binding's boundary: the value is untrusted until TreeAnswerSchema parses it.
  readTree(input: { readonly commit: string; readonly path: string }): Promise<unknown>;
  /** One file's bytes in one commit. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the binding's boundary: the value is untrusted until FileAnswerSchema parses it.
  readFile(input: { readonly commit: string; readonly path: string }): Promise<unknown>;
}

/**
 * The repository a review reads, as the binding's namespace answers for it.
 *
 * @remarks
 * **`get` is the namespace's, and the handle a review needs is the wider one.** The namespace
 * already exists and answers {@link ArtifactsRepoHandle} (the mirror's own view: `info`,
 * `createToken`, `log`) plus the two read calls a review makes. The two are merged here rather
 * than restated, so a binding that satisfies the mirror's interface and this module's is the
 * Worker's real one, not a shape invented for a test.
 */
export interface ArtifactsReviewBinding {
  /** A repository's handle, or null when the namespace has no repository of that name. */
  get(name: string): Promise<ArtifactsReviewHandle | null>;
}

/** The 40 lowercase hex characters a git object id is. */
const ObjectId = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));

/** The commit as the binding answers it. */
const CommitAnswerSchema: v.GenericSchema<
  unknown,
  {
    readonly commit: string;
    readonly tree: string;
    readonly message: string;
    readonly committedAt: string;
  }
> = v.object({
  commit: ObjectId,
  tree: ObjectId,
  message: v.string(),
  committedAt: v.string(),
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

/** One directory's entries as the binding answers them. */
const TreeAnswerSchema: v.GenericSchema<
  unknown,
  readonly {
    readonly path: string;
    readonly mode: string;
    readonly object: string;
    readonly size: number;
  }[]
> = v.array(
  v.object({
    path: v.pipe(v.string(), v.minLength(1)),
    mode: ModeSchema,
    object: ObjectId,
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
);

/** One file as the binding answers it: bytes, and the commit they belong to. */
const FileAnswerSchema: v.GenericSchema<
  unknown,
  { readonly path: string; readonly object: string; readonly bytes: Uint8Array }
> = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  object: ObjectId,
  bytes: v.instance(Uint8Array),
});

/** A binding error is an `Error`; anything else is a defect. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the catch boundary: a binding may throw any value, and this is where it becomes the Error the mapper reads.
function errorOf(thrown: unknown): Error {
  return thrown instanceof Error
    ? thrown
    : new Error("the binding threw a value that is not an Error");
}

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
 * @returns The closed review failure code.
 *
 * @remarks
 * `NOT_FOUND` is a commit or path the repository does not hold; `UPSTREAM_UNAVAILABLE` and
 * `INTERNAL_ERROR` are a binding that could not answer at all; an authentication or
 * authorization refusal is `unauthorized`; anything else is a source that could not be read, so
 * `unavailable` rather than a failure invented as "nothing there". A message is never read: it may
 * quote the request or a token.
 *
 * @internal
 */
export function reviewFailureOfBinding(error: Error): "not_found" | "unavailable" | "unauthorized" {
  switch (errorCodeOf(error)) {
    case "NOT_FOUND":
      return "not_found";
    case "UNAUTHENTICATED":
    case "UNAUTHORIZED":
    case "REMOTE_AUTH_REQUIRED":
      return "unauthorized";
    default:
      return "unavailable";
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

/**
 * The review source over one workspace's Artifacts repository.
 *
 * @remarks
 * The source holds a **repository name** and the binding's namespace, and resolves the repository
 * on the first read: a workspace that never pushed has none, and looking it up lazily means a
 * deployment with no Artifacts binding fails closed without a lookup. Every read is by commit id
 * (the port's contract), and every answer is parsed before it leaves this module, so a binding
 * that changes shape is `unavailable` and a commit it does not hold is `not_found`.
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

  /** The repository's handle, or `not_found` when the namespace has no repository of that name. */
  async #repository(): Promise<ArtifactsReviewHandle> {
    let handle: ArtifactsReviewHandle | null;
    try {
      handle = await this.#binding.get(this.#repo);
    } catch (error) {
      throw new ReviewSourceError(
        reviewFailureOfBinding(errorOf(error)),
        "the repository could not be read",
      );
    }
    if (handle === null) {
      throw new ReviewSourceError("not_found", "no Artifacts repository for this workspace");
    }
    return handle;
  }

  /**
   * Run one binding call, mapping its failure to a review failure.
   *
   * @internal
   * @remarks
   * A defect is not swallowed: a binding that throws something outside its own error shape is a
   * bug in the binding, and it is rethrown so the request answers 500 instead of "not found".
   */
  async #call<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      // A review failure is the port's own vocabulary already (the fake's and any adapter's
      // answer): it is the code a source answers with, so it travels unchanged instead of being
      // re-read as a binding error with no code.
      if (error instanceof ReviewSourceError) throw error;
      if (!(error instanceof Error)) throw error;
      const code = errorCodeOf(error);
      if (code === undefined) throw error;
      throw new ReviewSourceError(
        reviewFailureOfBinding(error),
        "the Artifacts binding could not read " + what + " (" + code + ")",
      );
    }
  }

  async log(commit: string): Promise<ReviewCommit> {
    const id = ArtifactsReviewSource.#commitId(commit);
    const handle = await this.#repository();
    const answer = await this.#call("commit " + id, () => handle.log(id));
    const parsed = v.safeParse(CommitAnswerSchema, answer);
    if (!parsed.success) {
      throw new ReviewSourceError("unavailable", "the Artifacts commit answer is not a commit");
    }
    const committedAt = new Date(parsed.output.committedAt);
    if (Number.isNaN(committedAt.getTime())) {
      throw new ReviewSourceError("unavailable", "the Artifacts commit has no valid time");
    }
    const at: IsoTimestamp = isoTimestamp(committedAt.toISOString());
    return {
      // The id the caller asked for, which the answer must name: a binding that answers another
      // commit would otherwise have the review read bytes the Change did not name.
      commit: id,
      tree: parsed.output.tree,
      message: parsed.output.message,
      committedAt: at,
    };
  }

  async readTree(commit: string, path: string): Promise<readonly ReviewTreeEntry[]> {
    const id = ArtifactsReviewSource.#commitId(commit);
    ArtifactsReviewSource.#checkPath(path);
    const handle = await this.#repository();
    const answer = await this.#call("tree " + JSON.stringify(path), () =>
      handle.readTree({ commit: id, path }),
    );
    const parsed = v.safeParse(TreeAnswerSchema, answer);
    if (!parsed.success) {
      throw new ReviewSourceError("unavailable", "the Artifacts tree answer is not a tree");
    }
    return parsed.output.map((entry) => {
      const mode = entry.mode;
      const kind: ReviewTreeEntry["kind"] = TREE_MODES.has(mode)
        ? "tree"
        : GITLINK_MODE === mode
          ? "commit"
          : "blob";
      // A symlink is a blob in the contract's kind vocabulary (its bytes are the link target);
      // the mode is what tells it apart. Any other mode is refused rather than guessed at.
      if (
        !TREE_MODES.has(mode) &&
        !BLOB_MODES.has(mode) &&
        mode !== SYMLINK_MODE &&
        mode !== GITLINK_MODE
      ) {
        throw new ReviewSourceError("unavailable", "a tree entry has a mode a review cannot read");
      }
      return {
        path: entry.path,
        kind,
        mode: normaliseMode(mode),
        object: entry.object,
        size: entry.size,
      };
    });
  }

  async readFile(commit: string, path: string): Promise<ReviewFile> {
    const id = ArtifactsReviewSource.#commitId(commit);
    ArtifactsReviewSource.#checkPath(path);
    if (path === "") {
      throw new ReviewSourceError("invalid_request", "a file read needs a path");
    }
    const handle = await this.#repository();
    const answer = await this.#call("file " + JSON.stringify(path), () =>
      handle.readFile({ commit: id, path }),
    );
    const parsed = v.safeParse(FileAnswerSchema, answer);
    if (!parsed.success) {
      throw new ReviewSourceError("unavailable", "the Artifacts file answer is not a file");
    }
    if (parsed.output.path !== path) {
      throw new ReviewSourceError("unavailable", "the Artifacts file answer names another path");
    }
    if (parsed.output.bytes.length > this.#maxFileBytes) {
      throw new ReviewSourceError("too_large", JSON.stringify(path) + " is too large to show");
    }
    return {
      path,
      object: parsed.output.object,
      contentType: contentTypeOf(path),
      bytes: parsed.output.bytes,
    };
  }
}

/** Render a commit's stored Artifacts repository name from a workspace id, for the selector. */
export { artifactsRepoName } from "../artifacts/repos.ts";
