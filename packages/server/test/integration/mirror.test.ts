import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import * as v from "valibot";
import { CheckpointRecordSchema, MAX_CHECKPOINT_PACK_BYTES } from "@hns/core";
import type { CheckpointRecord } from "@hns/core";
import { mirrorRef } from "@hns/workspace/mirror";
import { confirmMirror, pushCheckpoint } from "@hns/workspace/mirror-push";
import { fakeArtifactsBinding } from "../../test/support/artifacts.ts";
import { fakeMachine } from "../../test/support/machine.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { Workspace } from "../../src/do/workspace.ts";
import { artifactsRepoName } from "../../src/artifacts/repos.ts";

/**
 * The mirror's real path (0246, T2): a checkpoint's commit pushed over git to a local bare
 * repository standing in for an Artifacts remote, read back, and recorded on the checkpoint.
 *
 * @remarks
 * The two halves are the two writers the design gives them: the machine pushes with git
 * (`@hns/workspace/mirror-push`) and the Worker confirms through the binding. A local bare
 * repository is the remote; its refs are the ground truth a test can read with a second git.
 * The Workspace object is the real one; only the Artifacts namespace is a fake, because the
 * Worker's binding is the part of this that no local process can stand in for over HTTP.
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

/** A ROOT with one commit, and the bare repository the mirror pushes to. */
async function fixture(): Promise<{
  readonly work: string;
  readonly remote: string;
  readonly commit: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "hns-mirror-path-"));
  created.push(base);
  const work = join(base, "work");
  const remote = join(base, "remote.git");
  git(base, ["init", "-q", work]);
  const toplevel = git(work, ["rev-parse", "--show-toplevel"]).trim();
  if (toplevel !== work) {
    throw new Error("git resolved " + work + " to " + toplevel + " (an inherited GIT_* variable)");
  }
  git(work, ["config", "user.email", "hns@example.com"]);
  git(work, ["config", "user.name", "hns"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(work, "a.txt"), "checkpointed\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "hns checkpoint run-1"]);
  const commit = git(work, ["rev-parse", "HEAD"]).trim();
  await mkdir(remote);
  git(base, ["init", "-q", "--bare", remote]);
  return { work, remote, commit };
}

/** A lease body naming the one machine. */
const lease = JSON.stringify({ workspaceId: "w1", machineId: "m1", epoch: 1 });

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A Workspace object with a fake Artifacts namespace and its fake machine, and its closer. */
function workspace() {
  const opened = openSqliteState();
  const artifacts = fakeArtifactsBinding();
  const machine = fakeMachine();
  const object = new Workspace(opened.state, {
    now: () => Date.parse("2026-11-18T00:00:00.000Z"),
    leaseTtlMs: 60_000,
    packs: {
      put: (key: string) => Promise.resolve({ key }),
      head: (key: string) => Promise.resolve<{ readonly key: string } | null>({ key }),
      // The pack bytes are never re-read by this test: complete only asks that the key exists.
    },
    files: machine,
    artifacts,
    artifactsMirror: true,
  });
  return { object, artifacts, machine, close: opened.close };
}

/** One checkpoint record of one Run, prepared and completed. */
async function checkpoint(object: Workspace, commit: string): Promise<CheckpointRecord> {
  const prepared = await object.fetch(
    new Request("https://workspace/rpc/checkpoint/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "w1", runId: "run-1" }),
    }),
  );
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const completed = await object.fetch(
    new Request("https://workspace/rpc/checkpoint/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "w1", runId: "run-1", throughSeq: 5 }),
    }),
  );
  expect(completed.status, await completed.clone().text()).toBe(200);
  const answer = v.parse(
    v.object({ ok: v.literal(true), checkpoint: v.unknown() }),
    await completed.json(),
  );
  expect(commit).toMatch(/^[0-9a-f]{40}$/u);
  return v.parse(CheckpointRecordSchema, answer.checkpoint);
}

