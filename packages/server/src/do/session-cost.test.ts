import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { openSession } from "@hns/agent/session";
import type { D1Binding } from "@hns/store";
import { expect, test } from "vitest";
import * as v from "valibot";
import { openFakeD1 } from "../../../store/test/support/fake-d1.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { Session, type SessionRuntimeFactory } from "./session.ts";
import type { SessionEnv, SessionState } from "./state.ts";

/**
 * The answer every turn returns in this file.
 *
 * @remarks
 * 200 words, not the short default: a runtime that appends one row per streamed delta would
 * write a row per delta, so the short default would hide that defect behind a row count that
 * happens to fit. The long answer is what makes the row budget meaningful.
 */
const LONG_RESPONSE = "word ".repeat(200).trim();

/** The rows one text turn added, measured when this test was written; see deploy/limits/RESULTS.md. */
const ROWS_PER_TURN = 10;

/**
 * The row budget for one text turn.
 *
 * @remarks
 * A ceiling rather than an equality for the budget itself, so a legitimate one-row change
 * does not fail; the recorded value is pinned separately because the measurement is published.
 * A runtime that committed once per token would be hundreds of rows over it.
 */
const ROW_BUDGET = 24;

const NAME = v.object({ name: v.string() });
const COUNT = v.object({ count: v.number() });
const SEND_BODY = v.object({ text: v.string() });

/** The rows stored across every table, counted independently of the meter. */
function storedRows(storage: DurableObjectSqliteStorage): number {
  const tables = storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .toArray()
    .map((row) => v.parse(NAME, row).name);
  let total = 0;
  for (const table of tables) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const counted = storage.sql.exec("SELECT COUNT(*) AS count FROM " + quoted).toArray();
    total += v.parse(COUNT, counted[0] ?? {}).count;
  }
  return total;
}

/**
 * A runtime that answers every turn with {@link LONG_RESPONSE}.
 *
 * @remarks
 * The product runtime is built from the bindings; this factory replaces only the model, the
 * same seam the Session exposes for tests. The storage the Session opens is the real
 * pi-durable SQLite storage over the test state, so the row count is a real measurement.
 */
function longAnswerRuntime(): SessionRuntimeFactory {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const respond = (): ReturnType<typeof fauxAssistantMessage> => {
    faux.appendResponses([respond]);
    return fauxAssistantMessage(LONG_RESPONSE);
  };
  faux.setResponses([respond]);
  return async (state, _env, hooks) => {
    const storage = await openDurableObjectSqliteStorage(state.storage, { prefix: "hns_session" });
    return await openSession({
      storage,
      models,
      registry: createRegistry(),
      model: { provider: "faux", modelId: "faux-1" },
      context: BACKGROUND_CONTEXT,
      onWake: hooks.onWake,
      onReport: hooks.onReport,
      onEvent: hooks.onEvent,
    });
  };
}

/** An open object state and its closer. */
interface OpenObject {
  readonly state: SessionState;
  close(): void;
}

/** An open object state with the alarm methods the Session arms. */
function objectState(): OpenObject {
  const opened = openSqliteState();
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  return {
    state: {
      storage,
      blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
      abort: () => undefined,
    },
    close: opened.close,
  };
}

interface Fixture {
  readonly session: Session;
  readonly db: D1Binding;
  readonly storage: DurableObjectSqliteStorage;
  close(): void;
}

/**
 * A Session over a real (Node SQLite) runtime and a real (node:sqlite) control database.
 *
 * @remarks
 * The database starts empty: the Session applies the migrations at open, which is what a
 * deployment relies on before the first send.
 */
async function open(options: { readonly controlDatabase?: boolean } = {}): Promise<Fixture> {
  const fake = openFakeD1();
  const opened = objectState();
  const env: SessionEnv =
    options.controlDatabase === false
      ? { HNS_ENV: "dev", HNS_MODEL: "faux/echo" }
      : { HNS_ENV: "dev", HNS_MODEL: "faux/echo", DB: fake.db };
  return {
    session: new Session(opened.state, env, longAnswerRuntime()),
    db: fake.db,
    storage: opened.state.storage,
    close: () => {
      opened.close();
      fake.close();
    },
  };
}

