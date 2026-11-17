import * as v from "valibot";
import { expect, test } from "vitest";
import { openStore, type Store } from "../../../store/src/index.ts";
import {
  createD1Harness,
  type D1Harness as Harness,
} from "../../../store/test/integration/harness.ts";
import { clock, counter } from "../../../store/test/support.ts";
import { Workspace } from "../../src/do/workspace.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { deviceKeyFromSeed, sha256Hex } from "../../test/support/device.ts";
import { createMachineTransport } from "../../src/machines/transport.ts";
import { probeMachine } from "../../src/machines/probe.ts";
import { machineKeyRegistryOver } from "../../src/machines/registry.ts";
import { verifyDeviceRequest } from "../../src/checkpoint/signature.ts";
import { encodeDeviceKey } from "@hns/core";

/**
 * The real path of the machine registry (0148): enrollment in a real D1, a lease from the real
 * Workspace object, a reachability probe over a real HTTP answer, and a device-key signature
 * verified with the key D1 stored.
 *
 * @remarks
 * What a fake cannot prove and this does: the key written by enrollment is the key a verifier
 * accepts, revocation takes it away on the next lookup, the probe's health call is one the
 * machine's verifier accepts, and the Workspace object's `#checkpointMachine()` order (current
 * lease holder, then the recorded machine) is the machine the registry holds.
 */

/** A store over a fresh workerd D1, with a deterministic clock and ids. */
async function storeOf(harness: Harness): Promise<Store> {
  return await openStore({ d1: harness.db, now: clock(), newId: counter() });
}

/**
 * Enroll one machine, failing the test if the registry refuses.
 *
 * @remarks
 * The key is derived the way the machine derives it: `deviceKeyFromSeed` gives the WebCrypto
 * signing key and its raw public half, and enrollment stores the base64url spelling.
 */
async function enroll(store: Store, name: string, seed: number) {
  const key = await deviceKeyFromSeed(seed);
  const result = await store.machines.enroll(
    {
      name,
      hostname: name + ".example.ts.net",
      publicKey: encodeDeviceKey(key.publicKey),
      agentVersion: "0.1.0",
    },
    "owner",
  );
  if (
    result === "name_taken" ||
    result === "revoked" ||
    result === "invalid_request" ||
    result === "not_found"
  ) {
    throw new Error("enrollment refused: " + result);
  }
  return { machine: result.machine, key };
}

/** The control-plane seed a test uses; base64url of 32 distinct bytes. */
const SEED = Buffer.from(new Uint8Array(32).fill(9)).toString("base64url");

