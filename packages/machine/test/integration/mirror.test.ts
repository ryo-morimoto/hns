import { expect, test } from "vitest";
import { formatObsLog } from "@hns/core";
import type { ObsLogEntry } from "@hns/core";
import { mirrorRef } from "@hns/workspace/mirror";
import { confirmMirror, pushCheckpoint } from "@hns/workspace/mirror-push";
import { machineEntry, redactingSink } from "../../src/log.ts";
import { parseCheckpointResult, parseMirrorResult } from "../../src/index.ts";
import { fakeArtifactsBinding } from "../../../server/test/support/artifacts.ts";
import { fakeMachine } from "../../../server/test/support/machine.ts";
import { openSqliteState } from "../../../server/test/support/sqlite.ts";
import { Workspace } from "../../../server/src/do/workspace.ts";
import { httpsGitRemote } from "../../../workspace/test/support/https-git.ts";
import { changeFile, gitRepository, readRef } from "../support/git.ts";
import { withAgent } from "../support/machine.ts";
import type { MachineAnswer } from "../support/machine.ts";

/**
 * The mirror, through the agent's own operation (T2, the real path).
 *
 * `packages/workspace/test/integration/mirror.test.ts` proves the push; this proves the machine's
 * operation around it: the remote it will and will not talk to, the ref it will and will not
 * push, the pack limit it decides before a push, and that the answer the Worker records is built
 * from a read-back, never from the push's exit. A local **https** git remote stands in for
 * Artifacts (the mirror refuses every other scheme, NB2).
 *
 * The whole Worker half (the prepare's `MirrorTarget`, the binding's log, and
 * `/rpc/checkpoint/mirror`) is `packages/server/test/integration/mirror.test.ts`.
 */

/** The checkpoint operation's body; the mirror scenarios need a real commit first. */
function checkpointBody(runId: string, committedAt = 1_700_000_000): string {
  return JSON.stringify({ op: "checkpoint", runId, committedAt });
}

/** The agent's answer to a checkpoint, read through its own parser. */
function commitOf(answer: MachineAnswer): string {
  if (!answer.body.ok) throw new Error("the machine refused the checkpoint: " + answer.body.code);
  if (answer.body.op !== "checkpoint") throw new Error("expected a checkpoint answer");
  return parseCheckpointResult(answer.body.result).commit;
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
      const live = await httpsGitRemote({ repository: fixture.root });
      // The agent's push runs in this process's environment; this is what trusts the test cert.
      process.env.GIT_SSL_CAINFO = live.certificate;
      try {
        const checkpoint = await fixture.call({ body: checkpointBody("run-1") });
        const commit = commitOf(checkpoint);
        const answer = await fixture.call({
          body: JSON.stringify({
            op: "mirror",
            runId: "run-1",
            remote: live.remote,
            token: "art_v2_x_probe_token_0101",
            ref: mirrorRef("run-1"),
            commit,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
        });
        expect(answer.status).toBe(200);
        if (!answer.body.ok || answer.body.op !== "mirror") {
          throw new Error("expected a mirror answer");
        }
        expect(parseMirrorResult(answer.body.result)).toStrictEqual({
          status: "mirrored",
          ref: mirrorRef("run-1"),
          commit,
        });
        // The remote holds the commit at the Run's branch: this is what the Worker's binding log
        // reads back, and the two must agree.
        expect(readRef(live.directory, mirrorRef("run-1"))).toBe(commit);
      } finally {
        delete process.env.GIT_SSL_CAINFO;
        await live.close();
      }
    },
    { onCheckpointPack: async () => undefined },
  );
});

