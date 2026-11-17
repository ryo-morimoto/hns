import { ARTIFACTS_MAX_BLOB_BYTES, MAX_CHECKPOINT_PACK_BYTES, isoTimestamp } from "@hns/core";
import type { MirrorFailure, MirrorTarget } from "@hns/core";
import * as v from "valibot";

/**
 * The Workspace object's view of Artifacts: one repository per workspace, a short-lived token
 * per push, and a read-back that proves the push landed.
 *
 * @remarks
 * Artifacts is a **mirror** of the checkpoint in R2 (D106), and this module is the only place the
 * mirror's repository lifecycle lives. It owns three decisions: what a workspace's repository is
 * called ({@link artifactsRepoName}), how a push is authorised ({@link ArtifactsRepos.target}),
 * and what "the commit is really there" means ({@link ArtifactsRepos.holds}). Nothing here
 * stores a token: a target is built for one prepare answer and handed to the machine, which is
 * the only other party that ever sees it.
 *
 * The binding is declared structurally, so the Worker's real binding and a fake both fit without
 * `@cloudflare/workers-types`. Only the calls this module makes are declared.
 */

/**
 * The part of Artifacts' `create` answer the mirror reads.
 *
 * @remarks
 * `token` is the write token the new repository is handed. It is a plaintext secret, so the
 * repository is created **with** a target rather than being asked for a second token: one token
 * per creation, and no token lives anywhere else.
 */
export interface ArtifactsRepoCreated {
  readonly name?: string | undefined;
  readonly remote?: string | undefined;
  readonly token?: string | undefined;
}

/** Where a repository lives: the remote a git process pushes to. */
export interface ArtifactsRepoInfo {
  readonly remote: string;
}

/**
 * The part of a repository handle this module calls.
 *
 * @remarks
 * Each method's answer stays `unknown` **on purpose**: the handle is the binding's, whose types
 * the Worker bundle does not carry, and the value is parsed by this module's own schema the
 * moment it arrives (`RepoInfoSchema`, `RepoTokenSchema`, `RepoLogSchema`). Narrowing the
 * parameter to the fields this module sends keeps the call honest without guessing the binding's
 * full option shape.
 */
export interface ArtifactsRepoHandle {
  /** The repository's metadata, including the remote it is reached at. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the binding's boundary: the value is untrusted until RepoInfoSchema, RepoTokenSchema, or RepoLogSchema parses it.
  info(): Promise<unknown>;
  /** Issue a token scoped to the repository; `ttl` is seconds. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the binding's boundary: the value is untrusted until RepoInfoSchema, RepoTokenSchema, or RepoLogSchema parses it.
  createToken(scope: "read" | "write", ttl?: number): Promise<unknown>;
  /** Commits on `ref` (the default branch when absent), newest first. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the binding's boundary: the value is untrusted until RepoInfoSchema, RepoTokenSchema, or RepoLogSchema parses it.
  log(options?: { readonly ref?: string; readonly limit?: number }): Promise<unknown>;
}

/**
 * The subset of the Worker's `ARTIFACTS` namespace binding the mirror calls.
 *
 * @remarks
 * `create` takes the options the mirror sends (none today, so the parameter is optional and
 * empty) and its answer is parsed at the boundary; `get` answers a handle or null.
 */
export interface ArtifactsBinding {
  /** Create a repository; the answer carries the write token it was created with. */
  create(name: string, options?: ArtifactsCreateOptions): Promise<ArtifactsRepoCreated>;
  /** A repository's handle, or null when the namespace has no repository of that name. */
  get(name: string): Promise<ArtifactsRepoHandle | null>;
}

/** The options a create takes from the mirror: none today, so an empty object's shape. */
export interface ArtifactsCreateOptions {
  readonly [key: string]: string | boolean | undefined;
}

/** Artifacts' naming rule for a repository: alphanumeric first, then `._-`; 2 to 63. */
const ARTIFACTS_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/u;

/**
 * The repository name one workspace's mirror lives under.
 *
 * @param workspaceId - The workspace id; any non-empty string.
 * @returns A name Artifacts' rule accepts, derived from the id.
 * @throws RangeError when the id is empty.
 *
 * @remarks
 * A workspace id is not guaranteed to be a valid repository name (it may hold a UUID's hyphens
 * and nothing else is certain), so the mapping is explicit and reversible in the sense a reader
 * needs: `ws-` marks an hns workspace, the id is used verbatim when it already fits Artifacts'
 * rule, and otherwise a readable prefix plus the hex of the full id keeps two ids that share a
 * prefix apart. The name never holds a secret: a workspace id is not one, and the repository is
 * reached only with a token.
 */
export function artifactsRepoName(workspaceId: string): string {
  if (workspaceId.length === 0) throw new RangeError("a workspace id is never empty");
  const prefixed = "ws-" + workspaceId;
  if (ARTIFACTS_REPO_NAME.test(prefixed) && prefixed.length <= 63) return prefixed;
  const readable = workspaceId.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 30);
  const digest = Array.from(new TextEncoder().encode(workspaceId))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return ("ws-" + readable + "-" + digest).slice(0, 63);
}

