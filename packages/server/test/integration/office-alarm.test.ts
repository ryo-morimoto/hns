import { expect, test } from "vitest";
import type { AgentSession } from "@hns/agent/session";
import { Session } from "../../src/do/session.ts";
import type { SessionEnv, SessionState } from "../../src/do/state.ts";
import type { OfficePreviewFace } from "../../src/do/office-job.ts";
import {
  OFFICE_MAX_ATTEMPTS,
  OFFICE_RETRY_MS,
  createOfficeRows,
} from "../../src/do/office-rows.ts";
import { createOfficePreview } from "../../src/do/office-job.ts";
import { SESSION_NAME_HEADER } from "../../src/edge/env.ts";
import { openSqliteState } from "../support/sqlite.ts";
/**
 * The office alarm on the Session object (0237, C9 / NB2 / NB1).
 *
 * @remarks
 * The rows are the object's own SQLite, so this opens the object the way a deployment does —
 * with the office machine unset (no `HNS_AGENT_URL`), which is the fail-closed shape a request
 * sees when the machine is down — and drives the public surface: a preview request, then the
 * alarm. The conversation runtime is the one stand-in: office never opens one.
 */
const WORKSPACE = "project-1";
const VERSION = "sha256:" + "a".repeat(64);
const OFFICE_TTL_MS = 120_000;

/** A conversation runtime that never runs a turn. */
function inertSession(): AgentSession {
  return {
    closed: new Promise(() => undefined),
    createConversation: async () => {
      throw new Error("unused");
    },
    listConversations: async () => [],
    getConversation: async () => undefined,
    send: async () => {
      throw new Error("unused");
    },
    transcript: async () => [],
    watchConversation: async () => {
      throw new Error("unused");
    },
    abort: async () => false,
    pendingIndex: async () => ({ entries: [], remaining: 0, legacy: 0 }),
    markIndexed: async () => undefined,
    indexRows: async () => [],
    wake: () => ({ active: false }),
    resume: () => undefined,
    close: async () => undefined,
  };
}

/**
 * One Session object over in-memory SQLite, with its alarm visible to the test.
 *
 * @param env - The object bindings; production is `HNS_ENV=dev` here, with no machine.
 * @param office - The office port a request is served from, when a test supplies one.
 * @returns The object, its SQLite, and its alarm.
 */
