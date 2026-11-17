import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  EntryId,
  SessionEnd,
  SubmissionId,
  Wake,
} from "@earendil-works/pi-durable";
import {
  InvalidConversationIdError,
  type AgentSession,
  type CreateConversationInput,
} from "@hns/agent/session";
import { ConversationIdSchema, isoTimestamp, ProjectIdSchema, type Conversation } from "@hns/core";
import { expect, test, vi } from "vitest";
import * as v from "valibot";
import {
  CostGaugeUnavailableError,
  CostLimitError,
  type CostGate,
  type TurnActivity,
} from "../cost/index.ts";
import { ModelUnavailableError } from "./models.ts";
import { handleSessionRpc } from "./session-rpc.ts";

const CONVERSATION: Conversation = {
  id: v.parse(ConversationIdSchema, "2"),
  project_id: v.parse(ProjectIdSchema, "default"),
  title: "Test",
  created_at: isoTimestamp("2026-01-01T00:00:00.000Z"),
  updated_at: null,
  archived: false,
  deleted_at: null,
};

interface Counters {
  readonly lists: (number | undefined)[];
  sends: number;
}

interface Fake {
  readonly session: AgentSession;
  readonly counters: Counters;
}

function fakeSession(overrides: Partial<AgentSession> = {}): Fake {
  const counters: Counters = { lists: [], sends: 0 };
  const base: AgentSession = {
    closed: new Promise<SessionEnd>(() => undefined),
    createConversation: async () => CONVERSATION,
    listConversations: async (limit?: number) => {
      counters.lists.push(limit);
      return [CONVERSATION];
    },
    getConversation: async (id: string) => {
      throw new InvalidConversationIdError(id);
    },
    send: async () => {
      counters.sends += 1;
      throw new ModelUnavailableError("no model");
    },
    transcript: async () => [],
    watchConversation: async (id: string) => {
      throw new InvalidConversationIdError(id);
    },
    abort: async () => false,
    wake: (): Wake => ({ active: false }),
    resume: () => undefined,
    close: async () => undefined,
  };
  return { session: Object.assign(base, overrides), counters };
}

function get(path: string): Request {
  return new Request("https://session" + path);
}

function post(
  path: string,
  body: JsonValue,
  contentType = "application/json",
  headers: Record<string, string> = {},
): Request {
  return new Request("https://session" + path, {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body: JSON.stringify(body),
  });
}

test("an invalid conversation list limit is a typed 400", async () => {
  const fake = fakeSession();
  for (const limit of ["abc", "-1", "1e3", "101"]) {
    const response = await handleSessionRpc(get("/rpc/conversations?limit=" + limit), fake.session);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_request" });
  }
  expect(fake.counters.lists).toHaveLength(0);
});

test("a valid conversation list limit reaches the session", async () => {
  const fake = fakeSession();
  const response = await handleSessionRpc(get("/rpc/conversations?limit=5"), fake.session);
  expect(response.status).toBe(200);
  expect(fake.counters.lists).toStrictEqual([5]);
});

test("an invalid body is a typed 400", async () => {
  const fake = fakeSession();
  const response = await handleSessionRpc(post("/rpc/conversations", {}), fake.session);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_request" });
});

// Catches: the project root dropped at the RPC boundary, so the agent gets no cwd.
test("a conversation is created with the project root the caller hands it", async () => {
  const seen: CreateConversationInput[] = [];
  const fake = fakeSession({
    createConversation: async (input) => {
      seen.push(input);
      return CONVERSATION;
    },
  });
  const response = await handleSessionRpc(
    post("/rpc/conversations", {
      title: "x",
      projectId: "p1",
      workspaceRoot: "projects/p1",
    }),
    fake.session,
  );
  expect(response.status).toBe(201);
  expect(seen[0]).toStrictEqual({
    title: "x",
    projectId: "p1",
    workspaceRoot: "projects/p1",
  });
});

test("a missing conversation is a typed 404", async () => {
  const fake = fakeSession({ getConversation: async () => undefined });
  const response = await handleSessionRpc(get("/rpc/conversations/999"), fake.session);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "not_found" });
});

test("a malformed conversation id is a typed 400", async () => {
  const fake = fakeSession();
  const response = await handleSessionRpc(get("/rpc/conversations/abc"), fake.session);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_request" });
});

// Catches: a model that is not configured being reported as an internal failure.
test("a model that cannot run is a 503", async () => {
  const fake = fakeSession();
  const response = await handleSessionRpc(
    post("/rpc/conversations/2/messages", { text: "hi" }),
    fake.session,
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});

test("an unexpected failure is a generic 500", async () => {
  const fake = fakeSession({
    send: async () => {
      throw new Error("secret internal detail");
    },
  });
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await handleSessionRpc(
      post("/rpc/conversations/2/messages", { text: "hi" }),
      fake.session,
    );
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("secret internal detail");
    expect(body).toContain('"code":"internal"');
  } finally {
    spy.mockRestore();
  }
});

test("a non-JSON body is refused", async () => {
  const fake = fakeSession();
  const response = await handleSessionRpc(
    post("/rpc/conversations", { title: "x" }, "text/plain"),
    fake.session,
  );
  expect(response.status).toBe(415);
});

