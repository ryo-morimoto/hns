import { expect, test } from "vitest";
import { policyHash } from "@hns/core/capability";
import * as v from "valibot";
import type { JsonValue } from "@hns/core";
import type { PolicyDocument } from "@hns/core/capability";
import { PolicySnapshotBodySchema, TOOL_RUN_TOKEN_HEADER } from "@hns/workspace/protocol";
import type { PolicySnapshotBody } from "@hns/workspace/protocol";
import type { AgentSession } from "@hns/agent/session";
import { ModelUnavailableError } from "./models.ts";
import { handleSessionRpc } from "./session-rpc.ts";
import { createToolPath, type ToolPath } from "./session-tools.ts";
import type { PolicyAudit } from "./audit.ts";

/**
 * The Session RPC's granted routes (0226): a run relays on its own token, and a send carries the
 * policy the Worker read.
 *
 * @remarks
 * The Session object is a fake here; the tool path is the real one, with a recording audit and a
 * fake machine. What is proved is the route's own checks: a missing, foreign, or expired token is
 * refused before anything is issued; a relayed call reaches the path; and a send on the granted
 * path needs a snapshot, and refuses one that moves the policy back.
 */

const DOCUMENT: PolicyDocument = {
  v: 1,
  tools: {
    read_file: {
      enabled: true,
      scope: { kind: "read", roots: ["."] },
      grantTtlSeconds: 60,
      maxCallsPerGrant: 10,
    },
  },
  egress: { enabled: false, hosts: [] },
};

/**
 * A send's answer for a fake session: the route reads the settlement's id and nothing else.
 *
 * @returns The turn the route's answer needs; no model runs in these tests.
 */
const fakeTurn = (): Awaited<ReturnType<AgentSession["send"]>> => {
  const turn = {
    settlement: { id: "1", status: "unanswered", reason: "test" },
    text: "",
  };
  // SAFETY: the route reads only the settlement's id (a branded number there); this fake is the
  // answer of a send whose model never runs, which is what these route tests need.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake is not the real Turn.
  return turn as unknown as Awaited<ReturnType<AgentSession["send"]>>;
};

/** A fake session that counts its sends. */
function fakeSession() {
  const sends: number[] = [];
  const session: AgentSession = {
    closed: new Promise(() => undefined),
    createConversation: async () => {
      throw new Error("unused");
    },
    listConversations: async () => [],
    getConversation: async () => undefined,
    send: async () => {
      sends.push(1);
      // The object's route sends the answer itself; nothing here reaches a model.
      return fakeTurn();
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
  return { session, sends };
}

/** A tool path whose issuer and relay are fakes: nothing reaches a machine here. */
function toolPath(): ToolPath {
  const audit: PolicyAudit = {
    append: async () => {
      throw new Error("the route test relays a call with no snapshot");
    },
    list: async () => [],
    verify: async () => ({ ok: true, rows: 0 }),
  };
  const unused = (): never => {
    throw new Error("the route test's path does not reach a machine");
  };
  return createToolPath({
    workspaceId: "w1",
    sessionId: "s1",
    issuer: { issue: async () => unused() },
    audit,
    machine: {
      write: async () => unused(),
      read: async () => unused(),
      checkpoint: async () => unused(),
    },
    controlPlaneKey: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
    machineId: "m1",
    manifests: async () => [],
    revoked: async () => false,
    grantOf: async () => undefined,
    now: () => Date.now(),
    eventId: () => crypto.randomUUID(),
  });
}

/** The relay's headers: the JSON body's type, and the run's token when the caller has one. */
function requestHeaders(token: string | undefined): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set(TOOL_RUN_TOKEN_HEADER, token);
  return headers;
}

/** One turn's send body carrying the snapshot. */
function sendBody(policy: Readonly<Record<string, JsonValue>> | undefined, text = "hi"): Request {
  return new Request("https://session/rpc/conversations/1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy === undefined ? { text } : { text, policy }),
  });
}

/** The snapshot for revision 1 of the document. */
async function snapshot(revision = 1): Promise<PolicySnapshotBody> {
  return v.parse(PolicySnapshotBodySchema, {
    revision,
    hash: await policyHash(DOCUMENT),
    document: DOCUMENT,
  });
}

// A send on the granted path with no snapshot is refused before the run: no policy, no grant.
test("a send on the granted path needs the active policy", async () => {
  const { session, sends } = fakeSession();
  const response = await handleSessionRpc(sendBody(undefined), session, { tools: toolPath() });
  expect(response.status).toBe(400);
  expect(sends).toHaveLength(0);
});

// A snapshot that names another document is refused.
test("a send whose snapshot is not the revision it names is refused", async () => {
  const { session } = fakeSession();
  const policy = await snapshot();
  const response = await handleSessionRpc(sendBody({ ...policy, hash: "f".repeat(64) }), session, {
    tools: toolPath(),
  });
  expect(response.status).toBe(400);
});

// A snapshot that moves the policy back is refused: the object already admitted a newer revision.
test("a send with an older revision is refused after a newer one was admitted", async () => {
  const { session } = fakeSession();
  const tools = toolPath();
  const newer = await handleSessionRpc(sendBody(await snapshot(2)), session, { tools });
  expect(newer.status).toBe(200);
  const older = await handleSessionRpc(sendBody(await snapshot(1)), session, { tools });
  expect(older.status).toBe(503);
  const body = await older.json();
  expect(body).toMatchObject({ ok: false, code: "unavailable" });
});

// The relay route needs the run's token: no token, another run's, or a closed run's is refused.
test("the relay route refuses a caller without the run's token", async () => {
  const { session } = fakeSession();
  const tools = toolPath();
  const body = JSON.stringify({ call: {}, manifest: {}, bytes: 1 });
  const request = (token: string | undefined) =>
    new Request("https://session/rpc/conversations/run-1/tool", {
      method: "POST",
      headers: requestHeaders(token),
      body,
    });
  // No token: the object cannot tell whose call it is.
  expect((await handleSessionRpc(request(undefined), session, { tools })).status).toBe(401);
  // A token minted for another run is not this run's.
  const other = tools.state.mint("run-2");
  expect((await handleSessionRpc(request(other), session, { tools })).status).toBe(401);
  // This run's own token passes the token check; the call it relays is the path's to decide.
  const own = tools.state.mint("run-1");
  const passed = await handleSessionRpc(request(own), session, { tools });
  expect(passed.status).not.toBe(401);
  // A run whose end forgot its token has no token that works.
  tools.state.forget("run-1");
  expect((await handleSessionRpc(request(own), session, { tools })).status).toBe(401);
});