/** How long a push token lives: the push plus the slack a retry within one checkpoint needs. */
export const MIRROR_TOKEN_TTL_SECONDS = 900;

/**
 * The largest blob and pack one push may carry, as the mirror decides with.
 *
 * @remarks
 * The same numbers the checkpoint contract fixes ({@link ARTIFACTS_MAX_BLOB_BYTES},
 * {@link MAX_CHECKPOINT_PACK_BYTES}), read through here so nothing in the mirror spells its own.
 */
export const ARTIFACTS_REMOTE_LIMITS = {
  /** Artifacts' per-file limit, 32 MiB. */
  maxBlobBytes: ARTIFACTS_MAX_BLOB_BYTES,
  /** Artifacts' per-push limit, 64 MiB. */
  packBytes: MAX_CHECKPOINT_PACK_BYTES,
} as const;

/** What getting or creating the repository did. */
export type RepoOutcome =
  | { readonly ok: true; readonly name: string; readonly remote: string; readonly created: boolean }
  | { readonly ok: false; readonly failure: MirrorFailure };

/** What issuing a target did. */
export type TargetOutcome =
  | { readonly ok: true; readonly target: MirrorTarget }
  | { readonly ok: false; readonly failure: MirrorFailure };

/** A repository handle the read-back reads: its log shape, narrowed. */
const RepoLogSchema: v.GenericSchema<unknown, readonly { readonly hash: string }[]> = v.array(
  v.object({ hash: v.string() }),
);

/** The `create` answer as it arrives, narrowed to the fields the mirror reads. */
const RepoCreatedSchema: v.GenericSchema<unknown, ArtifactsRepoCreated> = v.object({
  name: v.optional(v.string()),
  remote: v.optional(v.string()),
  token: v.optional(v.string()),
});

/** A repository's info as it arrives: the remote a git process pushes to. */
const RepoInfoSchema: v.GenericSchema<unknown, ArtifactsRepoInfo> = v.object({
  remote: v.string(),
});

/**
 * A token as it arrives: the plaintext and its deadline.
 *
 * @remarks
 * Parsed and then read once by the caller. The value is a secret, so it is held by the target
 * that is handed to the machine and by nothing else: `v.object` dropping unknown keys keeps the
 * binding's other fields (the token's id, its scope) out of the value the mirror carries.
 */
const RepoTokenSchema: v.GenericSchema<unknown, { plaintext: string; expiresAt: string }> =
  v.object({ plaintext: v.pipe(v.string(), v.minLength(1)), expiresAt: v.string() });

/**
 * Whether a binding error is the namespace saying the repository already exists.
 *
 * @param error - What the binding threw.
 * @returns True for `ALREADY_EXISTS`.
 *
 * @remarks
 * A create is get-or-create, so the one race two prepares can run is read as the get that lost
 * the race rather than as a failure.
 *
 * @internal
 */
export const isAlreadyExists = (error: Error): boolean => errorCodeOf(error) === "ALREADY_EXISTS";