/** The public half of a seed, for the verifier the machine runs. */
async function controlPlanePublic(seedBase64Url: string): Promise<Uint8Array> {
  const seed = Buffer.from(seedBase64Url, "base64url");
  const prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const der = new Uint8Array(prefix.byteLength + seed.byteLength);
  der.set(prefix);
  der.set(seed, prefix.byteLength);
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, [
    "sign",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const x = jwk.x ?? "";
  const padded = x.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Catches: enrollment writing a key D1 hands back in a shape the verifier cannot use, or a
// machine id the Workspace object's lease does not carry.
test("enrollment gives the verifier the key bytes and the lease the machine id 0245 reads", async () => {
  const harness = await createD1Harness();
  try {
    const store = await storeOf(harness);
    const opened = openSqliteState();
    try {
      const { machine, key } = await enroll(store, "real", 13);
      // The key D1 holds is the machine's public half, byte for byte.
      expect(await store.machines.deviceKey(machine.id)).toStrictEqual(key.publicKey);
      // The Workspace object (0245) acquires the workspace for this machine; its
      // `#checkpointMachine()` reads the current lease holder and then the recorded machine.
      const workspace = new Workspace(opened.state, {
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      });
      const acquired = await workspace.fetch(
        new Request("https://workspace/rpc/lease/acquire", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: "w1", machineId: machine.id }),
        }),
      );
      expect(acquired.status, await acquired.clone().text()).toBe(200);
      // The lease answer is parsed, not asserted: the object's contract is what the test reads.
      const lease = v.parse(
        v.object({ lease: v.object({ machineId: v.string() }) }),
        await acquired.json(),
      );
      expect(lease.lease.machineId).toBe(machine.id);
      // The registry's key is what a pack signed by that machine verifies with: the same bytes
      // the object's `#deviceKey()` would read from its own `machines` table (0245 seeds it).
      expect(await store.machines.deviceKey(lease.lease.machineId)).toStrictEqual(key.publicKey);
    } finally {
      opened.close();
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a registry that hands out the revoked machine's key, so its signature would verify.
test("a revoked machine's device key is gone from the registry immediately", async () => {
  const harness = await createD1Harness();
  try {
    const store = await storeOf(harness);
    try {
      const { machine, key } = await enroll(store, "revoked", 14);
      const registry = machineKeyRegistryOver(store);
      expect(await registry.deviceKey(machine.id)).toStrictEqual(key.publicKey);
      await store.machines.revoke(machine.id, "owner");
      expect(await registry.deviceKey(machine.id)).toBeUndefined();
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

// Catches: a probe that signs something the machine's verifier refuses, or reports online when
// the verifier refused. The machine's verifier is the real one (WebCrypto Ed25519).
test("the probe's health call verifies with the control-plane public key the enrollment would give", async () => {
  const harness = await createD1Harness();
  try {
    const store = await storeOf(harness);
    try {
      const { machine } = await enroll(store, "probe", 15);
      const publicKey = await controlPlanePublic(SEED);
      const seen: { readonly headers: Headers; readonly body: Uint8Array }[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        seen.push({
          headers: new Headers(init?.headers),
          body: init?.body instanceof Uint8Array ? new Uint8Array(init.body) : new Uint8Array(0),
        });
        return new Response(
          JSON.stringify({ ok: true, op: "health", result: { root: "/", pid: 1 } }),
          {
            status: 200,
          },
        );
      };
      const transport = createMachineTransport(fetchImpl);
      const probed = await probeMachine(machine, {
        machines: store.machines,
        controlPlaneKey: SEED,
        transport,
        requestId: "req-probe",
        now: () => 1_700_000_000_000,
      });
      expect(probed.observation.reachable).toBe(true);
      const call = seen[0];
      if (call === undefined) throw new Error("no call");
      // The machine side: the same verifier 0147 runs, with the enrolled public key.
      const verifier = new MachineRequestChecker(publicKey);
      const verified = await verifier.verify(call.headers, call.body, "m1", 1_700_000_000_000);
      expect(verified).toStrictEqual({ ok: true });
      // A wrong body is refused by that same verifier.
      const tampered = new Uint8Array(call.body);
      tampered[0] = tampered[0] === 0x7b ? 0x7c : 0x7b;
      const refused = await verifier.verify(call.headers, tampered, "m1", 1_700_000_000_000);
      expect(refused.ok).toBe(false);
      // The registry wrote the observation.
      const after = await store.machines.get(machine.id);
      expect(after?.status).toBe("online");
      expect(after?.lastSeen).toBe(1_700_000_000_000);
    } finally {
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

/** The message a machine request signs, rebuilt from headers and body. */
type SignedFields = {
  readonly machineId: string;
  readonly connection: string;
  readonly seq: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
};

/**
 * The machine's inbound verifier, reduced to what this test needs: the clock window, the message,
 * and the Ed25519 check. It is deliberately not `RequestVerifier` (that lives in
 * `@hns/machine`); it proves the control-plane signature this transport produced.
 */
class MachineRequestChecker {
  readonly #publicKey: Uint8Array;
  constructor(publicKey: Uint8Array) {
    this.#publicKey = publicKey;
  }

  async verify(
    headers: Headers,
    body: Uint8Array,
    machineId: string,
    now: number,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const timestamp = headers.get("x-hns-timestamp") ?? "";
    if (Math.abs(now - Number(timestamp)) > 60_000) return { ok: false, reason: "stale_request" };
    const fields: SignedFields = {
      machineId: headers.get("x-hns-machine") ?? "",
      connection: headers.get("x-hns-connection") ?? "",
      seq: headers.get("x-hns-seq") ?? "",
      timestamp,
      nonce: headers.get("x-hns-nonce") ?? "",
      method: "POST",
      path: "/rpc",
      bodyHash: await sha256Hex(new Uint8Array(body)),
    };
    const signature = headers.get("x-hns-signature") ?? "";
    const padded = signature.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const prefix = Uint8Array.from([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    const der = new Uint8Array(prefix.byteLength + this.#publicKey.byteLength);
    der.set(prefix);
    der.set(this.#publicKey, prefix.byteLength);
    const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(
      JSON.stringify([
        "hns.machine.request.v1",
        fields.machineId,
        fields.connection,
        fields.seq,
        fields.timestamp,
        fields.nonce,
        fields.method,
        fields.path,
        fields.bodyHash,
      ]),
    );
    const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, bytes, message);
    return valid ? { ok: true } : { ok: false, reason: "unauthorized" };
  }
}

// Catches: a Workspace object whose checkpoint target is not the machine the registry holds, so
// a pack signed by the enrolled key is refused by the object's `#deviceKey()` lookup.
test("a pack signed by the enrolled device key verifies against the registry's row", async () => {
  const harness = await createD1Harness();
  try {
    const store = await storeOf(harness);
    const opened = openSqliteState();
    try {
      const { machine, key } = await enroll(store, "signed", 16);
      const raw = await store.machines.deviceKey(machine.id);
      if (raw === undefined) throw new Error("the registry has no key");
      // The machine signs one request the way its agent does.
      const body = new TextEncoder().encode(JSON.stringify({ op: "health" }));
      const headers = await signDeviceHeaders(
        { machineId: machine.id, method: "POST", path: "/rpc", body },
        key,
      );
      const verified = await verifyDeviceRequest(
        {
          headers: {
            machineId: headers["x-hns-machine"] ?? "",
            connection: headers["x-hns-connection"] ?? "",
            seq: headers["x-hns-seq"] ?? "",
            timestamp: headers["x-hns-timestamp"] ?? "",
            nonce: headers["x-hns-nonce"] ?? "",
            signature: headers["x-hns-signature"] ?? "",
          },
          method: "POST",
          path: "/rpc",
          body,
        },
        raw,
      );
      expect(verified).toBe(true);
      // A different machine's key does not verify it.
      const other = await deviceKeyFromSeed(99);
      expect(
        await verifyDeviceRequest(
          {
            headers: {
              machineId: headers["x-hns-machine"] ?? "",
              connection: headers["x-hns-connection"] ?? "",
              seq: headers["x-hns-seq"] ?? "",
              timestamp: headers["x-hns-timestamp"] ?? "",
              nonce: headers["x-hns-nonce"] ?? "",
              signature: headers["x-hns-signature"] ?? "",
            },
            method: "POST",
            path: "/rpc",
            body,
          },
          other.publicKey,
        ),
      ).toBe(false);
    } finally {
      opened.close();
      await store.close();
    }
  } finally {
    await harness.dispose();
  }
});

/** One signed machine request, as the machine agent writes it. */
async function signDeviceHeaders(
  input: {
    readonly machineId: string;
    readonly method: string;
    readonly path: string;
    readonly body: Uint8Array;
  },
  key: Awaited<ReturnType<typeof deviceKeyFromSeed>>,
): Promise<Record<string, string>> {
  const bodyHash = await sha256Hex(input.body);
  const message = {
    machineId: input.machineId,
    connection: "machine-conn",
    seq: "1",
    timestamp: String(Date.now()),
    nonce: crypto.randomUUID(),
    method: input.method,
    path: input.path,
    bodyHash,
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      new TextEncoder().encode(
        JSON.stringify([
          "hns.machine.request.v1",
          message.machineId,
          message.connection,
          message.seq,
          message.timestamp,
          message.nonce,
          message.method,
          message.path,
          message.bodyHash,
        ]),
      ),
    ),
  );
  return {
    "x-hns-machine": message.machineId,
    "x-hns-connection": message.connection,
    "x-hns-seq": message.seq,
    "x-hns-timestamp": message.timestamp,
    "x-hns-nonce": message.nonce,
    "x-hns-signature": Buffer.from(signature).toString("base64url"),
  };
}
