import { execute, parse } from "graphql";
import type { JsonValue } from "@hns/core";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openStore, type Store } from "../../../store/src/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { buildSchemaSdl } from "../../src/graphql/schema.ts";
import { clock, counter } from "../../../store/test/support.ts";
import type { WorkerEnv } from "../../src/edge/env.ts";
import { createContext } from "../../src/graphql/context.ts";
import { buildGraphQLSchema } from "../../src/graphql/schema.ts";
import { envWith } from "../support/edge.ts";
import { handleGrantsRpc } from "../../src/do/session-grants-rpc.ts";
import type { GrantPlane } from "../../src/do/session-grants.ts";
import { GRANT_INTERNAL_HEADER, GRANT_SUBJECT_HEADER } from "../../src/do/grant-subject.ts";

/**
 * `requestGrant` over the real D1 and the production Worker port (0224).
 *
 * @remarks
 * The unit suite proves the issuer; this proves the **Worker's half**: the mutation reads the active
 * policy from a real D1, refuses a project, a machine, or a tool it cannot name, and forwards the
 * snapshot to the session object through the `SESSION` binding. The object is a stub that records
 * what it was asked, because the object itself is exercised elsewhere (`session-do.test.ts`);
 * what this test proves is that the request the Worker builds is the one the issuer needs, and that
 * nothing is issued when a check fails.
 */

const schema = buildGraphQLSchema();
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/gtest-schema.txt", buildSchemaSdl());

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/** One request the stub object received. */
interface Forwarded {
  readonly path: string;
  readonly body: unknown;
}

/** A `SESSION` binding whose object records the request and answers `answer`. */
function sessionStub(answer: Response, forwarded: Forwarded[]) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      async fetch(request: Request): Promise<Response> {
        forwarded.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
        return answer.clone();
      },
    }),
  };
}

/** The environment with a SESSION binding over the stub. */
function envWithSession(db: D1Harness["db"], answer: Response, forwarded: Forwarded[]): WorkerEnv {
  return { ...envWith({ db }), SESSION: sessionStub(answer, forwarded) };
}

/** Run `requestGrant` as `subject`. */
async function requestGrant(
  store: Store,
  env: WorkerEnv,
  subject: string,
  input: Record<string, JsonValue>,
): Promise<JsonValue | null | undefined> {
  const context = createContext({
    env,
    requestId: "integration",
    session: { subject, expiresAt: 0 },
    policy: undefined,
    maxRows: 1_000,
    maxRowsPerList: 100,
  });
  const result = await execute({
    schema,
    document: parse(
      "mutation Grant($input: RequestGrantInput!) { requestGrant(input: $input) { __typename ... on RequestGrantPayload { policyRevision grant { grantId toolId machineId epoch policyHash maxCalls maxBytes scopeKind scopeRoots signature } } ... on MutationFailure { code message } } }",
    ),
    contextValue: context,
    variableValues: { input },
  });
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new Error("the document failed: " + result.errors.join("; "));
  }
  // SAFETY: GraphQL's execution result is a JSON value; the handler serializes it as such.
  return result.data as JsonValue | null | undefined;
}

const PayloadSchema = v.object({
  requestGrant: v.object({
    __typename: v.literal("RequestGrantPayload"),
    policyRevision: v.number(),
    grant: v.object({
      grantId: v.string(),
      toolId: v.string(),
      machineId: v.string(),
      epoch: v.number(),
      policyHash: v.string(),
      maxCalls: v.number(),
      maxBytes: v.number(),
      scopeKind: v.string(),
      scopeRoots: v.string(),
      signature: v.string(),
    }),
  }),
});

const FailureSchema = v.object({
  requestGrant: v.object({
    __typename: v.literal("MutationFailure"),
    code: v.string(),
    message: v.string(),
  }),
});

/** A project the grant can be for. */
async function projectOf(store: Store) {
  return await store.projects.create("grants", "work/grants");
}

