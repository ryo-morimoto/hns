import { ARTIFACTS_MAX_BLOB_BYTES, MAX_CHECKPOINT_PACK_BYTES, MIRROR_FAILURES } from "@hns/core";
import { artifactError, fakeArtifactsBinding } from "../../test/support/artifacts.ts";
import { expect, test } from "vitest";
import {
  ARTIFACTS_REMOTE_LIMITS,
  ArtifactsRepos,
  MIRROR_TOKEN_TTL_SECONDS,
  artifactsRepoName,
  failureOfBinding,
} from "./repos.ts";

/**
 * C1 / T1: the repository's name and lifecycle.
 *
 * The fake binding is the Worker's `ARTIFACTS` narrowed to the calls the mirror makes; it records
 * every call so the test can assert what was created, when, and with which token.
 */

// Catches: a repository name Artifacts refuses (a UUID workspace id with a leading digit, a
// character outside the rule), or two different workspaces mapping to one repository.
test("the repo name codec maps a workspace id onto Artifacts' rule", () => {
  const names = [
    "w1",
    "0f8fad5b-d9cb-469f-a165-70867728950e",
    "workspace with spaces",
    "é-accented",
    "x".repeat(200),
    "..",
  ].map((id) => artifactsRepoName(id));
  for (const name of names) {
    expect(name, name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/u);
    expect(name.length).toBeGreaterThanOrEqual(2);
    expect(name.length).toBeLessThanOrEqual(63);
  }
  expect(new Set(names).size).toBe(names.length);
  expect(artifactsRepoName("w1")).toBe("ws-w1");
  expect(artifactsRepoName("a-b")).not.toBe(artifactsRepoName("a_b"));
  expect(artifactsRepoName("a b")).not.toBe(artifactsRepoName("a-b"));
  expect(() => artifactsRepoName("")).toThrow(RangeError);
});

// Catches: a prepare creating a repository on every call (a create per checkpoint), or a target
// that names a repository nobody made.
test("the repo is created once and a target is issued with a short TTL", async () => {
  const now = (): number => Date.parse("2026-01-01T00:00:00.000Z");
  const binding = fakeArtifactsBinding({ now });
  const repos = new ArtifactsRepos(binding, now);
  const first = await repos.target({
    repo: artifactsRepoName("w1"),
    ref: "refs/heads/hns/run/run-1",
    now: repos.now(),
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(binding.creates).toStrictEqual([artifactsRepoName("w1")]);
  expect(first.target.remote).toBe("https://git.example/git/ns/ws-w1.git");
  expect(first.target.ref).toBe("refs/heads/hns/run/run-1");
  expect(first.target.token).toMatch(/^art_v2_x_/u);
  // The token's deadline is the TTL, not the repository's default day.
  expect(first.target.expiresAt).toBe("2026-01-01T00:15:00.000Z");
  expect(MIRROR_TOKEN_TTL_SECONDS).toBe(900);

  const second = await repos.target({
    repo: artifactsRepoName("w1"),
    ref: "refs/heads/hns/run/run-2",
    now: repos.now(),
  });
  expect(second.ok).toBe(true);
  // Still one create: the second target is a createToken on the repository the first made, so
  // the fake issued exactly one token per target after the creation's own.
  expect(binding.creates).toHaveLength(1);
  expect(binding.tokens).toHaveLength(3);
  if (second.ok) expect(second.target.token).not.toBe(first.target.token);
});

// Catches: a binding failure rounded to a success (a target for a repository that does not exist),
// or a failure word outside the contract's closed set.
test("a binding that fails yields a closed failure and no target", async () => {
  const binding = fakeArtifactsBinding();
  binding.failNextCreate(artifactError("UPSTREAM_UNAVAILABLE"));
  const repos = new ArtifactsRepos(binding);
  const failed = await repos.target({
    repo: artifactsRepoName("w1"),
    ref: "refs/heads/hns/run/run-1",
    now: repos.now(),
  });
  expect(failed).toStrictEqual({ ok: false, failure: "network" });
  for (const code of ["NOT_FOUND", "UPSTREAM_UNAVAILABLE", "REMOTE_AUTH_REQUIRED", "SOMETHING"]) {
    expect(MIRROR_FAILURES).toContain(failureOfBinding(artifactError(code)));
  }
  expect(failureOfBinding(new Error("boom"))).toBe("unknown");
});

// Catches: a create that raced another create being reported as a failure, so the loser of a race
// would leave the workspace without a mirror.
test("a create that races another one adopts the repository it lost the race to", async () => {
  const binding = fakeArtifactsBinding();
  binding.raceNextCreate();
  const repos = new ArtifactsRepos(binding);
  const raced = await repos.ensure(artifactsRepoName("w1"));
  expect(raced).toStrictEqual({
    ok: true,
    name: "ws-w1",
    remote: "https://git.example/git/ns/ws-w1.git",
    created: false,
  });
});

// Catches: a read-back that answers `true` for a ref at another commit, or for a repository the
// binding cannot read. A failure is never a mirrored run.
test("the ref is confirmed only when its log starts at the commit", async () => {
  const binding = fakeArtifactsBinding();
  const repos = new ArtifactsRepos(binding);
  const name = artifactsRepoName("w1");
  expect(
    await repos.holds({ repo: name, ref: "refs/heads/hns/run/run-1", commit: "a".repeat(40) }),
  ).toBe(false);
  await repos.ensure(name);
  binding.push(name, "refs/heads/hns/run/run-1", "a".repeat(40));
  expect(
    await repos.holds({ repo: name, ref: "refs/heads/hns/run/run-1", commit: "a".repeat(40) }),
  ).toBe(true);
  expect(
    await repos.holds({ repo: name, ref: "refs/heads/hns/run/run-1", commit: "b".repeat(40) }),
  ).toBe(false);
  expect(
    await repos.holds({ repo: name, ref: "refs/heads/hns/run/run-2", commit: "a".repeat(40) }),
  ).toBe(false);
  binding.failNextLog(artifactError("UPSTREAM_UNAVAILABLE"));
  expect(
    await repos.holds({ repo: name, ref: "refs/heads/hns/run/run-1", commit: "a".repeat(40) }),
  ).toBe(false);
});

// Catches: a second copy of Artifacts' limits in this module, drifting from the checkpoint
// contract's 32 MiB / 64 MiB.
test("the mirror's limits are the contract's", () => {
  expect(ARTIFACTS_REMOTE_LIMITS.maxBlobBytes).toBe(ARTIFACTS_MAX_BLOB_BYTES);
  expect(ARTIFACTS_REMOTE_LIMITS.packBytes).toBe(MAX_CHECKPOINT_PACK_BYTES);
  expect(ARTIFACTS_MAX_BLOB_BYTES).toBe(32 * 1024 * 1024);
  expect(MAX_CHECKPOINT_PACK_BYTES).toBe(64 * 1024 * 1024);
});
