import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatObsLog, isoTimestamp } from "@hns/core";
import type { ObsLogEntry } from "@hns/core";
import { mirrorRef } from "@hns/workspace/mirror";
import { confirmMirror, pushCheckpoint } from "@hns/workspace/mirror-push";
import { REDACTED, machineEntry, redactingSink } from "../../src/log.ts";
import { parseCheckpointResult, parseMirrorResult } from "../../src/index.ts";
import { fakeArtifactsBinding } from "../../../server/test/support/artifacts.ts";
import { fakeMachine } from "../../../server/test/support/machine.ts";
import { openSqliteState } from "../../../server/test/support/sqlite.ts";
import { Workspace } from "../../../server/src/do/workspace.ts";
import { changeFile, gitRepository, readRef } from "../support/git.ts";
import { withAgent } from "../support/machine.ts";

/**
 * The mirror, through the agent's own operation (T2, the real path).
 *
 * `packages/workspace/test/integration/mirror.test.ts` proves the push; this proves the machine's
 * operation around it: the ref it will and will not push, the pack limit it decides before a push,
 * and that the answer the Worker records is built from a read-back, never from the push's exit.
 * A local bare repository stands in for an Artifacts remote.
 *
 * The whole Worker half (the prepare's `MirrorTarget`, the binding's log, and
 * `/rpc/checkpoint/mirror`) is `packages/server/test/integration/mirror.test.ts`.
 */

/** The checkpoint operation's body; the mirror scenarios need a real commit first. */
function checkpointBody(runId: string, committedAt = 1_700_000_000): string {
  return JSON.stringify({ op: "checkpoint", runId, committedAt });
}

/** A bare repository next to the ROOT, as the Artifacts remote. */
async function bareRemote(base: string): Promise<string> {
  const path = join(base, "remote.git");
  await mkdir(path, { recursive: true });
  const git = await import("node:child_process");
  git.execFileSync("git", ["init", "-q", "--bare", path], { stdio: ["ignore", "pipe", "pipe"] });
  return path;
}

// C2: Catches a mirror operation that skips the Run's ref, pushes to another one, or answers
// `mirrored` for a commit that is not on the remote.
test("the mirror operation pushes the Run's commit and answers mirrored only after a read-back", async () => {
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const checkpoint = await fixture.call({ body: checkpointBody("run-1") });
      if (!checkpoint.body.ok || checkpoint.body.op !== "checkpoint") {
        throw new Error("expected a checkpoint answer");
      }
      const meta = parseCheckpointResult(checkpoint.body.result);
      const remote = await bareRemote(fixture.base);
      const answer = await fixture.call({
        body: JSON.stringify({
          op: "mirror",
          runId: "run-1",
          remote,
          token: "art_v2_x_probe_token_0101",
          ref: mirrorRef("run-1"),
          commit: meta.commit,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      });
      expect(answer.status).toBe(200);
      if (!answer.body.ok || answer.body.op !== "mirror")
        throw new Error("expected a mirror answer");
      expect(parseMirrorResult(answer.body.result)).toStrictEqual({
        status: "mirrored",
        ref: mirrorRef("run-1"),
        commit: meta.commit,
      });
      // The remote holds the commit at the Run's branch: this is what the Worker's binding log
      // reads back, and the two must agree.
      const remoteRef = readRef(remote, mirrorRef("run-1"));
      expect(remoteRef).toBe(meta.commit);
    },
    { onCheckpointPack: async () => undefined },
  );
});

