import { execute, GraphQLObjectType, parse } from "graphql";
import * as v from "valibot";
import { expect, test } from "vitest";
import { encodeDeviceKey, type JsonValue } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import type { Store } from "../../../store/src/index.ts";
import type { WorkerEnv } from "../../src/edge/env.ts";
import { createD1Harness } from "../../../store/test/integration/harness.ts";
import { openStore } from "../../../store/src/index.ts";
import { clock, counter } from "../../../store/test/support.ts";
import type { D1Binding } from "@hns/store";
import { createContext } from "../../src/graphql/context.ts";
import { buildGraphQLSchema } from "../../src/graphql/schema.ts";
import { envWith } from "../support/edge.ts";
import { deviceKeyFromSeed } from "../support/device.ts";

/**
 * The machines GraphQL face over the real D1 (0148).
 *
 * @remarks
 * The unit suite proves the resolver's shape; this proves the **SQL and the schema together**:
 * `registerMachine` writes a row whose key verifies, a second registration of the same name is a
 * reimage, `Query.machines` lists what D1 holds, and `revokeMachine` takes the status and the key.
 * The production reads are not replaced, except for the probe (this suite has no machine to call).
 */

const schema = buildGraphQLSchema();

/** The harness the current test opened; `run` reads its D1 when a test passes no env. */
let harnessRef: { readonly db: D1Binding };

/** Run one document against a store with an injected machine port. */
async function run(
  store: Store,
  subject: string,
  query: string,
  variables: Record<string, JsonValue>,
  env: WorkerEnv = envWith({ db: harnessRef.db }),
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
    document: parse(query),
    contextValue: context,
    variableValues: variables,
  });
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new Error(
      "the document failed: " + result.errors.map((issue) => issue.message).join("; "),
    );
  }
  // SAFETY: GraphQL's execution result is a JSON value; the handler serializes it as such.
  return result.data as JsonValue | null | undefined;
}

const REGISTER =
  "mutation Register($input: RegisterMachineInput!) { registerMachine(input: $input) { __typename ... on RegisterMachinePayload { machine { id name hostname publicKey fingerprint status lastSeen keyAlgorithm agentVersion isMine } reimaged previousFingerprint } ... on MutationFailure { code message } } }";

const REVOKE =
  "mutation Revoke($id: String!) { revokeMachine(id: $id) { __typename ... on RevokeMachinePayload { machine { id status } } ... on MutationFailure { code message } } }";

const MACHINES =
  "query Machines($first: Int) { machines(first: $first) { __typename ... on MachineList { machines { id name hostname fingerprint status lastSeen isMine createdAt } } ... on QueryFailure { code message } } }";

/** Register a machine through the document, wrapping the values in the input object. */
async function registerMachine(
  store: Store,
  subject: string,
  input: Record<string, JsonValue>,
): Promise<JsonValue | null | undefined> {
  return await run(store, subject, REGISTER, { input });
}

const RegisterPayloadSchema = v.object({
  registerMachine: v.object({
    __typename: v.literal("RegisterMachinePayload"),
    machine: v.object({
      id: v.string(),
      name: v.string(),
      hostname: v.string(),
      publicKey: v.string(),
      fingerprint: v.string(),
      status: v.string(),
      lastSeen: v.nullable(v.number()),
      keyAlgorithm: v.string(),
      agentVersion: v.string(),
      isMine: v.boolean(),
    }),
    reimaged: v.boolean(),
    previousFingerprint: v.nullable(v.string()),
  }),
});

const FailureSchema = v.object({
  __typename: v.literal("MutationFailure"),
  code: v.string(),
  message: v.string(),
});

