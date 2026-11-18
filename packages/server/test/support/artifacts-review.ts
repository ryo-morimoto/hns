import type { ArtifactsBinding } from "../../src/artifacts/repos.ts";
import type {
  ArtifactsCommitMetadata,
  ArtifactsReviewBinding,
  ArtifactsReviewHandle,
  ArtifactsTreeEntry,
} from "../../src/review/artifacts.ts";

/**
 * A fake Artifacts namespace, shaped exactly like the real binding's review surface.
 *
 * @remarks
 * The shape is the binding's own: `get(name)` **throws** `NOT_FOUND` when the namespace has no
 * repository of that name (it never answers null), and the handle reads a commit and a tree by
 * object id and a file by `{ ref, path }`, answering `Blob | null`. Keeping the fake to that
 * surface is what lets the adapter's mapping be proved against the call a real Worker makes,
 * rather than against a shape invented for the test.
 *
 * Objects are stored by id: a commit, a tree, and a blob are each inserted with the id the
 * fixture calculated, so a read by any other id is `null` exactly as the service answers.
 */

/** One object the fake repository holds. */
export type FakeObject =
  | { readonly kind: "commit"; readonly metadata: ArtifactsCommitMetadata }
  | { readonly kind: "tree"; readonly entries: readonly ArtifactsTreeEntry[] }
  | { readonly kind: "blob"; readonly bytes: Uint8Array; readonly type: string };

/** An error shaped like the binding's `ArtifactsError`, carrying one of its codes. */
export function reviewArtifactError(code: string): Error {
  const error = new Error("artifacts: " + code);
  error.name = "ArtifactsError";
  // SAFETY: the fake builds the error itself; `code` is the one property it adds to an Error.
  (error as Error & { code: string }).code = code;
  return error;
}

/**
 * The fake namespace and its record of calls.
 *
 * @remarks
 * It is both views a Worker's `env.ARTIFACTS` offers: the mirror's (`create`, and a handle with
 * `info` / `createToken` / `log`) and the review's (`get`, and a handle that reads a commit, a
 * tree, and a file). A fake that answered only one would let a test build a binding the Worker
 * cannot have.
 */
export interface FakeArtifactsReviewBinding
  extends Omit<ArtifactsBinding, "get">, ArtifactsReviewBinding {
  /** Every call, as `get`, `readCommit`, `readTree`, or `readFile` and its argument. */
  readonly calls: string[];
  /** Add an object to a repository by its id, as a push would have landed it. */
  put(repo: string, id: string, object: FakeObject): void;
  /** Make the next call of a kind fail with this error. */
  failNext(kind: "get" | "readCommit" | "readTree" | "readFile", error: Error): void;
}

/**
 * A fake Artifacts namespace over repositories keyed by name.
 *
 * @returns The namespace; a repository exists once an object is put into it.
 */
export function fakeArtifactsReview(): FakeArtifactsReviewBinding {
  const repositories = new Map<string, Map<string, FakeObject>>();
  const calls: string[] = [];
  const failures = new Map<string, Error>();

  const failOr = (kind: string): Error | undefined => {
    const failure = failures.get(kind);
    if (failure !== undefined) failures.delete(kind);
    return failure;
  };

  const handleOf = (repo: Map<string, FakeObject>): ArtifactsReviewHandle => ({
    readCommit: (hash) => {
      calls.push("readCommit " + hash);
      const failure = failOr("readCommit");
      if (failure !== undefined) return Promise.reject(failure);
      const object = repo.get(hash);
      return Promise.resolve(
        object !== undefined && object.kind === "commit" ? object.metadata : null,
      );
    },
    readTree: (hash) => {
      calls.push("readTree " + hash);
      const failure = failOr("readTree");
      if (failure !== undefined) return Promise.reject(failure);
      const object = repo.get(hash);
      return Promise.resolve(
        object !== undefined && object.kind === "tree" ? object.entries : null,
      );
    },
    readFile: (args) => {
      calls.push("readFile " + args.ref + ":" + args.path);
      const failure = failOr("readFile");
      if (failure !== undefined) return Promise.reject(failure);
      // The binding resolves the path at the ref; this fake resolves it the way the adapter
      // needs: the ref is the commit, and the walk is the adapter's, so the file is the blob
      // the path names. A directory or a missing path is null, as the service answers.
      const object = repo.get("blob:" + args.ref + ":" + args.path);
      if (object === undefined || object.kind !== "blob") return Promise.resolve(null);
      // SAFETY: the bytes were copied into a fresh Uint8Array at put time, so their buffer is an
      // ArrayBuffer (BlobPart's requirement); a view over a shared buffer is not one.
      return Promise.resolve(
        new Blob([object.bytes as Uint8Array<ArrayBuffer>], { type: object.type }),
      );
    },
  });

  return {
    calls,
    // The mirror's own lifecycle, which a review never calls: a test that reaches one is a
    // defect the fake makes loud instead of a second shape to keep in step.
    create: () => Promise.reject(new Error("a review never creates a repository")),
    get: (name) => {
      calls.push("get " + name);
      const failure = failOr("get");
      if (failure !== undefined) return Promise.reject(failure);
      const repo = repositories.get(name);
      // The binding throws NOT_FOUND for a repository the namespace does not have.
      if (repo === undefined) return Promise.reject(reviewArtifactError("NOT_FOUND"));
      return Promise.resolve(handleOf(repo));
    },
    put(repo, id, object) {
      const held = repositories.get(repo) ?? new Map<string, FakeObject>();
      held.set(id, object);
      repositories.set(repo, held);
    },

    failNext(kind, error) {
      failures.set(kind, error);
    },
  };
}
