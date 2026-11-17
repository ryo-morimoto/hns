import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  confirmMirror,
  failureOfGit,
  mirrorGitEnv,
  mirrorRemoteUrl,
  pushArgs,
  pushCheckpoint,
} from "../../src/mirror-push.ts";
import { mirrorRef } from "../../src/mirror.ts";
import { httpsGitRemote, type HttpsGitRemote } from "../support/https-git.ts";

/**
 * The mirror's push over a real git remote (T2, the "real path").
 *
 * A local **https** git remote stands in for Artifacts: the same smart-HTTP transport git uses
 * against Artifacts, served by git's own `git-http-backend` over TLS (the mirror refuses any
 * other scheme, NB2). What this file proves is everything the mirror owns — the ref it pushes,
 * the commit that must land, the read-back that decides `mirrored`, the token's environment
 * only — plus the scheme guard. The Worker's own read-back (the binding's `log`) is exercised
 * against a fake binding in `packages/server/src/artifacts/repos.test.ts`.
 *
 * The fixture's git runs **asynchronously**: the https remote lives in this process, and a
 * synchronous child would block the event loop that has to answer it.
 */

const created: string[] = [];
const remotes: HttpsGitRemote[] = [];

/** The environment every fixture's git runs in, with the repository variables removed. */
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

/** Run git in `cwd` and answer its stdout; it never blocks this process's event loop. */
const git = (
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = fixtureEnv(),
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", env }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(error);
    });
  });

/** Read a ref's commit in a repository, or "" when it does not exist. */
const refOf = async (repository: string, ref: string): Promise<string> => {
  try {
    return (await git(repository, ["rev-parse", "--verify", ref])).trim();
  } catch {
    return "";
  }
};

/** A work repository with one commit, and the https remote it will push to. */
async function fixture(): Promise<{
  readonly work: string;
  readonly remote: HttpsGitRemote;
  readonly commit: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "hns-mirror-"));
  created.push(base);
  const work = join(base, "work");
  await git(base, ["init", "-q", work]);
  // A probe first: if git answers with another toplevel, an inherited GIT_* variable redirected
  // it, and every commit below would land in a real repository.
  const toplevel = (await git(work, ["rev-parse", "--show-toplevel"])).trim();
  if (toplevel !== work) {
    throw new Error("the fixture's git resolved another repository: " + toplevel);
  }
  await git(work, ["config", "user.name", "Test"]);
  await git(work, ["config", "user.email", "test@example.com"]);
  await writeFile(join(work, "a.txt"), "one\n");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-q", "-m", "checkpoint"]);
  const commit = (await git(work, ["rev-parse", "HEAD"])).trim();
  const remote = await httpsGitRemote({ repository: work });
  remotes.push(remote);
  // The processes the test starts trust the test's certificate; `mirrorGitEnv` copies the
  // environment, so the push and its read-back inherit this too.
  process.env.GIT_SSL_CAINFO = remote.certificate;
  return { work, remote, commit };
}