/**
 * The binding's error code, when the error carries one.
 *
 * @param error - An error the binding threw.
 * @returns Its `code` text, or undefined for an error without one.
 *
 * @remarks
 * The binding's `ArtifactsError` puts its code on the error object rather than in its `name`, so
 * the property is read once here instead of being assumed present everywhere. The code is read
 * as text; whether it names a failure the mirror knows is the caller's switch.
 *
 * @internal
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the catch boundary: a binding may throw any value, and this is where it becomes the Error the mapper reads.
function errorOf(thrown: unknown): Error {
  return thrown instanceof Error
    ? thrown
    : new Error("the binding threw a value that is not an Error");
}

function errorCodeOf(error: Error): string | undefined {
  // SAFETY: an Error value with an own `code` property is what the binding throws; reading it as a
  // string is the check, and the branch uses it only after the check.
  const withCode = error as Error & { readonly code?: unknown };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the binding's error is the boundary: its code is a property on an Error the compiler does not type, so one read checks it here and every caller branches on the domain result.
  return typeof withCode.code === "string" ? withCode.code : undefined;
}

/**
 * Map a binding failure to one of the contract's mirror failures.
 *
 * @param error - What the binding threw.
 * @returns The closed failure code.
 *
 * @remarks
 * The binding's own `ArtifactsError` codes are the closed vocabulary: `NOT_FOUND` is a repository
 * that does not exist, `UPSTREAM_UNAVAILABLE` a binding that could not answer, an unauthenticated
 * or unauthorised answer is `unauthorized`, and everything else is `unknown`. A message is never
 * read, and never logged: it may quote the request.
 *
 * @internal
 */
export function failureOfBinding(error: Error): MirrorFailure {
  const code = errorCodeOf(error);
  switch (code) {
    case "NOT_FOUND":
      return "repo_unavailable";
    case "UPSTREAM_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return "network";
    case "REMOTE_AUTH_REQUIRED":
      return "unauthorized";
    default:
      return "unknown";
  }
}

/**
 * What a read-back of one ref found.
 *
 * @remarks
 * `held` is the only positive answer. `absence` says the repository or the ref is not there
 * (the push did not land), which a re-check can settle; `failure` is the closed code the binding
 * or the history answered with, kept so the record says why instead of "not there".
 */
export type MirrorConfirmation =
  | { readonly ok: true }
  | { readonly ok: false; readonly absence: "repo" | "ref" }
  | { readonly ok: false; readonly failure: MirrorFailure };

/**
 * One workspace's Artifacts repositories.
 *
 * @remarks
 * The repository is created on the **first push** (the prepare of a run that is already within
 * Artifacts' limits), not when the workspace is made: a workspace that never checkpoints should
 * not cost a repository, and a prepare that is never followed by a push leaves one behind that
 * the next prepare reuses. A prepare that finds the repository answers without creating one.
 */
export class ArtifactsRepos {
  readonly #binding: ArtifactsBinding;
  readonly #clock: () => number;

  /**
   * @param binding - The Worker's `ARTIFACTS` binding, or a fake with the same two calls.
   * @param clock - The clock in milliseconds; defaults to `Date.now`.
   */
  constructor(binding: ArtifactsBinding, clock: () => number = () => Date.now()) {
    this.#binding = binding;
    this.#clock = clock;
  }