async function create(session: Session): Promise<string> {
  const response = await session.fetch(
    new Request("https://session/rpc/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Cost" }),
    }),
  );
  expect(response.status).toBe(201);
  const body = v.parse(
    v.object({ conversation: v.object({ id: v.string() }) }),
    await response.json(),
  );
  return body.conversation.id;
}

function send(session: Session, id: string, requestId?: string): Promise<Response> {
  return session.fetch(
    new Request("https://session/rpc/conversations/" + id + "/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestId === undefined ? { text: "hi" } : { text: "hi", requestId }),
    }),
  );
}

// Catches: a runtime that commits a row per token (or per streamed delta), which the monthly
// limit would only notice long after the money was spent.
test("one text turn stays inside the row budget", async () => {
  const fixture = await open();
  try {
    const id = await create(fixture.session);
    const before = storedRows(fixture.storage);
    const response = await send(fixture.session, id, "turn-1");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(v.parse(SEND_BODY, await response.json()).text).toBe(LONG_RESPONSE);
    const after = storedRows(fixture.storage);
    const added = after - before;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(ROW_BUDGET);
    // The published measurement is this number; a change means the runtime's write pattern
    // changed and deploy/limits/RESULTS.md must be measured again.
    expect(added).toBe(ROWS_PER_TURN);
    const row = await fixture.db
      .prepare("SELECT conversation_id, outcome, do_rows, do_requests, r2_objects FROM cost_turn")
      .first();
    expect(row).toStrictEqual({
      conversation_id: id,
      outcome: "completed",
      do_rows: added,
      do_requests: 1,
      r2_objects: 0,
    });
  } finally {
    fixture.close();
  }
});

// Catches: a retried send spending the month budget twice.
test("a resent request is one cost row", async () => {
  const fixture = await open();
  try {
    const id = await create(fixture.session);
    expect((await send(fixture.session, id, "same")).status).toBe(200);
    expect((await send(fixture.session, id, "same")).status).toBe(200);
    const counted = await fixture.db.prepare("SELECT COUNT(*) AS count FROM cost_turn").first();
    expect(counted).toStrictEqual({ count: 1 });
  } finally {
    fixture.close();
  }
});

// Catches: a used-up month still starting a run, while aborting an existing one must keep working.
test("a used-up row budget refuses the next run and keeps abort", async () => {
  const fixture = await open();
  try {
    const id = await create(fixture.session);
    expect((await send(fixture.session, id, "turn-1")).status).toBe(200);
    await fixture.db.prepare("UPDATE cost_limits SET do_rows_limit = 1").run();
    const refused = await send(fixture.session, id, "turn-2");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ ok: false, code: "limit_exceeded" });
    const transcript = await fixture.session.fetch(
      new Request("https://session/rpc/conversations/" + id + "/transcript"),
    );
    expect(transcript.status).toBe(200);
    const aborted = await fixture.session.fetch(
      new Request("https://session/rpc/conversations/" + id + "/abort", { method: "POST" }),
    );
    expect(aborted.status).toBe(200);
    const counted = await fixture.db.prepare("SELECT COUNT(*) AS count FROM cost_turn").first();
    expect(counted).toStrictEqual({ count: 1 });
  } finally {
    fixture.close();
  }
});

// Catches: an unreadable control database breaking reads, or admitting a run without limits.
test("a failing control database keeps reads and refuses the run", async () => {
  const broken: D1Binding = {
    prepare: () => {
      throw new Error("d1 is down");
    },
    batch: async () => {
      throw new Error("d1 is down");
    },
  };
  const opened = objectState();
  const session = new Session(
    opened.state,
    { HNS_ENV: "dev", HNS_MODEL: "faux/echo", DB: broken },
    longAnswerRuntime(),
  );
  try {
    const id = await create(session);
    const response = await send(session, id, "turn-1");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "limit_unavailable" });
    const transcript = await session.fetch(
      new Request("https://session/rpc/conversations/" + id + "/transcript"),
    );
    expect(transcript.status).toBe(200);
  } finally {
    opened.close();
  }
});

// Catches: a missing control database crashing the turn path instead of leaving cost unwired.
test("without a control database the turn path is not gated", async () => {
  const fixture = await open({ controlDatabase: false });
  try {
    const id = await create(fixture.session);
    expect((await send(fixture.session, id, "turn-1")).status).toBe(200);
  } finally {
    fixture.close();
  }
});
