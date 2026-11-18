import { afterAll, expect, test } from "vitest";
import * as v from "valibot";
import type { JsonValue } from "@hns/core";
import { CheckpointRecordSchema, isoTimestamp } from "@hns/core";
import { mirrorRef } from "@hns/workspace/mirror";
import { pushCheckpoint } from "@hns/workspace/mirror-push";
import { changeFile, gitRepository, readRef } from "../../../machine/test/support/git.ts";
import { withAgent } from "../../../machine/test/support/machine.ts";
import { httpsGitRemote, type HttpsGitRemote } from "../../../workspace/test/support/https-git.ts";
import { trailLookupFor } from "../../../store/src/edge/trail-lookup.ts";
import { trailRepository } from "../../../store/src/repositories/trails.ts";
import type { Store } from "../../../store/src/store.ts";
import { artifactsRepoName } from "../../src/artifacts/repos.ts";
import { storeObserveFor } from "../../src/obs/store.ts";
import { createSignedMachineFiles } from "../../src/do/machine.ts";
import { Workspace, type MirrorReport } from "../../src/do/workspace.ts";
import { fakeArtifactsBinding } from "../../test/support/artifacts.ts";
import { deviceKeyFromSeed } from "../../test/support/device.ts";
import { openSqliteState, type OpenSqliteState } from "../../test/support/sqlite.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { openSession } from "@hns/agent/session";
import { Session } from "../../src/do/session.ts";

/**
 * The last three faces, through the production parts (0272n, acceptance 4).
 *
 * @remarks
 * One checkpoint of a real Run, with the parts paired as production pairs them:
 *
 * - the **machine** is `@hns/machine` real agent on a real socket; the object calls it with
 *   `createSignedMachineFiles`, so the control-plane signature and the mirror body are the
 *   production ones;
 * - the **mirror** is real git: the machine pushes with `pushCheckpoint` to a local https remote
 *   standing in for Artifacts, and the Worker confirmation is the object binding call;
 * - the **Trail** is the store real repository over real SQLite rows, through the lookup the
 *   Worker hands the object (`trailLookupFor`);
 * - the **observation** is the product chain with only the network edges in-test: the object's
 *   line, the sink `storeObserveFor` (the Session log's factory), the edge's `forwardObs` exchange
 *   run as a function here, the **product `Session` object's `/rpc/events`** (`handleObsRpc`) over
 *   real SQLite, and `/rpc/metrics` read back from it. No `cf dev` is started by this file: the
 *   suite's real-runtime route is `session-do.test.ts`, and the network between the sink and the
 *   object is the one piece this file stands in for.
 *
 * What this proves that the unit tests cannot: the pieces are joined in the order the product
 * runs them. This test's own `files.mirror` (the stand-in for the machine's push) is held until
 * the checkpoint's answer has been read, so an answer that arrives while the machine has not
 * pushed yet is the proof that the ack did not wait for the mirror; and the metric is read back
 * through the object's own log, not written into it by the test.
 */

const RUN_ID = "run-0272n";
const WORKSPACE_ID = "w1";
const MACHINE_ID = "machine-0272n";
const TRAIL_ID = "trail-0272n";
/** The Trail already holds a Change: the one this checkpoint adds is `head..C`. */
const HEAD_BEFORE = "c".repeat(40);

/**
 * A bucket in memory that answers every lookup, standing in for R2.
 *
 * @remarks
 * The checkpoint's pack upload is 0245's path, and this file is about what happens **after** the
 * ack; so the bucket already holds every key `complete` asks for. Nothing is written to it here.
 */
function packedBucket() {
  return {
    put(key: string) {
      return Promise.resolve({ key });
    },
    head(key: string) {
      return Promise.resolve({ key });
    },
  };
}