afterEach(async () => {
  delete process.env.GIT_SSL_CAINFO;
  await Promise.all(remotes.splice(0).map((remote) => remote.close()));
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// C2 / T2: Catches a push that does not land, a read-back that is skipped or rounded, or a ref
// that is not the Run's branch. The transport is real: https, smart HTTP, TLS.
test("a push over https lands the commit on the Run's branch and the read-back confirms it", async () => {
  const { work, remote, commit } = await fixture();
  const ref = mirrorRef("run-1");
  const outcome = await pushCheckpoint({
    root: work,
    remote: remote.remote,
    token: "art_v2_x_probe_token_0001",
    runId: "run-1",
    commit,
  });
  expect(outcome).toStrictEqual({ status: "mirrored", ref, commit });
  // The remote really holds it: the exported repository's own ref, read by a second git.
  expect(await refOf(remote.directory, ref)).toBe(commit);
  expect((await git(remote.directory, ["cat-file", "-t", commit])).trim()).toBe("commit");
  expect(
    await confirmMirror({
      root: work,
      remote: remote.remote,
      token: "art_v2_x_probe_token_0001",
      ref,
      commit,
    }),
  ).toStrictEqual({ ok: true });
});

// C2 / idempotency: Catches a retried push making a second commit or moving the ref away.
test("a retried push is the same commit and the same ref", async () => {
  const { work, remote, commit } = await fixture();
  const request = {
    root: work,
    remote: remote.remote,
    token: "art_v2_x_probe_token_0002",
    runId: "run-1",
    commit,
  };
  expect((await pushCheckpoint(request)).status).toBe("mirrored");
  expect((await pushCheckpoint(request)).status).toBe("mirrored");
  expect(await refOf(remote.directory, mirrorRef("run-1"))).toBe(commit);
  // One branch, one commit: a push of the same commit adds nothing to the remote's history.
  expect((await git(remote.directory, ["rev-list", "--all", "--count"])).trim()).toBe("1");
});

// NB2: Catches a mirror that would let the device key's holder name any transport git supports.
// `file://`, `ssh://`, and `ext::` are ways to make the machine read or run something that is
// not the mirror; a remote with a userinfo section puts a credential in a URL.
test("only Artifacts' https remote is a mirror: other schemes are unsupported", async () => {
  const { work, remote, commit } = await fixture();
  const refused = [
    "file:///etc",
    "file://" + remote.directory,
    "ssh://git@example.com/ns/repo.git",
    "git@example.com:ns/repo.git",
    "ext::sh -c 'echo pwned' %S",
    "http://127.0.0.1:1/repo.git",
    "https://user:pass@example.com/ns/repo.git",
    "not a url",
    "",
  ];
  for (const candidate of refused) {
    expect(mirrorRemoteUrl(candidate), candidate).toBeUndefined();
    expect(
      await pushCheckpoint({
        root: work,
        remote: candidate,
        token: "art_v2_x_probe_token_0003",
        runId: "run-1",
        commit,
      }),
      candidate,
    ).toStrictEqual({ status: "failed", failure: "unsupported", ref: mirrorRef("run-1") });
    expect(
      await confirmMirror({
        root: work,
        remote: candidate,
        token: "art_v2_x_probe_token_0003",
        ref: mirrorRef("run-1"),
        commit,
      }),
      candidate,
    ).toStrictEqual({ ok: false, failure: "unsupported" });
  }
  // Nothing landed: the exported repository has no Run branch.
  expect(await refOf(remote.directory, mirrorRef("run-1"))).toBe("");
  // The one scheme that passes is https with a host and no userinfo.
  expect(mirrorRemoteUrl("https://acct.artifacts.cloudflare.net/git/ns/repo.git")?.host).toBe(
    "acct.artifacts.cloudflare.net",
  );
});

// C3: Catches a push the remote refuses being answered as mirrored, or a failure outside the
// contract's vocabulary.
test("a push to an unreachable https remote is a closed failure, never a mirrored run", async () => {
  const { work, commit } = await fixture();
  // A port nothing listens on: the transport fails, which is `network` (or `repo_unavailable`
  // when the server answers that the repository is not there).
  const refused = await pushCheckpoint({
    root: work,
    remote: "https://127.0.0.1:9/ns/repo.git",
    token: "art_v2_x_probe_token_0004",
    runId: "run-1",
    commit,
  });
  expect(refused.status).toBe("failed");
  if (refused.status === "failed") {
    expect(["network", "repo_unavailable", "unauthorized", "unknown"]).toContain(refused.failure);
    expect(refused.ref).toBe(mirrorRef("run-1"));
  }
});

// C2 / read-back: Catches a confirmation that accepts any commit it finds, or one that turns a
// missing ref into a success. The read-back is what decides `mirrored`, so it must say no.
test("the read-back confirms only the exact commit at the exact ref", async () => {
  const { work, remote, commit } = await fixture();
  const ref = mirrorRef("run-1");
  const request = {
    root: work,
    remote: remote.remote,
    token: "art_v2_x_probe_token_0005",
    runId: "run-1",
    ref,
    commit,
  };
  // Nothing is on the remote yet: the read-back refuses.
  expect(await confirmMirror(request)).toStrictEqual({ ok: false, failure: "push_rejected" });
  // The remote holds another commit at the ref: the same refusal, not a success.
  await writeFile(join(work, "b.txt"), "two\n");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-q", "-m", "second"]);
  const other = (await git(work, ["rev-parse", "HEAD"])).trim();
  await git(work, ["push", "-q", remote.remote, other + ":" + ref], {
    ...fixtureEnv(),
    GIT_SSL_CAINFO: remote.certificate,
  });
  expect(await confirmMirror(request)).toStrictEqual({ ok: false, failure: "push_rejected" });
  // A ref that does not exist reads as the same refusal.
  expect(await confirmMirror({ ...request, ref: mirrorRef("run-2") })).toStrictEqual({
    ok: false,
    failure: "push_rejected",
  });
  // The push itself sees the moved ref and refuses to overwrite it.
  expect(await pushCheckpoint(request)).toStrictEqual({
    status: "failed",
    failure: "push_rejected",
    ref,
  });
});

// C3: Catches a ref the remote already holds at another commit being forced over, or a read-back
// that accepts any commit it finds.
test("a ref that moved is rejected and is not forced over", async () => {
  const { work, remote, commit } = await fixture();
  await writeFile(join(work, "b.txt"), "two\n");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-q", "-m", "second"]);
  const other = (await git(work, ["rev-parse", "HEAD"])).trim();
  // Another Run's answer put a different commit on this ref first.
  await git(work, ["push", "-q", remote.remote, other + ":" + mirrorRef("run-1")], {
    ...fixtureEnv(),
    GIT_SSL_CAINFO: remote.certificate,
  });
  const outcome = await pushCheckpoint({
    root: work,
    remote: remote.remote,
    token: "art_v2_x_probe_token_0006",
    runId: "run-1",
    commit,
  });
  expect(outcome).toStrictEqual({
    status: "failed",
    failure: "push_rejected",
    ref: mirrorRef("run-1"),
  });
  // The remote still has the first commit: the push did not force over it.
  expect(await refOf(remote.directory, mirrorRef("run-1"))).toBe(other);
});

// C5: Catches the token reaching argv, a remote URL in the repository's config, or a trace.
test("the token travels in the environment only and is never written down", async () => {
  const { work, remote, commit } = await fixture();
  const token = "art_v2_x_probe_token_0007_secret";
  const env = mirrorGitEnv(remote.remote, token);
  expect(env.GIT_CONFIG_COUNT).toBe("1");
  expect(env.GIT_CONFIG_KEY_0).toBe("http." + remote.remote + ".extraHeader");
  expect(env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer " + token);
  // The variables that would answer for the header or print it are gone.
  for (const name of [
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_TRACE",
    "GIT_TRACE_PACKET",
    "GIT_CURL_VERBOSE",
    "GIT_DIR",
    "GIT_WORK_TREE",
  ]) {
    expect(env).not.toHaveProperty(name);
  }
  // The arguments the push runs carry no credential: the remote is the target's, unadorned.
  const args = pushArgs(remote.remote, commit, mirrorRef("run-1"));
  expect(args).toStrictEqual(["push", remote.remote, commit + ":" + mirrorRef("run-1")]);
  expect(args.join(" ")).not.toContain(token);
  await pushCheckpoint({ root: work, remote: remote.remote, token, runId: "run-1", commit });
  // The token is in no config, no remote URL, and no ref: a reader of the repository cannot find it.
  const config = (await git(work, ["config", "--list", "--show-origin"])).concat(
    await git(remote.directory, ["config", "--list"]),
  );
  expect(config).not.toContain(token);
  expect(await git(work, ["remote", "-v"])).not.toContain(token);
  const refs = await git(remote.directory, ["for-each-ref"]);
  expect(refs.includes(mirrorRef("run-1"))).toBe(true);
  expect(refs).not.toContain(token);
});

// C3: Catches git's own words being read as the wrong failure; an unrecognised one stays unknown.
test("git's diagnostics map to the contract's failures", () => {
  expect(failureOfGit("fatal: Authentication failed for 'https://x'")).toBe("unauthorized");
  expect(failureOfGit("error: The requested URL returned error: 403")).toBe("unauthorized");
  expect(failureOfGit("remote: Repository not found.")).toBe("repo_unavailable");
  expect(failureOfGit("! [remote rejected] (pre-receive hook declined)")).toBe("push_rejected");
  expect(failureOfGit("fatal: unable to access: Could not resolve host: x")).toBe("network");
  expect(failureOfGit("fatal: something nobody has seen")).toBe("unknown");
});
