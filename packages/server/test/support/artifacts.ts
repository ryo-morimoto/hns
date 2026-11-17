import type { ArtifactsBinding, ArtifactsRepoHandle } from "../../src/artifacts/repos.ts";

/**
 * A fake `env.ARTIFACTS`, shaped like the Workers binding's calls the mirror reads.
 *
 * @remarks
 * It keeps repositories in memory and records every call, so a test can assert that a repository
 * was created once, that a token was issued with the TTL the mirror asked for, and what a
 * read-back saw. The failures are the binding's own codes (`ArtifactsError`), so the mirror's
 * mapping is what is exercised: a test that wants `UPSTREAM_UNAVAILABLE` asks for it here and
 * reads the mirror's failure word back.
 */

/** One repository the fake holds. */
interface FakeRepo {
  readonly name: string;
  readonly remote: string;
  readonly tokens: { readonly plaintext: string; readonly expiresAt: string }[];
  /** The refs the fake's history has: ref -> commits, newest first. */
  readonly refs: Map<string, string[]>;
}

/** Where the fake's clock reads; a test that pins the time sets it before it runs. */
export interface FakeArtifactsOptions {
  /** Milliseconds since the epoch; `Date.now` when absent. */
  readonly now?: (() => number) | undefined;
}

/** The fake namespace binding plus its record of calls. */
export interface FakeArtifactsBinding extends ArtifactsBinding {
  /** The names this fake was asked to create. */
  readonly creates: string[];
  /** The tokens it issued, in order. */
  readonly tokens: string[];
  /** Make the next `create` fail with this error. */
  failNextCreate(error: Error): void;
  /** Make the next `create` look like a race: another caller created the repository first. */
  raceNextCreate(): void;
  /** Make the next `log` fail with this error. */
  failNextLog(error: Error): void;
  /** Make the next `get` (the handle lookup) fail with this error. */
  failNextGet(error: Error): void;
  /** Put a commit at the top of a ref, as a push would. */
  push(repo: string, ref: string, commit: string): void;
}

/** An error shaped like the binding's `ArtifactsError`, carrying one of its codes. */
export function artifactError(code: string): Error {
  const error = new Error("artifacts: " + code);
  error.name = "ArtifactsError";
  // SAFETY: the fake builds the error itself; `code` is the one property it adds to an Error.
  (error as Error & { code: string }).code = code;
  return error;
}

let issued = 0;

/** A fake Artifacts namespace. */
export function fakeArtifactsBinding(options: FakeArtifactsOptions = {}): FakeArtifactsBinding {
  const clock = options.now ?? (() => Date.now());
  const repos = new Map<string, FakeRepo>();
  const creates: string[] = [];
  const tokens: string[] = [];
  let pendingCreateFailure: Error | undefined;
  let raceNext = false;
  let pendingLogFailure: Error | undefined;
  let pendingGetFailure: Error | undefined;

  const handleOf = (repo: FakeRepo): ArtifactsRepoHandle => ({
    info: () => Promise.resolve({ name: repo.name, remote: repo.remote }),
    createToken: (scope: "read" | "write", ttl = 86_400) => {
      if (scope !== "write") return Promise.reject(artifactError("INVALID_INPUT"));
      issued += 1;
      const expiresAt = new Date(clock() + ttl * 1000).toISOString();
      const token = { plaintext: "art_v2_x_secret" + String(issued).padStart(4, "0"), expiresAt };
      repo.tokens.push(token);
      tokens.push(token.plaintext);
      return Promise.resolve({
        id: "tkn-" + String(issued),
        plaintext: token.plaintext,
        scope,
        expiresAt,
      });
    },
    log: (options: { readonly ref?: string; readonly limit?: number } = {}) => {
      if (pendingLogFailure !== undefined) {
        const error = pendingLogFailure;
        pendingLogFailure = undefined;
        return Promise.reject(error);
      }
      const ref = options.ref ?? "refs/heads/main";
      const commits = repo.refs.get(ref);
      if (commits === undefined) return Promise.reject(artifactError("NOT_FOUND"));
      const limit = options.limit ?? 50;
      return Promise.resolve(
        commits.slice(0, limit).map((hash) => ({ hash, ref, message: "checkpoint" })),
      );
    },
  });

  return {
    creates,
    tokens,
    create(name: string) {
      creates.push(name);
      if (pendingCreateFailure !== undefined) {
        const error = pendingCreateFailure;
        pendingCreateFailure = undefined;
        return Promise.reject(error);
      }
      if (raceNext) {
        raceNext = false;
        if (!repos.has(name)) {
          repos.set(name, {
            name,
            remote: "https://git.example/git/ns/" + name + ".git",
            tokens: [],
            refs: new Map(),
          });
        }
        return Promise.reject(artifactError("ALREADY_EXISTS"));
      }
      if (repos.has(name)) return Promise.reject(artifactError("ALREADY_EXISTS"));
      const repo: FakeRepo = {
        name,
        remote: "https://git.example/git/ns/" + name + ".git",
        tokens: [],
        refs: new Map(),
      };
      repos.set(name, repo);
      issued += 1;
      const token = {
        plaintext: "art_v2_x_secret" + String(issued).padStart(4, "0"),
        expiresAt: new Date(clock() + 86_400_000).toISOString(),
      };
      repo.tokens.push(token);
      tokens.push(token.plaintext);
      return Promise.resolve({
        name,
        remote: repo.remote,
        defaultBranch: "main",
        token: token.plaintext,
      });
    },
    get(name: string) {
      if (pendingGetFailure !== undefined) {
        const error = pendingGetFailure;
        pendingGetFailure = undefined;
        return Promise.reject(error);
      }
      const repo = repos.get(name);
      return Promise.resolve(repo === undefined ? null : handleOf(repo));
    },
    failNextCreate(error: Error) {
      pendingCreateFailure = error;
    },
    raceNextCreate() {
      raceNext = true;
    },
    failNextLog(error: Error) {
      pendingLogFailure = error;
    },
    failNextGet(error: Error) {
      pendingGetFailure = error;
    },
    push(repo: string, ref: string, commit: string) {
      const held = repos.get(repo);
      if (held === undefined) throw new Error("no such repo in the fake: " + repo);
      const commits = held.refs.get(ref) ?? [];
      held.refs.set(ref, [commit, ...commits]);
    },
  };
}