  /**
   * Get the workspace's repository, creating it when the namespace has none.
   *
   * @param name - The repository name; {@link artifactsRepoName} derives it from a workspace id.
   * @returns The name and remote, and whether this call created it.
   *
   * @remarks
   * A create that races another create (`ALREADY_EXISTS`) is not a failure: the second caller
   * reads the repository the first made and answers `created: false`, so two prepares of one
   * workspace cannot disagree about which repository is its mirror.
   */
  async ensure(name: string): Promise<RepoOutcome> {
    const existing = await this.#handle(name);
    if (existing !== undefined) return await this.#present(name, existing);
    try {
      const created = v.parse(RepoCreatedSchema, await this.#binding.create(name));
      if (created.remote === undefined) return { ok: false, failure: "repo_unavailable" };
      return { ok: true, name, remote: created.remote, created: true };
    } catch (error) {
      const failure = failureOfBinding(errorOf(error));
      if (failure === "unknown" && isAlreadyExists(errorOf(error))) {
        const raced = await this.#handle(name);
        if (raced !== undefined) return await this.#present(name, raced);
      }
      return { ok: false, failure };
    }
  }

  /**
   * Issue one short-lived write target for one Run's commit.
   *
   * @param request - The repository, the ref, and the clock.
   * @returns The target, or the closed failure.
   *
   * @remarks
   * The repository is ensured first: a target that names a repository nobody created is a token
   * for an unreachable remote. The token comes from the repository itself (`createToken` on its
   * handle), so its life and scope are Artifacts' and not this module's. `expiresAt` is the
   * token's own deadline, issued with {@link MIRROR_TOKEN_TTL_SECONDS}.
   */
  async target(request: {
    readonly repo: string;
    readonly ref: string;
    readonly now: number;
  }): Promise<TargetOutcome> {
    const ensured = await this.ensure(request.repo);
    if (!ensured.ok) return ensured;
    try {
      const handle = await this.#handle(request.repo);
      if (handle === undefined) return { ok: false, failure: "repo_unavailable" };
      const issued = await this.#issueToken(handle);
      if (issued === undefined) return { ok: false, failure: "unknown" };
      return {
        ok: true,
        target: {
          remote: ensured.remote,
          token: issued.token,
          ref: request.ref,
          expiresAt: isoTimestamp(issued.expiresAt.toISOString()),
        },
      };
    } catch (error) {
      return { ok: false, failure: failureOfBinding(errorOf(error)) };
    }
  }

  /**
   * Whether the repository holds one commit at one ref.
   *
   * @param request - The repository, the ref, and the commit.
   * @returns `held` when the ref's commit is this one, `absent` when the repository or the ref
   * is not there, or the closed failure the binding answered with.
   *
   * @remarks
   * This is the Worker's half of the push's confirmation: the machine reads the ref back over git,
   * and this reads the same ref through the binding.
   *
   * **Absent and failed are different answers.** A ref that is not there is the push not having
   * landed, which a re-check can settle; a binding that could not answer (`network`,
   * `unauthorized`, `repo_unavailable`) is a failure whose reason the record must keep, so that
   * a broken binding is not written down as "the commit is not there". Neither is ever turned
   * into `held`.
   *
   * The ref is read through the binding's `log` **without a limit narrowing what counts**: the
   * log is the ref's own history, so a commit that is merely older in that history is not the
   * ref's head and does not confirm a push of it. (An existing repository can hold the same
   * commit from an earlier Run; the ref's first entry is what the push moved.)
   */
  async holds(request: {
    readonly repo: string;
    readonly ref: string;
    readonly commit: string;
  }): Promise<MirrorConfirmation> {
    let handle: ArtifactsRepoHandle | undefined;
    try {
      handle = await this.#handle(request.repo);
    } catch (error) {
      return { ok: false, failure: failureOfBinding(errorOf(error)) };
    }
    if (handle === undefined) return { ok: false, absence: "repo" };
    let log: v.InferOutput<typeof RepoLogSchema>;
    try {
      // The log page is the head of the history: the first entry is the ref's tip.
      const parsed = v.safeParse(RepoLogSchema, await handle.log({ ref: request.ref, limit: 1 }));
      if (!parsed.success) return { ok: false, failure: "unknown" };
      log = parsed.output;
    } catch (error) {
      const failure = failureOfBinding(errorOf(error));
      // The binding answers NOT_FOUND for a ref (or repository) it cannot resolve: that is an
      // absence, not a failure. Everything else is the failure it names.
      if (failure === "repo_unavailable") return { ok: false, absence: "ref" };
      return { ok: false, failure };
    }
    const head = log[0];
    if (head === undefined) return { ok: false, absence: "ref" };
    return head.hash === request.commit ? { ok: true } : { ok: false, failure: "push_rejected" };
  }

  /** An existing repository's name and remote. */
  async #present(name: string, handle: ArtifactsRepoHandle): Promise<RepoOutcome> {
    try {
      const info = v.parse(RepoInfoSchema, await handle.info());
      return { ok: true, name, remote: info.remote, created: false };
    } catch (error) {
      return { ok: false, failure: failureOfBinding(errorOf(error)) };
    }
  }

  /** Ask the repository for a write token, or undefined when its answer is not one. */
  async #issueToken(
    handle: ArtifactsRepoHandle,
  ): Promise<{ readonly token: string; readonly expiresAt: Date } | undefined> {
    const issued = v.safeParse(
      RepoTokenSchema,
      await handle.createToken("write", MIRROR_TOKEN_TTL_SECONDS),
    );
    if (!issued.success) return undefined;
    const expiresAt = new Date(issued.output.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return undefined;
    return { token: issued.output.plaintext, expiresAt };
  }

  /** A repository's handle, or undefined plus the failure that prevented one. */
  async #handle(name: string): Promise<ArtifactsRepoHandle | undefined> {
    const handle = await this.#binding.get(name);
    return handle === null ? undefined : handle;
  }

  /** The clock this module reads. */
  now(): number {
    return this.#clock();
  }
}