// Catches: a mutation that issues on its own, or reads the policy somewhere other than the
// workspace's active revision. The request it forwards must carry that revision and its document.
test("the mutation forwards the active D1 revision and answers the object's grant", async () => {
  await harness.reset();
  const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
  try {
    const project = await projectOf(store);
    const machine = await store.machines.enroll(
      {
        name: "grant-machine",
        hostname: "grant.example.ts.net",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        agentVersion: "0.1.0",
      },
      "owner",
    );
    if (
      machine === "not_found" ||
      machine === "name_taken" ||
      machine === "revoked" ||
      machine === "invalid_request"
    ) {
      throw new Error("enrollment refused: " + machine);
    }
    const forwarded: Forwarded[] = [];
    const answer = new Response(
      JSON.stringify({
        ok: true,
        grant: {
          payload: {
            v: 1,
            grantId: "5f0f2d5e-6a1e-4a7f-9a7f-0d3c4b2a1f00",
            workspaceId: project.id,
            sessionId: project.id,
            machineId: machine.machine.id,
            toolId: "read_file",
            toolVersion: "1",
            manifestHash: "a".repeat(64),
            scope: { kind: "read", roots: ["."] },
            issuedAt: "2026-11-18T00:00:00.000Z",
            expiresAt: "2026-11-18T00:01:00.000Z",
            epoch: 1,
            policyHash: "b".repeat(64),
            maxCalls: 10,
            maxBytes: 4096,
            nonce: "n",
            alg: "Ed25519",
            keyId: "k",
          },
          signature: "c2lnbmF0dXJl",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const data = await requestGrant(store, envWithSession(harness.db, answer, forwarded), "owner", {
      projectId: project.id,
      machineId: machine.machine.id,
      toolId: "read_file",
      toolVersion: "1",
      manifestHash: "a".repeat(64),
    });
    const payload = v.parse(PayloadSchema, data).requestGrant;
    // The signed grant is a capability the caller holds: the signature is the answer's one
    // secret-shaped value, returned exactly as the object signed it.
    expect(payload.grant.signature).toBe("c2lnbmF0dXJl");
    expect(payload.policyRevision).toBe(1);
    // The revision's hash reaches the reader with the grant: 0225's machine compares it with the
    // active policy, so a face that dropped it would hand out a grant nothing can verify.
    expect(payload.grant.policyHash).toBe("b".repeat(64));
    expect(payload.grant.scopeKind).toBe("read");
    // One forward, to the grant route, with the snapshot the object issues under.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.path).toBe("/rpc/grants");
    const body = v.parse(
      v.object({
        snapshot: v.object({ revision: v.number(), hash: v.string(), document: v.unknown() }),
        request: v.object({
          toolId: v.string(),
          machineId: v.string(),
          workspaceId: v.string(),
          toolVersion: v.string(),
          manifestHash: v.string(),
        }),
        requestedBy: v.object({ kind: v.string(), id: v.string() }),
      }),
      forwarded[0]?.body,
    );
    expect(body.snapshot.revision).toBe(1);
    expect(body.snapshot.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.request.machineId).toBe(machine.machine.id);
    expect(body.request.workspaceId).toBe(project.id);
    expect(body.requestedBy).toStrictEqual({ kind: "human", id: "owner" });
    // The Worker carries no tool table: the request names the caller's manifest hash and no version
    // (the object answers the first such request with the version it declares).
    // The Worker carries no tool table: it forwards the version and manifest hash the caller named,
    // and the object checks them against its own tool contracts.
    expect({
      toolVersion: body.request.toolVersion,
      manifestHash: body.request.manifestHash,
    }).toStrictEqual({
      toolVersion: "1",
      manifestHash: "a".repeat(64),
    });
    // The grant's ledger is the object's; D1 gained no grant row.
    const tables = await harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%grant%'")
      .all();
    expect(
      (tables.results ?? []).map((row) => v.parse(v.object({ name: v.string() }), row)),
    ).toStrictEqual([]);
  } finally {
    await store.close();
  }
});

// NB7: the grant route is the Worker's. A request that does not prove it (no token, another
// token, no subject, or a requester that is not the subject) is refused and issues nothing.
test("the grant route refuses a caller that is not the Worker, and a requester that is not the subject", async () => {
  const calls: unknown[] = [];
  const plane: GrantPlane = {
    request: async (input) => {
      calls.push(input);
      return {
        ok: false,
        decision: { outcome: "deny", code: "tool_disabled", message: "x" },
        request: undefined,
      };
    },
    boundTo: async () => [],
    revokeRun: async () => ({ revoked: [], failed: [] }),
  };
  const body = JSON.stringify({
    request: {},
    snapshot: {},
    requestedBy: { kind: "human", id: "owner" },
  });
  const send = async (headers: Record<string, string>) => {
    const response = await handleGrantsRpc(
      new Request("https://session.internal/rpc/grants", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
      plane,
      { maxBodyBytes: 10_000, token: "the-worker-token" },
    );
    return { status: response.status, body: await response.json() };
  };
  const noToken = await send({ [GRANT_SUBJECT_HEADER]: "owner" });
  expect(noToken.status).toBe(401);
  const wrongToken = await send({
    [GRANT_INTERNAL_HEADER]: "another",
    [GRANT_SUBJECT_HEADER]: "owner",
  });
  expect(wrongToken.status).toBe(401);
  const noSubject = await send({ [GRANT_INTERNAL_HEADER]: "the-worker-token" });
  expect(noSubject.status).toBe(401);
  const otherSubject = await send({
    [GRANT_INTERNAL_HEADER]: "the-worker-token",
    [GRANT_SUBJECT_HEADER]: "someone-else",
  });
  expect(otherSubject.status).toBe(401);
  // Nothing reached the plane: no grant was even attempted.
  expect(calls).toStrictEqual([]);
  // The Worker itself is admitted, and the refusal is the plane's.
  const admitted = await send({
    [GRANT_INTERNAL_HEADER]: "the-worker-token",
    [GRANT_SUBJECT_HEADER]: "owner",
  });
  expect(admitted.status).toBe(403);
  expect(calls).toHaveLength(1);
});

// Catches: a grant forwarded for a project, a machine, or a tool the Worker cannot name.
test("an unknown project, machine, or tool is refused without a forward", async () => {
  await harness.reset();
  const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
  try {
    const project = await projectOf(store);
    const forwarded: Forwarded[] = [];
    const env = envWithSession(
      harness.db,
      new Response(JSON.stringify({ ok: false, code: "tool_disabled" }), { status: 403 }),
      forwarded,
    );
    const noProject = await requestGrant(store, env, "owner", {
      projectId: "missing",
      machineId: "m",
      toolId: "read_file",
    });
    expect(v.parse(FailureSchema, noProject).requestGrant.code).toBe("NOT_FOUND");
    const noMachine = await requestGrant(store, env, "owner", {
      projectId: project.id,
      machineId: "missing",
      toolId: "read_file",
    });
    expect(v.parse(FailureSchema, noMachine).requestGrant.code).toBe("NOT_FOUND");
    const noTool = await requestGrant(store, env, "owner", {
      projectId: project.id,
      machineId: "m",
      toolId: "rm_rf",
    });
    expect(v.parse(FailureSchema, noTool).requestGrant.code).toBe("INVALID_REQUEST");
    expect(forwarded).toStrictEqual([]);
  } finally {
    await store.close();
  }
});

// Catches: an object's refusal turned into a grant, or its code lost on the way back.
test("the object's refusal is the mutation's refusal", async () => {
  await harness.reset();
  const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
  try {
    const project = await projectOf(store);
    const machine = await store.machines.enroll(
      {
        name: "grant-machine",
        hostname: "grant.example.ts.net",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        agentVersion: "0.1.0",
      },
      "owner",
    );
    if (
      machine === "not_found" ||
      machine === "name_taken" ||
      machine === "revoked" ||
      machine === "invalid_request"
    ) {
      throw new Error("enrollment refused: " + machine);
    }
    const forwarded: Forwarded[] = [];
    const env = envWithSession(
      harness.db,
      new Response(JSON.stringify({ ok: false, code: "tool_disabled", message: "no bash" }), {
        status: 403,
      }),
      forwarded,
    );
    const data = await requestGrant(store, env, "owner", {
      projectId: project.id,
      machineId: machine.machine.id,
      toolId: "bash",
    });
    expect(v.parse(FailureSchema, data).requestGrant).toMatchObject({
      code: "FORBIDDEN",
      message: "no bash",
    });
  } finally {
    await store.close();
  }
});
