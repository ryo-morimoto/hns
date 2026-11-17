import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  mirrorGitEnv,
  confirmMirror,
  failureOfGit,
  pushArgs,
  pushCheckpoint,
} from "../../src/mirror-push.ts";
import { mirrorRef } from "../../src/mirror.ts";

/**
 * The mirror's push over a real git remote (T2, the "real path").
 *
 * A local **bare repository** stands in for an Artifacts remote: git's smart-HTTP transport is
 * not involved, but everything the mirror owns is — the ref it pushes, the commit that must land,
 * the read-back that decides `mirrored`, and the environment the token travels in. The Worker's
 * own read-back (the binding's `log`) is exercised against a fake binding in
 * `packages/server/src/artifacts/repos.test.ts`; this file exercises the machine's half.
 */

const created: string[] = [];

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

/** Run git in `cwd` and answer its stdout. */
const git = (cwd: string, args: readonly string[], input?: string): string =>
  execFileSync("git", args, { cwd, input, encoding: "utf8", env: fixtureEnv() });

/** A work repository with one commit, and the bare repository it will push to. */
async function fixture(): Promise<{
  readonly work: string;
  readonly bare: string;
  readonly commit: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "hns-mirror-"));
  created.push(base);
  const work = join(base, "work");
  const bare = join(base, "remote.git");
  git(base, ["init", "-q", work]);
  // A probe first: if git answers with another toplevel, an inherited GIT_* variable redirected
  // it, and every commit below would land in a real repository.
  const toplevel = git(work, ["rev-parse", "--show-toplevel"]).trim();
  if (toplevel !== work)
    throw new Error("the fixture's git resolved another repository: " + toplevel);
  git(work, ["config", "user.name", "Test"]);
  git(work, ["config", "user.email", "test@example.com"]);
  await writeFile(join(work, "a.txt"), "one\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "checkpoint"]);
  const commit = git(work, ["rev-parse", "HEAD"]).trim();
  git(base, ["init", "-q", "--bare", bare]);
  return { work, bare, commit };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// C2 / T2: Catches a push that does not land, a read-back that is skipped or rounded, or a ref
// that is not the Run's branch.
test("a push lands the commit on the Run's branch and the read-back confirms it", async () => {
  const { work, bare, commit } = await fixture();
  const ref = mirrorRef("run-1");
  const outcome = await pushCheckpoint({
    root: work,
    remote: bare,
    // A bare path remote ignores the header; the token travels the same way it does to Artifacts.
    token: "art_v2_x_probe_token_0001",
    runId: "run-1",
    commit,
  });
  expect(outcome).toStrictEqual({ status: "mirrored", ref, commit });
  // The remote really holds it: the bare repository's own ref, read by a second git.
  expect(git(bare, ["rev-parse", ref]).trim()).toBe(commit);
  expect(git(bare, ["cat-file", "-t", commit]).trim()).toBe("commit");
  const confirmed = await confirmMirror({
    root: work,
    remote: bare,
    token: "art_v2_x_probe_token_0001",
    ref,
    commit,
  });
  expect(confirmed).toStrictEqual({ ok: true });
});

// C2 / idempotency: Catches a retried push making a second commit or moving the ref away.
test("a retried push is the same commit and the same ref", async () => {
  const { work, bare, commit } = await fixture();
  const request = {
    root: work,
    remote: bare,
    token: "art_v2_x_probe_token_0002",
    runId: "run-1",
    commit,
  };
  expect((await pushCheckpoint(request)).status).toBe("mirrored");
  expect((await pushCheckpoint(request)).status).toBe("mirrored");
  expect(git(bare, ["rev-parse", mirrorRef("run-1")]).trim()).toBe(commit);
  // One branch, one commit: a push of the same commit adds nothing to the remote's history.
  expect(git(bare, ["rev-list", "--all", "--count"]).trim()).toBe("1");
});

// C3: Catches a push the remote refuses being answered as mirrored, or a failure outside the
// contract's vocabulary.
test("a refused push is a closed failure, never a mirrored run", async () => {
  const { work, bare, commit } = await fixture();
  const missingRemote = join(bare, "..", "elsewhere.git");
  const refused = await pushCheckpoint({
    root: work,
    remote: missingRemote,
    token: "art_v2_x_probe_token_0003",
    runId: "run-1",
    commit,
  });
  expect(refused.status).toBe("failed");
  if (refused.status === "failed") {
    expect(["repo_unavailable", "network", "unknown"]).toContain(refused.failure);
    expect(refused.ref).toBe(mirrorRef("run-1"));
  }
  expect(git(bare, ["for-each-ref", "refs/heads"]).trim()).toBe("");
});

// C2 / read-back: Catches a confirmation that accepts any commit it finds, or one that turns a
// missing ref into a success. The read-back is what decides `mirrored`, so it must say no.
test("the read-back confirms only the exact commit at the exact ref", async () => {
  const { work, bare, commit } = await fixture();
  const ref = mirrorRef("run-1");
  const request = {
    root: work,
    remote: bare,
    token: "art_v2_x_probe_token_0006",
    runId: "run-1",
    ref,
    commit,
  };
  // Nothing is on the remote yet: the read-back refuses.
  expect(await confirmMirror(request)).toStrictEqual({ ok: false, failure: "push_rejected" });
  // The remote holds another commit at the ref: the same refusal, not a success.
  await writeFile(join(work, "b.txt"), "two\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "second"]);
  const other = git(work, ["rev-parse", "HEAD"]).trim();
  git(work, ["push", "-q", bare, other + ":" + ref]);
  expect(await confirmMirror(request)).toStrictEqual({ ok: false, failure: "push_rejected" });
  // The remote's ref is at the commit and still the read-back answers for the another ref's read.
  expect(await confirmMirror({ ...request, ref: mirrorRef("run-2") })).toStrictEqual({
    ok: false,
    failure: "push_rejected",
  });
  // The push itself sees the moved ref and refuses to overwrite it.
  expect(await pushCheckpoint({ ...request, token: "art_v2_x_probe_token_0007" })).toStrictEqual({
    status: "failed",
    failure: "push_rejected",
    ref,
  });
});

// C3: Catches a ref the remote already holds at another commit being forced over, or a read-back
// that accepts any commit it finds.
test("a ref that moved is rejected and is not forced over", async () => {
  const { work, bare, commit } = await fixture();
  await writeFile(join(work, "b.txt"), "two\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "second"]);
  const other = git(work, ["rev-parse", "HEAD"]).trim();
  // Another Run's answer put a different commit on this ref first.
  git(work, ["push", "-q", bare, other + ":" + mirrorRef("run-1")]);
  const outcome = await pushCheckpoint({
    root: work,
    remote: bare,
    token: "art_v2_x_probe_token_0004",
    runId: "run-1",
    commit,
  });
  expect(outcome).toStrictEqual({
    status: "failed",
    failure: "push_rejected",
    ref: mirrorRef("run-1"),
  });
  // The remote still has the first commit: the push did not force over it.
  expect(git(bare, ["rev-parse", mirrorRef("run-1")]).trim()).toBe(other);
});

// C5: Catches the token reaching argv, a remote URL in the repository's config, or a trace.
test("the token travels in the environment only and is never written down", async () => {
  const { work, bare, commit } = await fixture();
  const token = "art_v2_x_probe_token_0005_secret";
  const env = mirrorGitEnv(bare, token);
  expect(env.GIT_CONFIG_COUNT).toBe("1");
  expect(env.GIT_CONFIG_KEY_0).toBe("http." + bare + ".extraHeader");
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
  // The environment is the only place the token is: the args the push builds carry none of it, and
  // the remote it is given is the one the target named, unadorned.
  const args = pushArgs(bare, commit, mirrorRef("run-1"));
  expect(args).toStrictEqual(["push", bare, commit + ":" + mirrorRef("run-1")]);
  expect(args.join(" ")).not.toContain(token);
  await pushCheckpoint({ root: work, remote: bare, token, runId: "run-1", commit });
  // The token is in no config, no remote URL, and no ref: a reader of the repository cannot find it.
  const config = git(work, ["config", "--list", "--show-origin"]).concat(
    git(bare, ["config", "--list"]),
  );
  expect(config).not.toContain(token);
  expect(git(work, ["remote", "-v"])).not.toContain(token);
  expect(git(bare, ["for-each-ref"]).includes(mirrorRef("run-1"))).toBe(true);
  expect(git(bare, ["for-each-ref"])).not.toContain(token);
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