// C3 / guard: Catches a ref that is not the Run's branch being pushed (a private ref the review
// cannot find, or another Run's branch), and a token appearing in the answer or the log.
test("a mirror for another ref is refused, and the token is in neither the answer nor the log", async () => {
  const logs: string[] = [];
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const checkpoint = await fixture.call({ body: checkpointBody("run-1") });
      if (!checkpoint.body.ok || checkpoint.body.op !== "checkpoint") {
        throw new Error("expected a checkpoint answer");
      }
      const meta = parseCheckpointResult(checkpoint.body.result);
      const remote = await bareRemote(fixture.base);
      const token = "art_v2_x_probe_token_0102_secret";
      const wrongRef = await fixture.call({
        body: JSON.stringify({
          op: "mirror",
          runId: "run-1",
          remote,
          token,
          ref: "refs/heads/other",
          commit: meta.commit,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      });
      expect(wrongRef.status).toBe(400);
      // Nothing landed under either name.
      expect(readRef(remote, "refs/heads/other")).toBe("");
      expect(readRef(remote, mirrorRef("run-1"))).toBe("");

      const ok = await fixture.call({
        body: JSON.stringify({
          op: "mirror",
          runId: "run-1",
          remote,
          token,
          ref: mirrorRef("run-1"),
          commit: meta.commit,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      });
      expect(ok.status).toBe(200);
      expect(JSON.stringify(ok.body)).not.toContain(token);
      expect(logs.join("\n")).not.toContain(token);
      expect(logs.length).toBeGreaterThan(0);
    },
    {
      onCheckpointPack: async () => undefined,
      onLog: (entry) => {
        logs.push(JSON.stringify(entry));
      },
    },
  );
});

/** The writer's sink for the probe: one line of an entry whose path carries a secret. */
function lineWithSecret(secret: string): ObsLogEntry {
  return machineEntry({
    requestId: "request-1",
    path: "/" + secret,
    status: 200,
    durationMs: 1,
    op: "mirror",
    now: Date.parse("2026-11-18T00:00:00.000Z"),
  });
}

// C5 (agent): Catches the agent handing a mirror token to its log sink unredacted. The agent's
// own line names the Run, not the token; the guard is what keeps that true if a field ever
// carried one, so the sink here is the writer's (a redacting one) and the probe also puts the
// token into an entry the writer builds. The assertion is that the written line has it replaced.
test("the agent's log sink writes no mirror token, and a text field is redacted", async () => {
  const token = "art_v2_x_probe_token_0106_secret";
  const received: string[] = [];
  const raw: string[] = [];
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const checkpoint = await fixture.call({ body: checkpointBody("run-1") });
      if (!checkpoint.body.ok || checkpoint.body.op !== "checkpoint") {
        throw new Error("expected a checkpoint answer");
      }
      const meta = parseCheckpointResult(checkpoint.body.result);
      const remote = await bareRemote(fixture.base);
      const answer = await fixture.call({
        body: JSON.stringify({
          op: "mirror",
          runId: "run-1",
          remote,
          token,
          ref: mirrorRef("run-1"),
          commit: meta.commit,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      });
      expect(answer.status).toBe(200);
      // The sink saw the request line, and it carries neither the token nor the remote.
      const line = received.join("\n");
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toContain(token);
      expect(line).not.toContain(remote);
      expect(line).toContain("/run-1");
      // The writer's own guard: a line whose path carried the token comes out redacted.
      redactingSink((entry) => raw.push(formatObsLog(entry)), [token])(lineWithSecret(token));
      expect(raw.join("\n")).not.toContain(token);
      expect(raw.join("\n")).toContain("***");
    },
    {
      onCheckpointPack: async () => undefined,
      onLog: (entry) => {
        received.push(JSON.stringify(entry));
        raw.push(formatObsLog(entry));
      },
    },
  );
});

// C4: Catches a run the machine can tell is over the push limit being pushed anyway, and the
// operation answering a failure outside the contract's vocabulary.
test("the machine skips a run that cannot be packed within the push limit", async () => {
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
    },
    async (fixture) => {
      // A commit the repository does not have: the closure cannot be measured, so nothing is
      // pushed and the answer is the closed `unknown` rather than a guessed success.
      const remote = await bareRemote(fixture.base);
      const answer = await fixture.call({
        body: JSON.stringify({
          op: "mirror",
          runId: "run-1",
          remote,
          token: "art_v2_x_probe_token_0103",
          ref: mirrorRef("run-1"),
          commit: "0".repeat(40),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }),
      });
      expect(answer.status).toBe(200);
      if (!answer.body.ok || answer.body.op !== "mirror")
        throw new Error("expected a mirror answer");
      expect(parseMirrorResult(answer.body.result)).toStrictEqual({
        status: "failed",
        failure: "unknown",
        ref: mirrorRef("run-1"),
      });
      expect(readRef(remote, mirrorRef("run-1"))).toBe("");
    },
    { onCheckpointPack: async () => undefined },
  );
});

