import type { JsonValue } from "@earendil-works/chord";
import type { SessionEnd, Wake } from "@earendil-works/pi-durable";
import { InvalidConversationIdError, type AgentSession } from "@hns/agent/session";
import { ConversationIdSchema, isoTimestamp, ProjectIdSchema, type Conversation } from "@hns/core";
import { expect, test, vi } from "vitest";
import * as v from "valibot";
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
}

interface Fake {
  readonly session: AgentSession;
  readonly counters: Counters;
}

function fakeSession(overrides: Partial<AgentSession> = {}): Fake {
  const counters: Counters = { lists: [] };
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

function post(path: string, body: JsonValue, contentType = "application/json"): Request {
  return new Request("https://session" + path, {
    method: "POST",
    headers: { "content-type": contentType },
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
