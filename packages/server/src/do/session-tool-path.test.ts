import { afterEach, expect, test, vi } from "vitest";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { fakeSession } from "../../test/support/live.ts";
import { Session } from "./session.ts";
import type { SessionEnv } from "./state.ts";

/**
 * (c) 0270n: a partly configured tool path fails at start, never silently keeps Phase 0.
 *
 * @remarks
 * The Session object opens its granted tool path only when all three bindings are present. Before
 * this check, an object that saw two of them opened with the Phase 0 tools, so a deployment that
 * meant to grant tools ran the model's own tools instead. The object now refuses to open and the
 * route answers `unavailable`; the error names the bindings that are missing, never a value.
 */

/** Every line the object logged during the current case. */
let logs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  logs = [];
});

/** An object over an in-memory state, opened with `env`. */
function object(env: SessionEnv) {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  });
  const opened = openSqliteState();
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  const session = new Session(
    {
      id: { name: "project-1" },
      storage,
      blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
      abort: () => undefined,
    },
    env,
    async () => {
      // The runtime is only asked when the object opens; a partly configured object refuses before
      // this. When it is asked (the Phase 0 case), it answers a fake session.
      return fakeSession().session;
    },
  );
  return { session, close: () => opened.close() };
}

/**
 * The reason the object did not open.
 *
 * @remarks
 * The route answers a problem+json without the start error's message (a detail of an internal start
 * failure is not a client's business), so the test reads the object's own log call, which is what an
 * operator sees: the log line names the bindings and no value.
 */
function errorOf(): string {
  return logs.join("\n");
}

/** The three bindings, all set. */
const GRANTED: SessionEnv = {
  HNS_ENV: "dev",
  HNS_AGENT_URL: "http://127.0.0.1:8788",
  HNS_MACHINE_ID: "machine-1",
  HNS_CONTROL_PLANE_KEY: "seed",
};

// Catches: a Session that stays open (and serves Phase 0 turns) after a message send that carries a
// snapshot, because one of the three bindings was missing.
test("a Session whose tool-path bindings are some but not all answers unavailable", async () => {
  const cases: readonly SessionEnv[] = [
    { HNS_ENV: "dev", HNS_AGENT_URL: GRANTED.HNS_AGENT_URL },
    { HNS_ENV: "dev", HNS_MACHINE_ID: GRANTED.HNS_MACHINE_ID },
    { HNS_ENV: "dev", HNS_CONTROL_PLANE_KEY: GRANTED.HNS_CONTROL_PLANE_KEY },
    { HNS_ENV: "dev", HNS_AGENT_URL: GRANTED.HNS_AGENT_URL, HNS_MACHINE_ID: "machine-1" },
    { HNS_ENV: "dev", HNS_AGENT_URL: GRANTED.HNS_AGENT_URL, HNS_CONTROL_PLANE_KEY: "seed" },
    { HNS_ENV: "dev", HNS_MACHINE_ID: "machine-1", HNS_CONTROL_PLANE_KEY: "seed" },
    // An empty value is the binding a deployment did not fill in.
    {
      HNS_ENV: "dev",
      HNS_AGENT_URL: GRANTED.HNS_AGENT_URL,
      HNS_MACHINE_ID: "",
      HNS_CONTROL_PLANE_KEY: "seed",
    },
  ];
  for (const env of cases) {
    const { session, close } = object(env);
    try {
      const response = await session.fetch(
        new Request("https://session/rpc/conversations/1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        }),
      );
      expect(response.status, JSON.stringify(env)).toBe(503);
      // ...and the start failure said why: the operator's read of this deployment is that a
      // binding is missing, which is what the log line names (see the run below).
      const logged = errorOf();
      expect(logged).toContain("is not set while");
      expect(logged).not.toContain("127.0.0.1");
      expect(logged).not.toContain("seed");
    } finally {
      close();
    }
  }
});

// Catches: the check being too strict: none of the three is the Phase 0 deployment and must open.
test("a Session with none of the three bindings opens (the Phase 0 tools)", async () => {
  const { session, close } = object({ HNS_ENV: "dev" });
  try {
    const response = await session.fetch(
      new Request("https://session/rpc/conversations/1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    // The fake runtime answers the send: the object is open and answering as it always does.
    expect(response.status).not.toBe(503);
  } finally {
    close();
  }
});