test("an oversized body is refused", async () => {
  const fake = fakeSession();
  const response = await handleSessionRpc(
    post("/rpc/conversations", { title: "x".repeat(1_048_577) }),
    fake.session,
  );
  expect(response.status).toBe(413);
});
/** One settled input answer the RPC can read. */
type SendResult = Awaited<ReturnType<AgentSession["send"]>>;

/**
 * A settled answer, for the routes that succeed.
 *
 * @remarks
 * Only `settlement.id` and `settlement.status` are read by the RPC; the numeric brands have no
 * runtime representation.
 */
function answer(): SendResult {
  // SAFETY: pi-durable allocates these ids as positive integers and the RPC reads only the
  // settlement's id and status; the brands are compile-time only.
  const settlement = {
    id: 7 as SubmissionId,
    conversationId: 2 as ConversationId,
    type: "input",
    status: "done",
    entry: 3 as EntryId,
    answer: 4 as EntryId,
  } as const;
  return { settlement, text: "answered" };
}

/** A cost gate and the activity it was asked to measure. */
interface FakeCost {
  readonly gate: CostGate;
  readonly measured: TurnActivity[];
}

/** A cost gate that lets a run through and records what it was asked to measure. */
function fakeCost(actions: Partial<CostGate> = {}): FakeCost {
  const measured: TurnActivity[] = [];
  const base: CostGate = {
    admit: async () => undefined,
    turn: async (activity, run) => {
      measured.push(activity);
      return await run();
    },
  };
  return { gate: Object.assign(base, actions), measured };
}

const SEND = (requestId?: string): Request =>
  post(
    "/rpc/conversations/2/messages",
    requestId === undefined ? { text: "hi" } : { text: "hi", requestId },
  );

// Catches: a used-up month still starting a run, or the refusal taxing the existing runs.
test("a used-up month refuses a new run and leaves the existing ones alone", async () => {
  const fake = fakeSession({
    send: async () => answer(),
    abort: async () => true,
  });
  const { gate } = fakeCost({
    admit: async () => {
      throw new CostLimitError("doRows");
    },
  });
  const refused = await handleSessionRpc(SEND(), fake.session, { cost: gate });
  expect(refused.status).toBe(429);
  expect(await refused.json()).toMatchObject({ ok: false, code: "limit_exceeded" });
  expect(fake.counters.sends).toBe(0);
  const transcript = await handleSessionRpc(get("/rpc/conversations/2/transcript"), fake.session, {
    cost: gate,
  });
  expect(transcript.status).toBe(200);
  const aborted = await handleSessionRpc(post("/rpc/conversations/2/abort", {}), fake.session, {
    cost: gate,
  });
  expect(aborted.status).toBe(200);
});

// Catches: an unreadable gauge being treated as permission to start a run.
test("a gauge that cannot be read refuses a new run", async () => {
  const fake = fakeSession({ send: async () => answer() });
  const { gate } = fakeCost({
    admit: async () => {
      throw new CostGaugeUnavailableError(new Error("d1 is down"));
    },
  });
  const response = await handleSessionRpc(SEND(), fake.session, { cost: gate });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: "limit_unavailable" });
  expect(fake.counters.sends).toBe(0);
});

// Catches: a turn that runs without being recorded, or a body request id not reaching the ledger.
test("a turn is measured with the request id the caller gave", async () => {
  const fake = fakeSession({ send: async () => answer() });
  const { gate, measured } = fakeCost();
  const response = await handleSessionRpc(SEND("turn-1"), fake.session, { cost: gate });
  expect(response.status).toBe(200);
  expect(measured).toStrictEqual([{ id: "turn-1", conversationId: "2", requests: 1 }]);
});

// Catches: the edge's x-request-id stopping before the agent that must log the same id.
test("the forwarded request id reaches the agent send", async () => {
  let seen: string | undefined;
  const fake = fakeSession({
    send: async (_id: string, _text: string, requestId?: string) => {
      seen = requestId;
      return answer();
    },
  });
  const response = await handleSessionRpc(
    post("/rpc/conversations/2/messages", { text: "hi" }, "application/json", {
      "x-request-id": "forwarded-1",
    }),
    fake.session,
  );
  expect(response.status).toBe(200);
  expect(seen).toBe("forwarded-1");
});

test("a turn without a request id gets a generated one", async () => {
  const fake = fakeSession({ send: async () => answer() });
  const { gate, measured } = fakeCost();
  await handleSessionRpc(SEND(), fake.session, { cost: gate });
  expect(measured).toHaveLength(1);
  expect(measured[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
});

// Catches: an unexpected gate failure being reported as a limit refusal.
test("an unexpected gate failure is a generic 500", async () => {
  const fake = fakeSession({ send: async () => answer() });
  const { gate } = fakeCost({
    admit: async () => {
      throw new Error("boom");
    },
  });
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const response = await handleSessionRpc(SEND(), fake.session, { cost: gate });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "internal" });
  } finally {
    spy.mockRestore();
  }
});