/** A request to the object /rpc face. */
function post(path: string, body: JsonValue, requestId?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (requestId !== undefined) headers.set("x-request-id", requestId);
  return new Request("https://workspace.internal" + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** The object answer, parsed at its boundary. */
async function answerOf(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(
    v.object({ ok: v.literal(true), checkpoint: v.unknown(), watermark: v.number() }),
    await response.json(),
  );
}

/** Resolve once the predicate holds; the tests poll a value, they do not sleep. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for " + label);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/** The Trail the run is linked to: one Trail, one Change already at its head. */
function seedTrail(opened: OpenSqliteState): void {
  opened.sql(
    "CREATE TABLE trails (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, priority TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  opened.sql(
    "CREATE TABLE trail_changes (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL, workspace_id TEXT NOT NULL, repo_id TEXT, base_commit TEXT NOT NULL, head_commit TEXT NOT NULL, run_id TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  opened.sql(
    "CREATE TABLE trail_sessions (id TEXT PRIMARY KEY, trail_id TEXT NOT NULL, conversation_id TEXT, session_id TEXT NOT NULL, run_id TEXT, linked_at TEXT NOT NULL)",
  );
  opened.sql(
    "INSERT INTO trails (id, project_id, title, description, acceptance, kind, state, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    TRAIL_ID,
    "default",
    "the faces",
    "",
    "",
    "feature",
    "active",
    "normal",
    "owner",
    "2026-11-17T00:00:00.000Z",
    "2026-11-17T00:00:00.000Z",
  );
  // The Change the Trail is already at: this checkpoint moves it forward.
  opened.sql(
    "INSERT INTO trail_changes (id, trail_id, workspace_id, repo_id, base_commit, head_commit, run_id, state, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)",
    "change-0",
    TRAIL_ID,
    WORKSPACE_ID,
    "a".repeat(40),
    HEAD_BEFORE,
    "open",
    "2026-11-17T00:00:00.000Z",
    "2026-11-17T00:00:00.000Z",
  );
  // The link: this Run is the Trail work (the row a person or a dispatch would write).
  opened.sql(
    "INSERT INTO trail_sessions (id, trail_id, conversation_id, session_id, run_id, linked_at) VALUES (?, ?, ?, ?, ?, ?)",
    "link-1",
    TRAIL_ID,
    RUN_ID,
    "session-1",
    RUN_ID,
    "2026-11-18T00:00:00.000Z",
  );
}

/** The Trail Changes after the checkpoint, as the store reads them. */
function changesOf(opened: OpenSqliteState) {
  return opened
    .rows(
      "SELECT base_commit, head_commit, run_id, workspace_id FROM trail_changes WHERE trail_id = ? ORDER BY created_at, id",
      TRAIL_ID,
    )
    .map((row) => ({
      base_commit: row.base_commit,
      head_commit: row.head_commit,
      run_id: row.run_id,
      workspace_id: row.workspace_id,
    }));
}

let remote: HttpsGitRemote | undefined;

afterAll(async () => {
  await remote?.close();
});
/**
 * The store's Trail repository over the test's SQLite, for the lookup the object is given.
 *
 * @remarks
 * The repository is the production one; only its SQL port is the DO-shaped adapter the test's
 * SQLite exposes, so the statements it runs are the statements the store runs in production.
 */
/**
 * The store's Trail repository over the test's SQLite, for the lookup the object is given.
 *
 * @remarks
 * The repository is the production one; only its SQL port is the DO-shaped adapter the test's
 * SQLite exposes, so the statements it runs are the statements the store runs in production.
 * A write is executed and its `RETURNING *` row is read back, as D1 answers one.
 */
function createRepository(opened: OpenSqliteState): Store["trails"] {
  return trailRepository({
    // SAFETY: the store's SQL port carries SQL and its parameters; the test's SQLite is given
    // the same values (its binding accepts them as declared), and the rows it answers are the
    // database's own.
    sql: {
      all: (text, params = []) => Promise.resolve(opened.rows(text, ...params)),
      get: (text, params = []) => Promise.resolve(opened.rows(text, ...params)[0]),
      run: (text, params = []) => {
        opened.sql(text, ...params);
        return Promise.resolve(1);
      },
      // A batch is executed one statement at a time. Only a statement with RETURNING answers
      // rows (as D1 answers one): the store's `addChange` reads the inserted row from the
      // batch's first result, and the state move it writes second answers none.
      batch: (statements) =>
        Promise.resolve(
          statements.map((statement) => {
            const returning = /\s+RETURNING\s+\*\s*$/iu.test(statement.sql);
            const params = statement.params ?? [];
            opened.sql(statement.sql, ...params);
            return returning
              ? opened.rows(statement.sql.replace(/\s+RETURNING\s+\*\s*$/iu, ""), ...params)
              : [];
          }),
        ),
      close: () => Promise.resolve(),
    },
    now: () => isoTimestamp("2026-11-18T00:00:00.000Z"),
    // One row per call: the store asks for an id each time it writes a row.
    newId: () => "change-" + crypto.randomUUID(),
  });
}

/**
 * The SESSION binding, over the **product** Session object.
 *
 * @remarks
 * The sink the Worker builds appends through `/api/events`, which in a deployment is the edge's
 * forward to the Session object (`forwardObs`). The object here is the real `Session` — its
 * `/rpc/events` route is the product's `handleObsRpc` and its SQLite the product's event table —
 * so the line the mirror writes travels the product path into the log `/api/metrics` reads.
 * Only the runtime factory is a test's (the conversation runtime needs a model and a D1, which
 * this file does not exercise); it keeps the object open with no conversations.
 */
/** One SESSION binding over the product object, registered so the edge's forward reaches it. */
function sessionBindingOf(opened: OpenSqliteState) {
  const storage = {
    ...opened.state.storage,
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };
  const object = new Session(
    { storage, blockConcurrencyWhile: opened.state.blockConcurrencyWhile, abort: () => undefined },
    { HNS_ENV: "dev" },
    // The real runtime over the object's SQLite: the observability route needs no conversation,
    // but the object opens its storage through this factory, so the factory is the product's own
    // shape (a pi-durable storage and an open session).
    async (state, _env, hooks) => {
      const storage = await openDurableObjectSqliteStorage(state.storage, {
        prefix: "hns_session",
      });
      return await openSession({
        storage,
        models: createModels(),
        registry: createRegistry(),
        model: { provider: "faux", modelId: "faux-1" },
        context: BACKGROUND_CONTEXT,
        onWake: hooks.onWake,
        onReport: hooks.onReport,
        onEvent: hooks.onEvent,
      });
    },
  );
  const id = { name: "obs" };
  return {
    idFromName: () => id,
    get: () => ({ fetch: (request: Request) => object.fetch(request) }),
  };
}

/**
 * The edge's `forwardObs`: the public path becomes the object's internal RPC path.
 *
 * @remarks
 * The same exchange `edge/worker.ts` makes for `/api/events` and `/api/metrics`: the path's
 * `/api` prefix is replaced by `/rpc`, the request is addressed to the object, and the query
 * string travels unchanged.
 *
 * @param session - The SESSION binding the Worker has.
 * @param input - The public URL the sink built.
 * @param init - The public request's init, carried unchanged.
 */
async function forwardObsLikeEdge(
  session: ReturnType<typeof sessionBindingOf>,
  input: string | URL | Request,
  init?: RequestInit,
) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const request = new Request(
    "https://session.internal/rpc" + url.pathname.replace(/^\/api/u, "") + url.search,
    init,
  );
  return await session.get().fetch(request);
}

/**
 * `/api/metrics` of the Session object, read through the product's own route.
 *
 * @remarks
 * The request is the edge's forward: the public `/api/metrics` becomes the object's
 * `/rpc/metrics`, and `handleObsRpc` answers the aggregate. The mirror section is what the
 * observation was counted into.
 */
async function callMetrics(binding: ReturnType<typeof sessionBindingOf>) {
  const response = await binding
    .get()
    .fetch(new Request("https://session.internal/rpc/metrics", { method: "GET" }));
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return v.parse(
    v.pipe(
      v.object({
        ok: v.literal(true),
        metrics: v.object({
          mirror: v.object({
            total: v.number(),
            failureRate: v.number(),
            skipRate: v.number(),
            p95Ms: v.number(),
            repos: v.number(),
            states: v.object({
              mirrored: v.number(),
              skipped: v.number(),
              failed: v.number(),
              pending: v.number(),
            }),
          }),
        }),
      }),
      v.transform((answer) => answer.metrics),
    ),
    JSON.parse(text),
  );
}

// Acceptance 4: the three faces on one real path. Catches any hop being skipped end to end: a
// checkpoint whose answer waits for the push, a Trail that gets no Change (or a Change at the
// wrong head), a mirror that never reaches the remote, and an observation that stops at the
// console instead of `/api/metrics`.
test("one checkpoint writes the Trail Change, mirrors the commit, and /api/metrics counts it", async () => {
  const opened = openSqliteState();
  const session = sessionBindingOf(opened);
  const artifacts = fakeArtifactsBinding({
    now: () => Date.parse("2026-11-18T00:00:00.000Z"),
  });
  const machineKey = await deviceKeyFromSeed(272);
  const reports: MirrorReport[] = [];
  const pushes: string[] = [];
  let releasePush: () => void = () => undefined;
  const pushHeld = new Promise<void>((resolve) => {
    releasePush = resolve;
  });
  let object: Workspace | undefined;
  let commit = "";
  try {
    await withAgent(
      async (paths) => {
        await gitRepository(paths.root);
        await changeFile(paths.root, "a.txt", "checkpointed for 0272n\n");
      },
      async (fixture) => {
        remote = await httpsGitRemote({ repository: fixture.root });
        process.env.GIT_SSL_CAINFO = remote.certificate;
        // The machine registry row (0148) and the workspace rows the two later faces write.
        opened.sql(
          "CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, public_key BLOB NOT NULL)",
        );
        opened.sql(
          "INSERT OR REPLACE INTO machines (id, public_key) VALUES (?, ?)",
          MACHINE_ID,
          new Uint8Array(machineKey.publicKey).buffer,
        );
        seedTrail(opened);
        // The production transport to the machine: the agent verifies the control-plane
        // signature the client makes, so a wrong key or a wrong body stops here.
        // The control-plane seed the Worker's secret carries: the private half of the key the
        // agent was enrolled with (the fixture's own), so the agent verifies this client's
        // signature and no other.
        const seed = v.parse(
          v.object({ d: v.pipe(v.string(), v.minLength(1)) }),
          fixture.signingKey.export({ format: "jwk" }),
        ).d;
        const files = createSignedMachineFiles({ agentUrl: fixture.origin, controlPlaneKey: seed });
        object = new Workspace(opened.state, {
          now: () => Date.parse("2026-11-18T00:00:00.000Z"),
          leaseTtlMs: 60_000,
          packs: packedBucket(),
          artifacts,
          artifactsMirror: true,
          // The machine is the production client; the mirror push is what the machine runs
          // (`pushCheckpoint`), held until the checkpoint has been answered.
          files: {
            write: (request, call) => files.write(request, call),
            read: (request, call) => files.read(request, call),
            checkpoint: (request, call) => files.checkpoint(request, call),
            mirror: async (request) => {
              pushes.push(request.runId);
              await pushHeld;
              const pushed = await pushCheckpoint({
                root: fixture.root,
                remote: remote?.remote ?? "",
                token: request.target.token,
                runId: request.runId,
                ref: request.target.ref,
                commit: request.commit,
              });
              return pushed.status === "mirrored"
                ? { ok: true, status: "mirrored", ref: pushed.ref, commit: pushed.commit }
                : { ok: true, status: "failed", failure: pushed.failure, ref: pushed.ref };
            },
          },
          // The Worker's lookup over the store: the store's own `trailLookupFor`, given an
          // opener whose store is the Trail repository over this test's SQLite (the view the
          // lookup reads: the repository and the close).
          trails: trailLookupFor(() =>
            Promise.resolve({ trails: createRepository(opened), close: () => Promise.resolve() }),
          ),
          // The sink the Worker builds, given the SESSION binding it has: the entry goes out
          // through the edge's own `/api/events`, which is the forward (`forwardObs`) to the
          // Session object's event table — the log `/api/metrics` reads back.
          observe: storeObserveFor({ SESSION: session }, (input, init) =>
            forwardObsLikeEdge(session, input, init),
          ),
          reportMirror: async (report) => {
            reports.push(report);
            if (report.status === "mirrored") {
              artifacts.push(artifactsRepoName(WORKSPACE_ID), mirrorRef(report.runId), commit);
            }
            const answer = await object?.fetch(
              post(
                "/rpc/checkpoint/mirror",
                report.failure === undefined
                  ? { workspaceId: report.workspaceId, runId: report.runId, status: report.status }
                  : {
                      workspaceId: report.workspaceId,
                      runId: report.runId,
                      status: report.status,
                      failure: report.failure,
                    },
                report.requestId ?? undefined,
              ),
            );
            expect(answer?.status, await answer?.clone().text()).toBe(200);
          },
        });
        const lease = await object.fetch(
          post("/rpc/lease/acquire", { workspaceId: WORKSPACE_ID, machineId: MACHINE_ID }),
        );
        expect(lease.status).toBe(200);
        const prepared = await object.fetch(
          post(
            "/rpc/checkpoint/prepare",
            { workspaceId: WORKSPACE_ID, runId: RUN_ID },
            "req-0272n",
          ),
        );
        const preparedBody = await answerOf(prepared);
        commit = v.parse(v.object({ commit: v.string() }), preparedBody.checkpoint).commit;
        // complete: the answer is the checkpoint, and the Change and the push follow it.
        const completed = await object.fetch(
          post(
            "/rpc/checkpoint/complete",
            { workspaceId: WORKSPACE_ID, runId: RUN_ID, throughSeq: 1 },
            "req-0272n",
          ),
        );
        const done = await answerOf(completed);
        const record = v.parse(CheckpointRecordSchema, done.checkpoint);
        // THE ACK DID NOT WAIT FOR THE PUSH: the machine has not pushed yet (the test holds it),
        // and the checkpoint is already complete and answered.
        expect(pushes).toStrictEqual([RUN_ID]);
        expect(record.mirror.status).toBe("pending");
        releasePush();
        // The push and its report run after the answer; this test waits for them to land.
        await waitFor(() => reports.length > 0, "the mirror report");
        const row = opened.rows("SELECT record FROM checkpoint_run WHERE run_id = ?", RUN_ID)[0];
        await waitFor(
          () => String(row?.record ?? "").includes('"mirrored"'),
          "the recorded mirror state",
        );
        // The Trail: one more Change, at the checkpoint head, whose base is the head before it.
        await waitFor(() => changesOf(opened).length === 2, "the Trail Change");
        expect(changesOf(opened)).toStrictEqual([
          {
            base_commit: "a".repeat(40),
            head_commit: HEAD_BEFORE,
            run_id: null,
            workspace_id: WORKSPACE_ID,
          },
          {
            base_commit: HEAD_BEFORE,
            head_commit: commit,
            run_id: RUN_ID,
            workspace_id: WORKSPACE_ID,
          },
        ]);
        // The remote really has the commit at the Run mirror branch.
        expect(readRef(remote.directory, mirrorRef(RUN_ID))).toBe(commit);
      },
      { machineId: MACHINE_ID },
    );
    // The observation: the object line, through the edge sink, to the running project; read
    // back from the product metrics route. The sink does not wait for the append, so the test
    // waits for the row to appear.
    await waitFor(
      async () => (await callMetrics(session)).mirror.total === 1,
      "the observed mirror line",
    );
    const metrics = await callMetrics(session);
    expect(metrics.mirror.total).toBe(1);
    expect(metrics.mirror.states.mirrored).toBe(1);
    expect(metrics.mirror.repos).toBe(1);
  } finally {
    delete process.env.GIT_SSL_CAINFO;
    opened.close();
  }
}, 300_000);
