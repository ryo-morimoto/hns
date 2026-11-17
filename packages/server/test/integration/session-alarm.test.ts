import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openSession, type AgentSession } from "@hns/agent/session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as v from "valibot";
import { Session, type SessionRuntimeFactory } from "../../src/do/session.ts";
import type { SessionState } from "../../src/do/state.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };
const PREFIX = "hns_session";

interface FakeState extends SessionState {
  readonly alarmCalls: number[];
  readonly aborts: string[];
  readonly alarm: () => number | null;
}

function fakeState(): FakeState {
  let alarm: number | null = null;
  const alarmCalls: number[] = [];
  const aborts: string[] = [];
  return {
    storage: {
      sql: {
        exec: () => ({
          next: () => ({ done: true as const }),
          toArray: () => [],
        }),
      },
      transaction: <T>(run: () => Promise<T>): Promise<T> => run(),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
        alarmCalls.push(at);
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
    blockConcurrencyWhile: <T>(run: () => Promise<T>): Promise<T> => run(),
    abort: (reason?: string) => {
      aborts.push(reason ?? "");
    },
    alarmCalls,
    aborts,
    alarm: () => alarm,
  };
}

interface Runtime {
  session?: AgentSession | undefined;
  resumeCalls: number;
}

function factory(path: string, runtime: Runtime): SessionRuntimeFactory {
  return async (_state, _env, hooks) => {
    const db = await openNodeSqliteDatabase(path);
    const storage = await SqliteStorage.open(db, { prefix: PREFIX });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("alarm response")]);
    const session = await openSession({
      storage,
      models,
      registry: createRegistry(),
      model: MODEL,
      context: BACKGROUND_CONTEXT,
      onWake: hooks.onWake,
      onReport: hooks.onReport,
    });
    const wrapped: AgentSession = {
      ...session,
      resume: () => {
        runtime.resumeCalls += 1;
        session.resume();
      },
    };
    runtime.session = wrapped;
    return wrapped;
  };
}

function postJson(path: string, body: JsonValue): Request {
  return new Request("https://session" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request("https://session" + path);
}

const Created = v.object({
  ok: v.literal(true),
  conversation: v.object({ id: v.string() }),
});
const Sent = v.object({ ok: v.literal(true), text: v.string() });
const Transcript = v.object({
  ok: v.literal(true),
  entries: v.array(v.object({ kind: v.string() })),
});

// Catches: the alarm path being unwired, or a second wake duplicating the run.
test("the alarm resumes without duplicating the run", async () => {
  const base = await mkdtemp(join(tmpdir(), "hns-alarm-"));
  const path = join(base, "session.sqlite");
  const runtime: Runtime = { resumeCalls: 0 };
  const state = fakeState();
  // Development without the control database: the one binding set a Session opens without DB.
  const session = new Session(state, { HNS_ENV: "dev" }, factory(path, runtime));
  try {
    const created = v.parse(
      Created,
      await (await session.fetch(postJson("/rpc/conversations", { title: "Alarm" }))).json(),
    );
    const sent = v.parse(
      Sent,
      await (
        await session.fetch(
          postJson("/rpc/conversations/" + created.conversation.id + "/messages", {
            text: "hi",
          }),
        )
      ).json(),
    );
    expect(sent.text).toBe("alarm response");
    const before = v.parse(
      Transcript,
      await (
        await session.fetch(get("/rpc/conversations/" + created.conversation.id + "/transcript"))
      ).json(),
    );
    expect(before.entries.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);

    const alarmCallsBefore = state.alarmCalls.length;
    const resumeCallsBefore = runtime.resumeCalls;
    await session.alarm();
    await session.alarm();

    const after = v.parse(
      Transcript,
      await (
        await session.fetch(get("/rpc/conversations/" + created.conversation.id + "/transcript"))
      ).json(),
    );
    expect(after.entries).toHaveLength(before.entries.length);
    expect(after.entries.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);
    expect(state.alarmCalls.length).toBeGreaterThan(alarmCallsBefore);
    expect(runtime.resumeCalls).toBeGreaterThan(resumeCallsBefore);
    expect(state.aborts).toStrictEqual([]);
  } finally {
    await runtime.session?.close();
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