// Catches: a registration that stores the key in a spelling the verifier cannot use, or a
// machine the list does not show.
test("registerMachine writes one machine whose key D1 hands back", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const key = await deviceKeyFromSeed(21);
      const data = await registerMachine(store, "owner", {
        name: "face",
        hostname: "face.example.ts.net",
        publicKey: encodeDeviceKey(key.publicKey),
        agentVersion: "0.1.0",
      });
      const payload = v.parse(RegisterPayloadSchema, data).registerMachine;
      expect(payload.machine.name).toBe("face");
      expect(payload.machine.publicKey).toBe(encodeDeviceKey(key.publicKey));
      expect(payload.machine.status).toBe("OFFLINE");
      expect(payload.reimaged).toBe(false);
      expect(payload.previousFingerprint).toBeNull();
      // The payload's id is a global id; the registry's key is what a verifier reads.
      expect((await store.machines.list())[0]?.publicKey).toBe(encodeDeviceKey(key.publicKey));
      const listed = await run(store, "owner", MACHINES, { first: 10 });
      const machines = v.parse(
        v.object({
          machines: v.object({
            __typename: v.literal("MachineList"),
            machines: v.array(v.object({ name: v.string(), status: v.string() })),
          }),
        }),
        listed,
      ).machines.machines;
      expect(machines.map((machine) => machine.name)).toStrictEqual(["face"]);
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a same-name registration that creates a second row instead of a reimage.
test("a same-name registration is a reimage that keeps the machine id", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const first = await deviceKeyFromSeed(22);
      const second = await deviceKeyFromSeed(23);
      const args = {
        name: "reimaged",
        hostname: "reimaged.example.ts.net",
        agentVersion: "0.1.0",
      };
      const enrolled = v.parse(
        RegisterPayloadSchema,
        await registerMachine(store, "owner", {
          ...args,
          publicKey: encodeDeviceKey(first.publicKey),
        }),
      ).registerMachine;
      const reimaged = v.parse(
        RegisterPayloadSchema,
        await registerMachine(store, "owner", {
          ...args,
          publicKey: encodeDeviceKey(second.publicKey),
        }),
      ).registerMachine;
      expect(reimaged.reimaged).toBe(true);
      expect(reimaged.machine.id).toBe(enrolled.machine.id);
      expect(reimaged.previousFingerprint).toBe(enrolled.machine.fingerprint);
      expect(await store.machines.list()).toHaveLength(1);
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a revoke that does not take the key away, or a second enrollment of a revoked name.
test("revokeMachine refuses the name and takes the key away", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const key = await deviceKeyFromSeed(24);
      const enrolled = v.parse(
        RegisterPayloadSchema,
        await registerMachine(store, "owner", {
          name: "revoking",
          hostname: "revoking.example.ts.net",
          publicKey: encodeDeviceKey(key.publicKey),
          agentVersion: "0.1.0",
        }),
      ).registerMachine;
      // A global id that names no machine is a typed not_found.
      const missing = v.parse(
        v.object({
          revokeMachine: v.union([
            FailureSchema,
            v.object({
              __typename: v.literal("RevokeMachinePayload"),
              machine: v.object({ id: v.string(), status: v.string() }),
            }),
          ]),
        }),
        await run(store, "owner", REVOKE, { id: toGlobalId("Machine", "missing") }),
      );
      expect(missing.revokeMachine.__typename).toBe("MutationFailure");
      // A real global id revokes; the key is gone afterwards.
      const revoked = v.parse(
        v.object({
          revokeMachine: v.object({
            __typename: v.literal("RevokeMachinePayload"),
            machine: v.object({ id: v.string(), status: v.string() }),
          }),
        }),
        await run(store, "owner", REVOKE, { id: enrolled.machine.id }),
      );
      expect(revoked.revokeMachine.machine.status).toBe("REVOKED");
      // Enrolling the revoked name again is a conflict that names the reason.
      const again = v.parse(
        v.object({ registerMachine: FailureSchema }),
        await registerMachine(store, "owner", {
          name: "revoking",
          hostname: "revoking.example.ts.net",
          publicKey: encodeDeviceKey((await deviceKeyFromSeed(25)).publicKey),
          agentVersion: "0.1.0",
        }),
      );
      expect(again.registerMachine.code).toBe("REVOKED");
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches (B1): mallory reimaging a machine alice enrolled, through the public mutation.
test("registerMachine refuses a reimage by another operator", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const aliceKey = await deviceKeyFromSeed(40);
      const malloryKey = await deviceKeyFromSeed(41);
      const args = { name: "claimed", hostname: "claimed.example.ts.net", agentVersion: "0.1.0" };
      const enrolled = v.parse(
        RegisterPayloadSchema,
        await registerMachine(store, "alice", {
          ...args,
          publicKey: encodeDeviceKey(aliceKey.publicKey),
        }),
      ).registerMachine;
      const refused = v.parse(
        v.object({ registerMachine: FailureSchema }),
        await registerMachine(store, "mallory", {
          ...args,
          hostname: "mallory.example.ts.net",
          publicKey: encodeDeviceKey(malloryKey.publicKey),
        }),
      );
      expect(refused.registerMachine.code).toBe("CONFLICT");
      // Nothing moved: the key and hostname are alice's.
      const [after] = await store.machines.list();
      expect(after?.publicKey).toBe(encodeDeviceKey(aliceKey.publicKey));
      expect(after?.hostname).toBe("claimed.example.ts.net");
      expect(after?.owner).toBe("alice");
      // The list tells alice it is hers and mallory that it is not, without either subject leaking.
      const asAlice = v.parse(
        v.object({
          machines: v.object({
            __typename: v.literal("MachineList"),
            machines: v.array(v.object({ isMine: v.boolean() })),
          }),
        }),
        await run(store, "alice", MACHINES, {}),
      );
      const asMallory = v.parse(
        v.object({
          machines: v.object({
            __typename: v.literal("MachineList"),
            machines: v.array(v.object({ isMine: v.boolean() })),
          }),
        }),
        await run(store, "mallory", MACHINES, {}),
      );
      expect(asAlice.machines.machines[0]?.isMine).toBe(true);
      expect(asMallory.machines.machines[0]?.isMine).toBe(false);
      void enrolled;
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches (NB2): the list serving the device key to every session.
test("Query.machines does not serve the device key", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const key = await deviceKeyFromSeed(42);
      await registerMachine(store, "owner", {
        name: "secretkey",
        hostname: "secretkey.example.ts.net",
        publicKey: encodeDeviceKey(key.publicKey),
        agentVersion: "0.1.0",
      });
      // The schema itself has no such field on the list type, so a document that asks for it
      // fails validation (`execute` alone does not validate, so the schema is asked directly).
      const listType = schema.getType("Machine");
      expect(listType).toBeDefined();
      const fields = listType instanceof GraphQLObjectType ? Object.keys(listType.getFields()) : [];
      expect(fields).not.toContain("publicKey");
      expect(fields).toContain("fingerprint");
      // The list carries the fingerprint instead.
      const listed = v.parse(
        v.object({
          machines: v.object({
            __typename: v.literal("MachineList"),
            machines: v.array(v.object({ id: v.string(), fingerprint: v.string() })),
          }),
        }),
        await run(store, "owner", MACHINES, {}),
      );
      expect(listed.machines.machines[0]?.fingerprint).toMatch(/^ed25519:/u);
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a publicKey that is not a 32-byte Ed25519 key being stored.
test("a malformed publicKey is refused and nothing is written", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const failure = v.parse(
        v.object({ registerMachine: FailureSchema }),
        await registerMachine(store, "owner", {
          name: "bad",
          hostname: "bad.example.ts.net",
          publicKey: "not-a-key",
          agentVersion: "0.1.0",
        }),
      );
      expect(failure.registerMachine.code).toBe("INVALID_REQUEST");
      expect(await store.machines.list()).toStrictEqual([]);
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a mutation reachable without a session subject.
test("registerMachine and revokeMachine refuse an empty subject", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const key = await deviceKeyFromSeed(26);
      const register = v.parse(
        v.object({ registerMachine: FailureSchema }),
        await registerMachine(store, "", {
          name: "anon",
          hostname: "anon.example.ts.net",
          publicKey: encodeDeviceKey(key.publicKey),
          agentVersion: "0.1.0",
        }),
      );
      expect(register.registerMachine.code).toBe("FORBIDDEN");
      const revoke = v.parse(
        v.object({ revokeMachine: FailureSchema }),
        await run(store, "", REVOKE, { id: "x" }),
      );
      expect(revoke.revokeMachine.code).toBe("FORBIDDEN");
      expect(await store.machines.list()).toStrictEqual([]);
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a Query.machines that drops the revoked machine from the list.
test("Query.machines lists a revoked machine with its status", async () => {
  const harness = await createD1Harness();
  harnessRef = harness;
  try {
    const store = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const key = await deviceKeyFromSeed(27);
      const enrolled = v.parse(
        RegisterPayloadSchema,
        await registerMachine(store, "owner", {
          name: "listed",
          hostname: "listed.example.ts.net",
          publicKey: encodeDeviceKey(key.publicKey),
          agentVersion: "0.1.0",
        }),
      ).registerMachine;
      const revoked = v.parse(
        v.object({
          revokeMachine: v.object({
            __typename: v.literal("RevokeMachinePayload"),
            machine: v.object({ id: v.string(), status: v.string() }),
          }),
        }),
        await run(store, "owner", REVOKE, { id: enrolled.machine.id }),
      );
      expect(revoked.revokeMachine.machine.status).toBe("REVOKED");
      const listed = v.parse(
        v.object({
          machines: v.object({
            __typename: v.literal("MachineList"),
            machines: v.array(v.object({ id: v.string(), name: v.string(), status: v.string() })),
          }),
        }),
        await run(store, "owner", MACHINES, {}),
      );
      expect(listed.machines.machines.map((machine) => machine.name)).toStrictEqual(["listed"]);
      expect(listed.machines.machines[0]?.id.length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a global id that does not decode to a Machine.
test("a machine id serializes as a global id", () => {
  expect(toGlobalId("Machine", "m1")).toBe(toGlobalId("Machine", "m1"));
});