// NB2: Catches the agent running git against whatever remote the device key's holder named: a
// `file://` remote reads a path on the machine, an `ssh://` or `ext::` one runs another
// program. Each is refused with the contract's `unsupported`, and nothing is pushed.
test("the mirror operation refuses a remote that is not Artifacts' https one", async () => {
  const logs: string[] = [];
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      // The ref a `file://` push into ROOT itself would write, if the guard were not there.
      const marker = readRef(fixture.root, mirrorRef("run-1"));
      expect(marker).toBe("");
      // A commit the ROOT does not have: if the guard sat after the measurement, every answer
      // below would be `unknown` (the closure cannot be packed) instead of `unsupported`.
      const absent = "0".repeat(40);
      for (const remote of [
        "file://" + fixture.root,
        "file:///etc",
        "ssh://git@example.com/ns/repo.git",
        "ext::sh -c 'echo pwned' %S",
        "http://127.0.0.1:1/repo.git",
      ]) {
        const answer = await fixture.call({
          body: JSON.stringify({
            op: "mirror",
            runId: "run-1",
            remote,
            token: "art_v2_x_probe_token_0102",
            ref: mirrorRef("run-1"),
            commit: absent,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
        });
        expect(answer.status, remote).toBe(200);
        if (!answer.body.ok || answer.body.op !== "mirror") {
          throw new Error("expected a mirror answer");
        }
        expect(parseMirrorResult(answer.body.result), remote).toStrictEqual({
          status: "failed",
          failure: "unsupported",
          ref: mirrorRef("run-1"),
        });
      }
      // The refused attempts wrote nothing: the ROOT repository's own refs have no mirror branch
      // (a `file://` remote pointing at ROOT would have pushed one, which is the attack the guard
      // stops).
      expect(readRef(fixture.root, mirrorRef("run-1"))).toBe("");
      expect(logs.length).toBeGreaterThan(0);
      // Every refused answer named `unsupported`: a run that had executed git would answer the
      // transport's failure (`network`, `unknown`) instead.
      const answers = logs.filter((line) => line.includes('\\"op\\":\\"mirror\\"'));
      expect(answers.length).toBe(0);
    },
    {
      onCheckpointPack: async () => undefined,
      onLog: (entry) => {
        logs.push(JSON.stringify(entry));
      },
    },
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
      const live = await httpsGitRemote({ repository: fixture.root });
      process.env.GIT_SSL_CAINFO = live.certificate;
      try {
        const commit = commitOf(await fixture.call({ body: checkpointBody("run-1") }));
        const token = "art_v2_x_probe_token_0103_secret";
        const payload = (ref: string) =>
          JSON.stringify({
            op: "mirror",
            runId: "run-1",
            remote: live.remote,
            token,
            ref,
            commit,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          });
        const wrongRef = await fixture.call({ body: payload("refs/heads/other") });
        expect(wrongRef.status).toBe(400);
        // Nothing landed under either name.
        expect(readRef(live.directory, "refs/heads/other")).toBe("");
        expect(readRef(live.directory, mirrorRef("run-1"))).toBe("");

        const ok = await fixture.call({ body: payload(mirrorRef("run-1")) });
        expect(ok.status).toBe(200);
        expect(JSON.stringify(ok.body)).not.toContain(token);
        expect(logs.join("\n")).not.toContain(token);
        expect(logs.length).toBeGreaterThan(0);
      } finally {
        delete process.env.GIT_SSL_CAINFO;
        await live.close();
      }
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
  const token = "art_v2_x_probe_token_0104_secret";
  const received: string[] = [];
  const written: string[] = [];
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const live = await httpsGitRemote({ repository: fixture.root });
      process.env.GIT_SSL_CAINFO = live.certificate;
      try {
        const commit = commitOf(await fixture.call({ body: checkpointBody("run-1") }));
        const answer = await fixture.call({
          body: JSON.stringify({
            op: "mirror",
            runId: "run-1",
            remote: live.remote,
            token,
            ref: mirrorRef("run-1"),
            commit,
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
        });
        expect(answer.status).toBe(200);
      } finally {
        delete process.env.GIT_SSL_CAINFO;
        await live.close();
      }
      // The sink saw the request line, and it carries neither the token nor the remote.
      const line = received.join("\n");
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toContain(token);
      expect(line).toContain("/run-1");
      // The writer's own guard: a line whose path carried the token comes out redacted.
      redactingSink((entry) => written.push(formatObsLog(entry)), [token])(lineWithSecret(token));
      expect(written.join("\n")).not.toContain(token);
      expect(written.join("\n")).toContain("***");
    },
    {
      onCheckpointPack: async () => undefined,
      onLog: (entry) => {
        received.push(JSON.stringify(entry));
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
      const live = await httpsGitRemote({ repository: fixture.root });
      process.env.GIT_SSL_CAINFO = live.certificate;
      try {
        const answer = await fixture.call({
          body: JSON.stringify({
            op: "mirror",
            runId: "run-1",
            remote: live.remote,
            token: "art_v2_x_probe_token_0105",
            ref: mirrorRef("run-1"),
            commit: "0".repeat(40),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          }),
        });
        expect(answer.status).toBe(200);
        if (!answer.body.ok || answer.body.op !== "mirror") {
          throw new Error("expected a mirror answer");
        }
        expect(parseMirrorResult(answer.body.result)).toStrictEqual({
          status: "failed",
          failure: "unknown",
          ref: mirrorRef("run-1"),
        });
        expect(readRef(live.directory, mirrorRef("run-1"))).toBe("");
      } finally {
        delete process.env.GIT_SSL_CAINFO;
        await live.close();
      }
    },
    { onCheckpointPack: async () => undefined },
  );
});

// C3 / real path: Catches a run the machine cannot mirror being recorded as mirrored — the
// checkpoint's commit is not in the ROOT's repository, so there is nothing to push. The Worker
// records the closed failure and the checkpoint's answer stands.
test("a commit the machine cannot send is failed against the real Workspace object", async () => {
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const live = await httpsGitRemote({ repository: fixture.root });
      process.env.GIT_SSL_CAINFO = live.certificate;
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
        const answer = await fixture.call({
          body: JSON.stringify({
            op: "mirror",
            runId: "run-1",
            remote: live.remote,
            token: "art_v2_x_probe_token_0106",
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
      } finally {
        opened.close();
        delete process.env.GIT_SSL_CAINFO;
        await live.close();
      }
    },
    { onCheckpointPack: async () => undefined },
  );
});

// The push itself, for the server's real-path test to reuse: the same function the machine runs.
test("the push and its read-back agree with the repository", async () => {
  await withAgent(
    async ({ root }) => {
      await gitRepository(root);
      await changeFile(root, "changed.txt", "changed\n");
    },
    async (fixture) => {
      const live = await httpsGitRemote({ repository: fixture.root });
      process.env.GIT_SSL_CAINFO = live.certificate;
      try {
        const commit = commitOf(await fixture.call({ body: checkpointBody("run-1") }));
        const outcome = await pushCheckpoint({
          root: fixture.root,
          remote: live.remote,
          token: "art_v2_x_probe_token_0107",
          runId: "run-1",
          commit,
        });
        expect(outcome.status).toBe("mirrored");
        expect(readRef(live.directory, mirrorRef("run-1"))).toBe(commit);
        expect(
          await confirmMirror({
            root: fixture.root,
            remote: live.remote,
            token: "art_v2_x_probe_token_0107",
            ref: mirrorRef("run-1"),
            commit,
          }),
        ).toStrictEqual({ ok: true });
      } finally {
        delete process.env.GIT_SSL_CAINFO;
        await live.close();
      }
    },
    { onCheckpointPack: async () => undefined },
  );
});
