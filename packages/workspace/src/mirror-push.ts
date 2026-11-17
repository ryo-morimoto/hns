import { spawn } from "node:child_process";
import { MIRROR_FAILURES, type MirrorFailure } from "@hns/core";
import { mirrorRef } from "./mirror.ts";

/**
 * Push one checkpoint commit to Artifacts with a git process, and confirm it landed.
 *
 * @remarks
 * The push is git's, not a re-implementation: the commit already exists in the workspace's git
 * repository (the checkpoint's `checkpointRun` made it), so this module only moves the ref over
 * the smart HTTP transport and reads it back.
 *
 * **The token never leaves this module's environment.** It travels as
 * `http.<remote>.extraHeader` (an `Authorization: Bearer` header) in a private
 * `GIT_CONFIG_*` environment, **not** in the URL and **not** in argv, so it cannot reach a
 * command line another user can read, a remote URL stored in `.git/config`, or a log line. The
 * inherited environment is stripped of the variables that would print it (`GIT_TRACE*`,
 * `GIT_CURL_VERBOSE`), of the helper that could answer instead of the header (`GIT_ASKPASS`,
 * `SSH_ASKPASS`), and of the repository-location variables a caller may have set (`GIT_DIR` and
 * company), so this always runs against the root's own repository. git's own stderr is mapped to
 * a closed {@link MirrorFailure} and dropped: it can quote the request headers back.
 *
 * This subpath spawns a process, so it is not part of the package's root entry (a Worker bundle
 * has no `node:child_process`).
 */

/** What one push needs. */
export interface MirrorPushRequest {
  /** The workspace's git repository (the machine's ROOT). */
  readonly root: string;
  /** The Artifacts remote, `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. */
  readonly remote: string;
  /** The write token; a secret, used in this call's environment only. */
  readonly token: string;
  /** The ref to push, `refs/heads/hns/run/<runId>`; {@link pushCheckpoint} derives it when absent. */
  readonly ref?: string | undefined;
  /** The Run whose ref this is; used with {@link mirrorRef} for `ref`. */
  readonly runId: string;
  /** The commit to push (C in `(C, J)`). */
  readonly commit: string;
}

/**
 * The outcome of one mirror attempt, as the Worker records it.
 *
 * @remarks
 * `mirrored` carries the commit the remote holds; the failure members are exactly the
 * contract's {@link MIRROR_FAILURES}, so the Worker never parses a message to pick a state.
 */
export type MirrorPushOutcome =
  | { readonly status: "mirrored"; readonly ref: string; readonly commit: string }
  | {
      readonly status: "failed";
      readonly failure: MirrorFailure;
      /** The ref that was attempted, for the record; never a secret. */
      readonly ref: string;
    };

/** How long one git invocation may take before the push is counted as a network failure. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * The environment a git process of the mirror runs in.
 *
 * @param remote - The remote the request goes to, for its header key.
 * @param token - The write token.
 * @returns A copy of the process environment with the secrets and repository variables removed,
 * and the one header that carries the token.
 *
 * @remarks
 * The caller's environment is copied because git needs its PATH; everything that could print
 * the token, answer in its place, or redirect the repository is deleted first. The header is
 * scoped to this one remote so a redirect to another host does not receive it.
 *
 * @internal
 */
export function mirrorGitEnv(remote: string, token: string): NodeJS.ProcessEnv {
  return {
    ...mirrorBaseEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http." + remote + ".extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: Bearer " + token,
  };
}

/**
 * The environment a git process of the mirror runs in, without any credential.
 *
 * @returns The process environment with the variables that could print a token, answer in its
 * place, or redirect the repository removed.
 *
 * @internal
 */
function mirrorBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
    "GIT_TRACE",
    "GIT_TRACE_PACKET",
    "GIT_TRACE_CURL",
    "GIT_TRACE_CURL_NO_DATA",
    "GIT_CURL_VERBOSE",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_TERMINAL_PROMPT",
  ]) {
    delete env[name];
  }
  // The config slots are git's own: a caller that set one would otherwise append or replace the
  // header, so they are cleared before the four below are filled.
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_CONFIG_")) delete env[name];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

/** What running git produced, without its stderr reaching anything. */
type GitRun =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly exitCode: number | null; readonly stderr: string };

/** Run git in `root` with the mirror's environment and answer its stdout. */
function runGit(root: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      // A git that never answered is a transport failure, not a refusal: `network` says so.
      resolve({ ok: false, exitCode: null, stderr: "git timed out" });
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stderr: "git could not start" });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, stdout: Buffer.concat(stdout).toString("utf8") });
        return;
      }
      resolve({
        ok: false,
        exitCode: code,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

/**
 * Map git's output to one of the contract's failures.
 *
 * @param stderr - git's diagnostics; read, classified, and then dropped by the caller.
 * @returns The closed failure code.
 *
 * @remarks
 * The classification reads git's own words because git has no machine-readable failure code on
 * the transport. Anything unrecognised is `unknown` and keeps the state recordable rather than
 * guessed at. A message that names a credential is never logged or returned.
 *
 * @internal
 */
export function failureOfGit(stderr: string): MirrorFailure {
  const text = stderr.toLowerCase();
  if (/\b401\b|\b403\b|authentication failed|unauthorized|invalid credentials/u.test(text)) {
    return "unauthorized";
  }
  if (
    /repository not found|does not exist|could not read from remote|repository unavailable/u.test(
      text,
    )
  ) {
    return "repo_unavailable";
  }
  if (
    /pre-receive hook declined|hook declined|non-fast-forward|failed to push|remote rejected|remote failure/u.test(
      text,
    )
  ) {
    return "push_rejected";
  }
  if (
    /could not resolve host|connection refused|connection reset|timed out|network is unreachable|failed to connect|early eof/u.test(
      text,
    )
  ) {
    return "network";
  }
  return "unknown";
}

/**
 * Whether a value is one of the contract's mirror failures.
 *
 * @param value - A value from outside this module.
 * @returns True for a member of {@link MIRROR_FAILURES}.
 *
 * @internal
 */
export const isMirrorFailure = (value: string): value is MirrorFailure =>
  MIRROR_FAILURES.some((failure) => failure === value);

/**
 * Push one Run's checkpoint commit to Artifacts.
 *
 * @param request - The root, the remote, the token, the Run, and the commit.
 * @returns `mirrored` with the ref and commit the remote holds, or `failed` with the contract's
 * failure code.
 * @throws RangeError when the Run id is not one ref component.
 *
 * @remarks
 * The push is `git push <remote> <commit>:<ref>`, which is idempotent: a retried push of the same
 * commit updates the ref to the value it already has, so a lost answer is not a second commit. A
 * non-fast-forward (the ref moved to another commit) is `push_rejected` and is **not** forced
 * over: one Run's checkpoint is decided once, and a second commit under the same ref is a
 * different run.
 *
 * **A partial clone is not a complete one.** The push sends the objects the local repository
 * *has*; a commit whose objects are missing (an empty repository, a promisor remote that was never
 * fetched) is pushed as nothing and the remote refuses the unpack. That refusal is caught by the
 * read-back, which finds no ref at the commit and answers `push_rejected`; the mirror would
 * otherwise take the remote's "eof before pack header" for a transport failure, so the commit's
 * presence is checked before anything leaves.
 *
 * The answer is not trusted on its own: the push is confirmed by reading the ref back, and only
 * the read-back decides `mirrored`. A push that exited 0 but whose ref does not read back the
 * commit is `unknown`, never a success.
 */
export async function pushCheckpoint(request: MirrorPushRequest): Promise<MirrorPushOutcome> {
  const ref = request.ref ?? mirrorRef(request.runId);
  const args = pushArgs(request.remote, request.commit, ref);
  if (request.token.length > 0 && args.some((argument) => argument.includes(request.token))) {
    // Not reachable with the argument list above; the guard is what keeps it that way if a
    // future caller passes a remote that carries a userinfo section.
    return { status: "failed", failure: "unknown", ref };
  }
  if (!(await holdsCommit(request.root, request.commit))) {
    // The commit is not in the repository: there is nothing to send, and the Run's checkpoint
    // cannot be mirrored by trying harder.
    return { status: "failed", failure: "push_rejected", ref };
  }
  const env = mirrorGitEnv(request.remote, request.token);
  const pushed = await runGit(request.root, args, env);
  if (!pushed.ok) return { status: "failed", failure: failureOfGit(pushed.stderr), ref };
  const confirmed = await confirmMirror({
    root: request.root,
    remote: request.remote,
    token: request.token,
    ref,
    commit: request.commit,
  });
  return confirmed.ok
    ? { status: "mirrored", ref, commit: request.commit }
    : { status: "failed", failure: confirmed.failure, ref };
}

/**
 * The arguments one push runs with.
 *
 * @param remote - The remote the target named.
 * @param commit - The commit to send.
 * @param ref - The ref it must land on.
 * @returns `["push", <remote>, <commit>:<ref>]`: no credential, because the token travels as an
 * environment header ({@link mirrorGitEnv}).
 *
 * @remarks
 * Exported so a test can assert the shape directly; the token must never be an argument (it would
 * be visible in a process list and in a trace).
 *
 * @internal
 */
export function pushArgs(remote: string, commit: string, ref: string): readonly string[] {
  return ["push", remote, commit + ":" + ref];
}

/**
 * Whether the repository has the commit git would push.
 *
 * @param root - The repository.
 * @param commit - The commit id to look for.
 * @returns True when `git cat-file -e <commit>^{commit}` succeeds.
 *
 * @remarks
 * Only the repository's own objects are checked (no lazy fetch): a missing object is the case the
 * push would fail on, and asking a promisor remote here would make the mirror's latency depend on
 * another network hop.
 *
 * @internal
 */
async function holdsCommit(root: string, commit: string): Promise<boolean> {
  // A minimal environment: the check reads one object and needs none of the push's headers.
  const read = await runGit(root, ["cat-file", "-e", commit + "^{commit}"], mirrorBaseEnv());
  return read.ok;
}

/** What confirming a push needs: the same remote and token, the ref, and the commit. */
export interface MirrorConfirmRequest {
  readonly root: string;
  readonly remote: string;
  readonly token: string;
  readonly ref: string;
  readonly commit: string;
}

/**
 * Read one ref back from the remote.
 *
 * @param request - The root, remote, token, ref, and the commit the ref must point at.
 * @returns `ok` when the remote's ref is the commit; otherwise the closed failure.
 *
 * @remarks
 * This is the machine's half of the mirror's confirmation, and the test's stand-in for the
 * Worker's binding: the Worker reads the same ref back through `env.ARTIFACTS`'s `log`, and the
 * two must agree before the mirror is `mirrored`. A missing ref is `push_rejected` (the push
 * did not land), and a ref at another commit is the same: the push never became the checkpoint.
 */
export async function confirmMirror(
  request: MirrorConfirmRequest,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: MirrorFailure }> {
  const env = mirrorGitEnv(request.remote, request.token);
  const read = await runGit(request.root, ["ls-remote", request.remote, request.ref], env);
  if (!read.ok) return { ok: false, failure: failureOfGit(read.stderr) };
  const line = read.stdout.split("\n").find((candidate) => candidate.length > 0);
  if (line === undefined) return { ok: false, failure: "push_rejected" };
  const [id, named] = line.split("\t");
  if (named !== request.ref) return { ok: false, failure: "push_rejected" };
  return id === request.commit ? { ok: true } : { ok: false, failure: "push_rejected" };
}
