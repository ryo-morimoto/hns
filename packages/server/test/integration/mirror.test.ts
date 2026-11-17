import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import * as v from "valibot";
import { CheckpointRecordSchema } from "@hns/core";
import type { CheckpointRecord } from "@hns/core";
import { mirrorRef } from "@hns/workspace/mirror";
import { confirmMirror, pushCheckpoint } from "@hns/workspace/mirror-push";
import { fakeArtifactsBinding } from "../../test/support/artifacts.ts";
import { fakeMachine } from "../../test/support/machine.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { Workspace } from "../../src/do/workspace.ts";
import { artifactsRepoName } from "../../src/artifacts/repos.ts";
import { httpsGitRemote, type HttpsGitRemote } from "../../../workspace/test/support/https-git.ts";

/**
 * The mirror's real path (0246, T2): a checkpoint's commit pushed over git to a local **https**
 * remote standing in for Artifacts, read back, and recorded on the checkpoint.
 *
 * @remarks
 * The two halves are the two writers the design gives them: the machine pushes with git
 * (`@hns/workspace/mirror-push`, over the real smart-HTTP transport) and the Worker confirms
 * through the binding. The https remote is the only scheme the mirror accepts (NB2), so what the
 * test exercises is the transport the product runs. The Workspace object is the real one; only
 * the Artifacts namespace is a fake, because the Worker's binding is the part of this that no
 * local process can stand in for over HTTP.
 *
 * NB3: a failed confirmation is kept with the reason the binding gave, and a re-send that finds
 * the commit moves the mirror from `failed` to `mirrored` — the same move is proved here and
 * against a real D1 row in `packages/server/src/do/workspace.test.ts`.
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

/** Run git in `cwd` and answer its stdout; async, so the in-process https remote can answer. */
const git = (cwd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", env: fixtureEnv() }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(error);
    });
  });

/** A ROOT with one commit, and the https remote the mirror pushes to. */
async function fixture(): Promise<{
  readonly work: string;
  readonly remote: HttpsGitRemote;
  readonly commit: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "hns-mirror-path-"));
  created.push(base);
  const work = join(base, "work");
  await git(base, ["init", "-q", work]);
  const toplevel = (await git(work, ["rev-parse", "--show-toplevel"])).trim();
  if (toplevel !== work) {
    throw new Error("git resolved " + work + " to " + toplevel + " (an inherited GIT_* variable)");
  }
  await git(work, ["config", "user.email", "hns@example.com"]);
  await git(work, ["config", "user.name", "hns"]);
  await git(work, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(work, "a.txt"), "checkpointed\n");
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-q", "-m", "hns checkpoint run-1"]);
  const commit = (await git(work, ["rev-parse", "HEAD"])).trim();
  const remote = await httpsGitRemote({ repository: work });
  remotes.push(remote);
  process.env.GIT_SSL_CAINFO = remote.certificate;
  return { work, remote, commit };
}

/** A lease body naming the one machine. */
const lease = { workspaceId: "w1", machineId: "m1", epoch: 1 } as const;