// C2 / T2: Catches any hop being skipped: a prepare that offers no target, a push that does not
// land, a Worker that records `mirrored` without reading the ref back, or a record that disagrees
// with the remote.
test("a checkpoint reaches the remote and the Worker records it as mirrored", async () => {
  const { work, remote, commit } = await fixture();
  const { object, artifacts, machine, close } = workspace();
  try {
    const acquired = await object.fetch(
      new Request("https://workspace/rpc/lease/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: lease,
      }),
    );
    expect(acquired.status).toBe(200);
    // The machine's checkpoint answer is what the object stores; the fixture's commit makes the
    // push move a real object, and the pack bytes are the fixture's own.
    machine.checkpointNext({ commit, packBytes: 64 });
    const record = await checkpoint(object, commit);
    expect(record.commit).toBe(commit);

    // The prepare's target, as the object answered it.
    const prepared = await object.fetch(
      new Request("https://workspace/rpc/checkpoint/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "w1", runId: "run-1" }),
      }),
    );
    const answer = v.parse(
      v.object({
        ok: v.literal(true),
        checkpoint: v.unknown(),
        watermark: v.number(),
        mirror: v.optional(
          v.object({
            remote: v.string(),
            token: v.string(),
            ref: v.string(),
            expiresAt: v.string(),
          }),
        ),
      }),
      await prepared.json(),
    );
    expect(answer.mirror).toBeDefined();
    const target = answer.mirror;
    if (target === undefined) return;
    expect(target.ref).toBe(mirrorRef("run-1"));
    expect(target.remote).toBe("https://git.example/git/ns/" + artifactsRepoName("w1") + ".git");

    // The machine's push, against the bare repository instead of the fake's remote: the same
    // function and the same environment the agent runs, with the ref the target named.
    const pushed = await pushCheckpoint({
      root: work,
      remote,
      token: target.token,
      runId: "run-1",
      ref: target.ref,
      commit: record.commit,
    });
    expect(pushed).toStrictEqual({ status: "mirrored", ref: target.ref, commit: record.commit });

    // The Worker's half: the binding's log, asked for the same ref. The fake records the push the
    // bare repository made, so the two writers are reading the same history.
    artifacts.push(artifactsRepoName("w1"), target.ref, record.commit);
    expect(
      await confirmMirror({
        root: work,
        remote,
        token: target.token,
        ref: target.ref,
        commit: record.commit,
      }),
    ).toStrictEqual({ ok: true });

    const mirrored = await object.fetch(
      new Request("https://workspace/rpc/checkpoint/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "w1", runId: "run-1", status: "mirrored" }),
      }),
    );
    expect(mirrored.status, await mirrored.clone().text()).toBe(200);
    const reported = v.parse(
      v.object({ ok: v.literal(true), checkpoint: v.unknown() }),
      await mirrored.json(),
    );
    const final = v.parse(CheckpointRecordSchema, reported.checkpoint);
    expect(final.mirror.status).toBe("mirrored");
    // The remote and the record agree, which is what a reader depends on.
    expect(git(remote, ["rev-parse", target.ref]).trim()).toBe(final.commit);
  } finally {
    close();
  }
});

// C3: Catches a failed push being recorded as mirrored, or a mirror failure failing the ack.
test("a refused push is a failed mirror and the checkpoint's answer is untouched", async () => {
  const { work, remote, commit } = await fixture();
  const { object, machine, close } = workspace();
  try {
    const acquired = await object.fetch(
      new Request("https://workspace/rpc/lease/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: lease,
      }),
    );
    expect(acquired.status).toBe(200);
    machine.checkpointNext({ commit, packBytes: 64 });
    const record = await checkpoint(object, commit);
    // A remote that does not exist: the push is refused by git, which is the failure path.
    const pushed = await pushCheckpoint({
      root: work,
      remote: join(remote, "..", "missing.git"),
      token: "art_v2_x_probe_token_0201",
      runId: "run-1",
      commit: record.commit,
    });
    expect(pushed.status).toBe("failed");
    if (pushed.status !== "failed") return;
    const failed = await object.fetch(
      new Request("https://workspace/rpc/checkpoint/mirror", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "w1",
          runId: "run-1",
          status: "failed",
          failure: pushed.failure,
        }),
      }),
    );
    expect(failed.status, await failed.clone().text()).toBe(200);
    const answer = v.parse(
      v.object({ ok: v.literal(true), checkpoint: v.unknown() }),
      await failed.json(),
    );
    const final = v.parse(CheckpointRecordSchema, answer.checkpoint);
    expect(final.mirror).toMatchObject({ status: "failed", failure: pushed.failure });
    // The checkpoint is still the answer to a prepare, and its commit is the one it recorded.
    const again = await object.fetch(
      new Request("https://workspace/rpc/checkpoint/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "w1", runId: "run-1" }),
      }),
    );
    expect(again.status).toBe(200);
    expect(git(remote, ["for-each-ref", "refs/heads"]).trim()).toBe("");
    expect(MAX_CHECKPOINT_PACK_BYTES).toBe(64 * 1024 * 1024);
  } finally {
    close();
  }
});