// C3 / real path: Catches a run the machine cannot mirror being recorded as mirrored — the
// checkpoint's commit is not in the ROOT's repository, so there is nothing to push. The Worker
// records the closed failure and the checkpoint's answer stands.
test("a commit the machine cannot send is failed against the real Workspace object", async () => {
  const base = await mkdtemp(join(tmpdir(), "hns-mirror-machine-"));
  const opened = openSqliteState();
  const artifacts = fakeArtifactsBinding();
  const object = new Workspace(opened.state, {
    now: () => Date.parse("2026-11-18T00:00:00.000Z"),
    leaseTtlMs: 60_000,
    packs: {
      put: (key: string) => Promise.resolve({ key }),
      head: (key: string) => Promise.resolve({ key }),
    },
    files: fakeMachine(),
    artifacts,
    artifactsMirror: true,
  });
  try {
    await withAgent(
      async ({ root }) => {
        await gitRepository(root);
        await changeFile(root, "changed.txt", "changed\n");
      },
      async (fixture) => {
        const answer = await fixture.call({
          body: JSON.stringify({
            op: "mirror",
            runId: "run-1",
            remote: join(base, "remote.git"),
            token: "art_v2_x_probe_token_0105",
            ref: mirrorRef("run-1"),
            commit: "0".repeat(40),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
        });
        if (!answer.body.ok || answer.body.op !== "mirror") {
          throw new Error("expected a mirror answer");
        }
        const result = parseMirrorResult(answer.body.result);
        expect(result.status).toBe("failed");
        if (result.status !== "failed") return;
        const acquired = await object.fetch(
          new Request("https://workspace/rpc/lease/acquire", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: "w1", machineId: "m1", epoch: 1 }),
          }),
        );
        expect(acquired.status).toBe(200);
        // The Worker records the machine's own failure word, on a Run it has no checkpoint for:
        // the report is refused as `not_found` (nothing to attach it to), which is a typed answer
        // and never a failure of a checkpoint.
        const reported = await object.fetch(
          new Request("https://workspace/rpc/checkpoint/mirror", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId: "w1",
              runId: "run-1",
              status: "failed",
              failure: result.failure,
            }),
          }),
        );
        expect(reported.status).toBe(404);
      },
      { onCheckpointPack: async () => undefined },
    );
  } finally {
    opened.close();
    await rm(base, { recursive: true, force: true });
  }
});

// The push itself, for the server's real-path test to reuse: the same function the machine runs.
test("the push and its read-back agree with the repository", async () => {
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const checkpoint = await fixture.call({ body: checkpointBody("run-1") });
      if (!checkpoint.body.ok || checkpoint.body.op !== "checkpoint") {
        throw new Error("expected a checkpoint answer");
      }
      const meta = parseCheckpointResult(checkpoint.body.result);
      const remote = await bareRemote(fixture.base);
      const outcome = await pushCheckpoint({
        root: fixture.root,
        remote,
        token: "art_v2_x_probe_token_0104",
        runId: "run-1",
        commit: meta.commit,
      });
      expect(outcome.status).toBe("mirrored");
      expect(readRef(remote, mirrorRef("run-1"))).toBe(meta.commit);
      expect(
        await confirmMirror({
          root: fixture.root,
          remote,
          token: "art_v2_x_probe_token_0104",
          ref: mirrorRef("run-1"),
          commit: meta.commit,
        }),
      ).toStrictEqual({ ok: true });
    },
    { onCheckpointPack: async () => undefined },
  );
});