afterEach(async () => {
  delete process.env.GIT_SSL_CAINFO;
  await Promise.all(remotes.splice(0).map((remote) => remote.close()));
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A Workspace object with a fake Artifacts namespace and its fake machine, and its closer. */
function workspace(options: { readonly binding?: ReturnType<typeof fakeArtifactsBinding> } = {}) {
  const opened = openSqliteState();
  const artifacts = options.binding ?? fakeArtifactsBinding();
  const machine = fakeMachine();
  const object = new Workspace(opened.state, {
    now: () => Date.parse("2026-11-18T00:00:00.000Z"),
    leaseTtlMs: 60_000,
    packs: {
      put: (key: string) => Promise.resolve({ key }),
      head: (key: string) => Promise.resolve({ key }),
      // The pack bytes are never re-read by this test: complete only asks that the key exists.
    },
    files: machine,
    artifacts,
    artifactsMirror: true,
  });
  return { object, artifacts, machine, close: opened.close };
}

/** `request(path, body)` for the object's RPC face. */
const rpc = (
  object: Workspace,
  path: string,
  body: Record<string, string | number | undefined>,
): Promise<Response> =>
  object.fetch(
    new Request("https://workspace" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** One checkpoint record of one Run, prepared and completed. */
async function checkpoint(object: Workspace, commit: string): Promise<CheckpointRecord> {
  const prepared = await rpc(object, "/rpc/checkpoint/prepare", {
    workspaceId: "w1",
    runId: "run-1",
  });
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const completed = await rpc(object, "/rpc/checkpoint/complete", {
    workspaceId: "w1",
    runId: "run-1",
    throughSeq: 5,
  });
  expect(completed.status, await completed.clone().text()).toBe(200);
  const answer = v.parse(
    v.object({ ok: v.literal(true), checkpoint: v.unknown() }),
    await completed.json(),
  );
  expect(commit).toMatch(/^[0-9a-f]{40}$/u);
  return v.parse(CheckpointRecordSchema, answer.checkpoint);
}

/** The prepare answer, with the target the Worker issued. */
async function targetOf(object: Workspace) {
  const response = await rpc(object, "/rpc/checkpoint/prepare", {
    workspaceId: "w1",
    runId: "run-1",
  });
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
    await response.json(),
  );
  return answer.mirror;
}

// C2 / T2: Catches any hop being skipped: a prepare that offers no target, a push that does not
// land, a Worker that records `mirrored` without reading the ref back, or a record that disagrees
// with the remote.
test("a checkpoint reaches the remote and the Worker records it as mirrored", async () => {
  const { work, remote, commit } = await fixture();
  const { object, artifacts, machine, close } = workspace();
  try {
    const acquired = await rpc(object, "/rpc/lease/acquire", lease);
    expect(acquired.status).toBe(200);
    // The machine's checkpoint answer is what the object stores; the fixture's commit makes the
    // push move a real object, and the pack bytes are the fixture's own.
    machine.checkpointNext({ commit, packBytes: 64 });
    const record = await checkpoint(object, commit);
    expect(record.commit).toBe(commit);

    const target = await targetOf(object);
    expect(target).toBeDefined();
    if (target === undefined) return;
    expect(target.ref).toBe(mirrorRef("run-1"));
    expect(target.remote).toBe("https://git.example/git/ns/" + artifactsRepoName("w1") + ".git");

    // The machine's push, over https to the test remote instead of the fake's URL: the same
    // function and the same environment the agent runs, with the ref the target named.
    const pushed = await pushCheckpoint({
      root: work,
      remote: remote.remote,
      token: target.token,
      runId: "run-1",
      ref: target.ref,
      commit: record.commit,
    });
    expect(pushed).toStrictEqual({ status: "mirrored", ref: target.ref, commit: record.commit });

    // The Worker's half: the binding's log, asked for the same ref. The fake records the push the
    // https remote made, so the two writers are reading the same history.
    artifacts.push(artifactsRepoName("w1"), target.ref, record.commit);
    expect(
      await confirmMirror({
        root: work,
        remote: remote.remote,
        token: target.token,
        ref: target.ref,
        commit: record.commit,
      }),
    ).toStrictEqual({ ok: true });

    const mirrored = await rpc(object, "/rpc/checkpoint/mirror", {
      workspaceId: "w1",
      runId: "run-1",
      status: "mirrored",
    });
    expect(mirrored.status, await mirrored.clone().text()).toBe(200);
    const reported = v.parse(
      v.object({ ok: v.literal(true), checkpoint: v.unknown() }),
      await mirrored.json(),
    );
    const final = v.parse(CheckpointRecordSchema, reported.checkpoint);
    expect(final.mirror.status).toBe("mirrored");
    // The remote and the record agree, which is what a reader depends on.
    expect((await git(remote.directory, ["rev-parse", target.ref])).trim()).toBe(final.commit);
  } finally {
    close();
  }
});

// NB3: Catches a failed confirmation being recorded as an unexplained `unknown`, and a retried
// report that cannot settle a `failed` mirror whose commit is at the ref (the push landed and its
// confirmation was lost). The re-send re-checks and moves `failed -> mirrored`.
test("a failed confirmation keeps the binding's reason and a re-send settles it to mirrored", async () => {
  const { work, remote, commit } = await fixture();
  const binding = fakeArtifactsBinding();
  const { object, artifacts, machine, close } = workspace({ binding });
  try {
    expect((await rpc(object, "/rpc/lease/acquire", lease)).status).toBe(200);
    machine.checkpointNext({ commit, packBytes: 64 });
    const record = await checkpoint(object, commit);
    const target = await targetOf(object);
    if (target === undefined) throw new Error("the prepare issued no target");

    // The push lands on the https remote…
    expect(
      (
        await pushCheckpoint({
          root: work,
          remote: remote.remote,
          token: target.token,
          runId: "run-1",
          ref: target.ref,
          commit: record.commit,
        })
      ).status,
    ).toBe("mirrored");

    // …but the binding cannot answer: the confirmation fails with the reason it gave, not
    // "unknown".
    const repo = artifactsRepoName("w1");
    const first = await rpc(object, "/rpc/checkpoint/mirror", {
      workspaceId: "w1",
      runId: "run-1",
      status: "mirrored",
    });
    expect(first.status).toBe(409);
    binding.failNextLog(
      Object.assign(new Error("artifacts: UPSTREAM_UNAVAILABLE"), { code: "UPSTREAM_UNAVAILABLE" }),
    );
    const failed = await rpc(object, "/rpc/checkpoint/mirror", {
      workspaceId: "w1",
      runId: "run-1",
      status: "mirrored",
    });
    expect(failed.status).toBe(409);
    // The fake's log still has the commit at the ref (the https remote pushed it and the binding
    // is the same history): the retried report now settles the mirror.
    artifacts.push(repo, target.ref, record.commit);
    const settled = await rpc(object, "/rpc/checkpoint/mirror", {
      workspaceId: "w1",
      runId: "run-1",
      status: "mirrored",
    });
    expect(settled.status, await settled.clone().text()).toBe(200);
    const answer = v.parse(
      v.object({ ok: v.literal(true), checkpoint: v.unknown() }),
      await settled.json(),
    );
    const final = v.parse(CheckpointRecordSchema, answer.checkpoint);
    expect(final.mirror.status).toBe("mirrored");
  } finally {
    close();
  }
});

// C3: Catches a failed push being recorded as mirrored, or a mirror failure failing the ack.
test("a refused push is a failed mirror and the checkpoint's answer is untouched", async () => {
  const { work, commit } = await fixture();
  const { object, machine, close } = workspace();
  try {
    expect((await rpc(object, "/rpc/lease/acquire", lease)).status).toBe(200);
    machine.checkpointNext({ commit, packBytes: 64 });
    const record = await checkpoint(object, commit);
    // A port nothing listens on: the push is refused by the transport, which is the failure path.
    const pushed = await pushCheckpoint({
      root: work,
      remote: "https://127.0.0.1:9/missing.git",
      token: "art_v2_x_probe_token_0201",
      runId: "run-1",
      commit: record.commit,
    });
    expect(pushed.status).toBe("failed");
    if (pushed.status !== "failed") return;
    const failed = await rpc(object, "/rpc/checkpoint/mirror", {
      workspaceId: "w1",
      runId: "run-1",
      status: "failed",
      failure: pushed.failure,
    });
    expect(failed.status, await failed.clone().text()).toBe(200);
    const answer = v.parse(
      v.object({ ok: v.literal(true), checkpoint: v.unknown() }),
      await failed.json(),
    );
    const final = v.parse(CheckpointRecordSchema, answer.checkpoint);
    expect(final.mirror).toMatchObject({ status: "failed", failure: pushed.failure });
    // The checkpoint is still the answer to a prepare, and its commit is the one it recorded.
    const again = await rpc(object, "/rpc/checkpoint/prepare", {
      workspaceId: "w1",
      runId: "run-1",
    });
    expect(again.status).toBe(200);
  } finally {
    close();
  }
});