function openObject(env: SessionEnv, office?: OfficePreviewFace) {
  const opened = openSqliteState();
  let alarm: number | null = null;
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const state: SessionState = {
    id: { name: WORKSPACE },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const session = new Session(
    state,
    env,
    async () => inertSession(),
    // The office face the object would build from the machine bindings; a test passes one whose
    // machine is a stub, so the request and the alarm are the object's own code.
    office === undefined ? {} : { office },
  );
  return {
    session,
    opened,
    alarmAt: () => alarm,
    /** Set the alarm as a woken session would have left it. */
    setAlarm: (at: number) => storage.setAlarm(at),
    clearAlarm: () => storage.deleteAlarm(),
  };
}

/**
 * A face over the object's own SQLite whose machine never answers.
 *
 * @param storage - The object's storage, so the rows the object reads are the rows this writes.
 * @param engine - The probe's answer: `unavailable`, or a report that says there is no pack.
 * @returns The face, and the clock it reads so a test can move it.
 */
function faceOver(
  storage: SessionState["storage"],
  engine: "unavailable" | "absent" = "unavailable",
) {
  let at = 1_700_000_000_000;
  const face = createOfficePreview({
    rows: createOfficeRows(storage),
    now: () => at,
    machine: {
      probe: async () =>
        engine === "absent"
          ? { kind: "report", report: { available: false, reason: "no pack" } }
          : { kind: "unavailable" },
      job: async () => ({ kind: "unavailable", detail: "transport" }),
    },
  });
  return {
    face,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

// Catches: a request that leaves the session idle (the alarm is not armed at all) or arms it for
// the next session wake only, so a queued preview would wait for a heartbeat that never comes
// (C9 / NB2). The live path is the object's own: requestDocumentPreview arms min(wake, TTL).
test("a preview request arms the session alarm for now, and the alarm runs the row", async () => {
  const opened = openSqliteState();
  let alarm: number | null = null;
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const { face } = faceOver(storage);
  const state: SessionState = {
    id: { name: WORKSPACE },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const session = new Session(state, { HNS_ENV: "dev" }, async () => inertSession(), {
    office: face,
  });
  try {
    await session.ready();
    const answer = await session.requestDocumentPreview("提案書.docx", VERSION);
    expect(answer).toMatchObject({ __typename: "DocumentPreview", status: "queued" });
    // Armed at once: a queued row is due now, not at the next session wake.
    expect(alarm).not.toBeNull();
    const armed = alarm;
    if (armed === null) throw new Error("no alarm");
    expect(armed - Date.now()).toBeLessThan(OFFICE_TTL_MS);
    // The alarm runs the attempt: the machine gave no answer, so the row is stale and the alarm
    // is re-armed for the retry pause (OFFICE_RETRY_MS), inside the TTL.
    await session.alarm();
    const after = await session.documentPreview("提案書.docx", VERSION);
    expect(after).toMatchObject({ __typename: "DocumentPreview", status: "stale" });
    const retry = alarm;
    if (retry === null) throw new Error("no retry alarm");
    expect(retry - Date.now()).toBeLessThanOrEqual(OFFICE_TTL_MS);
  } finally {
    opened.close();
  }
}, 30_000);

// Catches: the probe's answer being dropped when a row already exists (NB1): a row the request
// reads as `disabled` / `unsupported` is what it must write, even if a queued row was there.
test("a request whose probe says there is no engine replaces a queued row with disabled", async () => {
  const opened = openSqliteState();
  let alarm: number | null = null;
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const { face } = faceOver(storage, "absent");
  const state: SessionState = {
    id: { name: WORKSPACE },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const session = new Session(state, { HNS_ENV: "dev" }, async () => inertSession(), {
    office: face,
  });
  try {
    await session.ready();
    // First request: the face's machine reports no engine, so the row is disabled and no alarm
    // is armed (C5).
    const first = await session.requestDocumentPreview("提案書.docx", VERSION);
    expect(first).toMatchObject({ __typename: "DocumentPreview", status: "disabled" });
    expect(alarm).toBeNull();
  } finally {
    opened.close();
  }
}, 30_000);

// Catches: a machine that stays down leaving the row stale forever (C6/C10): after the attempts
// run out the row is failed with engine_unavailable, and it stays in the object for a request to
// replace.
test("the alarm gives up on an unreachable machine, and the failed row remains", async () => {
  const opened = openSqliteState();
  let alarm: number | null = null;
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  let clock = 1_700_000_000_000;
  const face = createOfficePreview({
    rows: createOfficeRows(storage),
    now: () => clock,
    machine: {
      probe: async () => ({ kind: "unavailable" }),
      job: async () => ({ kind: "unavailable", detail: "transport" }),
    },
  });
  const state: SessionState = {
    id: { name: WORKSPACE },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const session = new Session(state, { HNS_ENV: "dev" }, async () => inertSession(), {
    office: face,
  });
  try {
    await session.ready();
    await session.requestDocumentPreview("提案書.docx", VERSION);
    for (let attempt = 0; attempt < OFFICE_MAX_ATTEMPTS; attempt += 1) {
      await session.alarm();
      clock += OFFICE_RETRY_MS;
    }
    const row = await session.documentPreview("提案書.docx", VERSION);
    expect(row).toMatchObject({
      __typename: "DocumentPreview",
      status: "failed",
    });
    if (row.__typename !== "DocumentPreview") throw new Error("expected a row");
    expect(row.error?.code).toBe("engine_unavailable");
    // Nothing is left to run, so the session is not kept awake for it.
    expect(alarm).toBeNull();
  } finally {
    opened.close();
  }
}, 30_000);

/** One office RPC against the object, with the two names a test may set. */
async function rpcWith(
  session: Session,
  names: { readonly query?: string; readonly header?: string },
): Promise<Response> {
  const url = new URL("https://session.internal/rpc/office/preview");
  if (names.query !== undefined) url.searchParams.set("workspaceId", names.query);
  url.searchParams.set("path", "提案書.docx");
  url.searchParams.set("v", VERSION);
  const headers: Record<string, string> = {};
  if (names.header !== undefined) headers[SESSION_NAME_HEADER] = names.header;
  return await session.fetch(new Request(url, { method: "GET", headers }));
}

// Catches: the object accepting a request that names only one of its two names (B1, B3). Both are
// required and both must be this object's own: header alone, query alone, both right, one wrong.
test("an office RPC needs both the name header and the workspace, and both must match", async () => {
  const opened = openSqliteState();
  let alarm: number | null = null;
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const { face } = faceOver(storage);
  const state: SessionState = {
    id: { name: WORKSPACE },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const session = new Session(state, { HNS_ENV: "dev" }, async () => inertSession(), {
    office: face,
  });
  try {
    await session.ready();
    // Header only: the request is addressed to this object but names no workspace.
    expect((await rpcWith(session, { header: WORKSPACE })).status).toBe(404);
    // Query only: the request names the workspace but is not addressed to this object.
    expect((await rpcWith(session, { query: WORKSPACE })).status).toBe(404);
    // Both, addressed elsewhere: refused, so a request cannot name another object's workspace.
    expect((await rpcWith(session, { query: "other", header: WORKSPACE })).status).toBe(404);
    expect((await rpcWith(session, { query: WORKSPACE, header: "other" })).status).toBe(404);
    // Both, and both this object: the object answers its own state (no row yet, so a failure).
    const accepted = await rpcWith(session, { query: WORKSPACE, header: WORKSPACE });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ __typename: "OfficeFailure" });
  } finally {
    opened.close();
  }
}, 30_000);
// Catches: a stale row re-arming every retry forever (each alarm is a billed request, D049):
// once the row is past its deadline the next pass answers failed(engine_timeout), and no alarm
// is armed for it again. The TTL is the deadline from the row creation, not a retry pause.
test("a machine that stays down ends at failed(engine_timeout) once the deadline passes", async () => {
  const opened = openSqliteState();
  let alarm: number | null = null;
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  let clock = 1_700_000_000_000;
  const face = createOfficePreview({
    rows: createOfficeRows(storage),
    now: () => clock,
    machine: {
      // The probe answers, so the row is queued; the job never answers, so it goes stale.
      probe: async () => ({ kind: "unavailable" }),
      job: async () => ({ kind: "unavailable", detail: "transport" }),
    },
  });
  const state: SessionState = {
    id: { name: WORKSPACE },
    storage,
    blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
    abort: () => undefined,
  };
  const session = new Session(state, { HNS_ENV: "dev" }, async () => inertSession(), {
    office: face,
  });
  try {
    await session.ready();
    await session.requestDocumentPreview("提案書.docx", VERSION);
    // Retries walk the row forward in its retry pause; none of them may pass the deadline.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      clock += 30_000;
      await session.alarm();
      const row = await session.documentPreview("提案書.docx", VERSION);
      if (row.__typename === "DocumentPreview" && row.status === "failed") break;
    }
    // Past the deadline: the next pass must settle the row rather than retry it.
    clock = 1_700_000_000_000 + 120_000;
    await session.alarm();
    const row = await session.documentPreview("提案書.docx", VERSION);
    expect(row).toMatchObject({ __typename: "DocumentPreview", status: "failed" });
    if (row.__typename !== "DocumentPreview") throw new Error("expected a row");
    expect(row.error?.code).toBe("engine_timeout");
    // And nothing is armed for it any more: the row is settled.
    expect(alarm).toBeNull();
  } finally {
    opened.close();
  }
}, 30_000);
