import { expect, test } from "vitest";
import {
  DeviceKeyFingerprintSchema,
  MACHINE_STATUSES,
  decodeDeviceKey,
  deviceKeyFingerprint,
  encodeDeviceKey,
} from "@hns/core";
import { createD1Harness, type D1Harness } from "../harness.ts";
import { createSql } from "../../../src/sql.ts";
import { openStore } from "../../../src/store.ts";
import { clock, counter } from "../../support.ts";
import * as v from "valibot";
import { afterAll, beforeAll } from "vitest";

/**
 * Read rows straight from D1, outside the store, parsing each one with `schema`.
 *
 * @remarks
 * The store is closed for these reads: the test asks the database what it actually holds, not
 * what a repository says. The schema is the read's own contract, so nothing leaves as `unknown`.
 */
async function query<T>(
  schema: v.GenericSchema<unknown, T>,
  sqlText: string,
  params: readonly (string | number | null | ArrayBuffer)[] = [],
): Promise<readonly T[]> {
  const sql = createSql(harness.db);
  try {
    return (await sql.all(sqlText, params)).map((row) => v.parse(schema, row));
  } finally {
    await sql.close();
  }
}

/**
 * The machine registry over the real D1 SQLite (0148 / D087).
 *
 * @remarks
 * The unit suite proves the model and the port; this suite proves the **SQL and the storage
 * boundary**: one row per name, the device key as a 32-byte BLOB that comes back byte for byte,
 * revocation taking the key away, the reimage replacing the key on the same row, and the
 * reachability write being throttled. The key is a deterministic 32-byte seed, so the fingerprint
 * is comparable.
 */

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/** The columns the event assertion reads. */
const EventRowSchema = v.object({
  kind: v.picklist(["enrolled", "reimaged", "revoked", "reached"]),
  actor: v.string(),
  detail: v.string(),
});

/** One device key: the raw bytes and the model's base64url spelling. */
interface DeviceKey {
  readonly raw: Uint8Array;
  readonly text: string;
}

/** A distinct device key per case: 32 bytes of the seed, base64url. */
function deviceKey(seed: number): DeviceKey {
  const raw = new Uint8Array(32).fill(seed);
  return { raw, text: encodeDeviceKey(raw) };
}

const enrollment = (overrides: { readonly name?: string; readonly key?: DeviceKey } = {}) => ({
  name: overrides.name ?? "laptop",
  hostname: "laptop.example.ts.net",
  publicKey: (overrides.key ?? deviceKey(1)).text,
  agentVersion: "0.1.0",
});

// Catches: an enrollment that stores nothing, or stores the key in a shape the verifier cannot read.
test("an enrollment writes one row and the key comes back byte for byte", async () => {
  await harness.withStore(async (store) => {
    const key = deviceKey(1);
    const result = await store.machines.enroll(enrollment({ key }), "owner");
    expect(result).not.toBe("name_taken");
    expect(result).not.toBe("revoked");
    if (
      result === "name_taken" ||
      result === "revoked" ||
      result === "invalid_request" ||
      result === "not_found"
    ) {
      throw new Error("unexpected refusal: " + result);
    }
    expect(result.kind).toBe("enrolled");
    const machine = result.machine;
    expect(machine.name).toBe("laptop");
    expect(machine.status).toBe("offline");
    expect(machine.lastSeen).toBeNull();
    expect(machine.keyAlgorithm).toBe("ed25519");
    expect(machine.publicKey).toBe(key.text);
    expect(DeviceKeyFingerprintSchema).toBeTruthy();
    expect((await store.machines.list()).map((row) => row.name)).toStrictEqual(["laptop"]);
    const stored = await store.machines.deviceKey(machine.id);
    expect(stored).toStrictEqual(key.raw);
  });
});

// Catches: a fingerprint computed from the base64url spelling instead of the raw bytes.
test("the fingerprint is the raw key's SHA-256, not its spelling's", async () => {
  await harness.withStore(async (store) => {
    const key = deviceKey(2);
    const result = await store.machines.enroll(enrollment({ name: "fp", key }), "owner");
    if (
      result === "name_taken" ||
      result === "revoked" ||
      result === "invalid_request" ||
      result === "not_found"
    ) {
      throw new Error("unexpected refusal: " + result);
    }
    expect(result.machine.fingerprint).toBe(await deviceKeyFingerprint(key.raw));
    // The first 16 bytes of the digest are what a person compares: the same bytes give the same
    // fingerprint, and a different key's first 16 bytes are what the value names.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(key.raw)));
    const hex = [...digest.subarray(0, 16)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(result.machine.fingerprint).toBe("ed25519:" + hex);
  });
});

// Catches: a same-name reimage that keeps the old key or writes a second row.
test("a same-name enrollment with a new key is a reimage on the same row", async () => {
  await harness.withStore(async (store) => {
    const first = deviceKey(3);
    const second = deviceKey(4);
    const enrolled = await store.machines.enroll(enrollment({ name: "box", key: first }), "owner");
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    const reimaged = await store.machines.enroll(enrollment({ name: "box", key: second }), "owner");
    if (
      reimaged === "name_taken" ||
      reimaged === "revoked" ||
      reimaged === "invalid_request" ||
      reimaged === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    if (reimaged.kind !== "reimaged") throw new Error("a new key was not a reimage");
    expect(reimaged.machine.id).toBe(enrolled.machine.id);
    expect(reimaged.previousFingerprint).toBe(await deviceKeyFingerprint(first.raw));
    expect((await store.machines.list()).length).toBe(1);
    // The old key is gone: a verification against it has nothing to read.
    expect(await store.machines.deviceKey(enrolled.machine.id)).toStrictEqual(second.raw);
  });
});

// Catches (B1): another operator replacing a machine's key and taking over its id, workspaces,
// and probe hostname by reusing the victim's name.
test("only the operator who enrolled a machine may reimage it", async () => {
  await harness.withStore(async (store) => {
    const victimKey = deviceKey(30);
    const attackerKey = deviceKey(31);
    const enrolled = await store.machines.enroll(
      {
        name: "victim",
        hostname: "victim.example.ts.net",
        publicKey: victimKey.text,
        agentVersion: "0.1.0",
      },
      "alice",
    );
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    expect(enrolled.machine.owner).toBe("alice");
    const before = enrolled.machine;
    // mallory tries the same name with her own key and hostname: refused, nothing moves.
    expect(
      await store.machines.enroll(
        {
          name: "victim",
          hostname: "mallory.example.ts.net",
          publicKey: attackerKey.text,
          agentVersion: "0.1.0",
        },
        "mallory",
      ),
    ).toBe("name_taken");
    const after = await store.machines.get(before.id);
    expect(after?.publicKey).toBe(victimKey.text);
    expect(after?.hostname).toBe("victim.example.ts.net");
    expect(after?.owner).toBe("alice");
    expect(await store.machines.deviceKey(before.id)).toStrictEqual(victimKey.raw);
    // alice, the owner, can reimage.
    const reimaged = await store.machines.enroll(
      enrollment({ name: "victim", key: attackerKey }),
      "alice",
    );
    if (
      reimaged === "name_taken" ||
      reimaged === "revoked" ||
      reimaged === "invalid_request" ||
      reimaged === "not_found"
    ) {
      throw new Error("the owner was refused a reimage");
    }
    if (reimaged.kind !== "reimaged") throw new Error("a new key was not a reimage");
    expect(reimaged.machine.id).toBe(before.id);
    expect(await store.machines.deviceKey(before.id)).toStrictEqual(attackerKey.raw);
    // Exactly one enrollment event and one reimage event: mallory left no trace.
    const rows = await query(
      EventRowSchema,
      "SELECT kind, actor, detail FROM machine_events WHERE machine_id = ? ORDER BY rowid",
      [before.id],
    );
    expect(rows.map((row) => row.kind)).toStrictEqual(["enrolled", "reimaged"]);
    expect(rows.map((row) => row.actor)).toStrictEqual(["alice", "alice"]);
  });
});

// Catches (B1, concurrent): two enrollments of one name at once leave one row owned by the same
// operator, never two rows and never a row owned by neither.
test("two concurrent enrollments of one name leave one row", async () => {
  await harness.withStore(async (store) => {
    const keyA = deviceKey(50);
    const keyB = deviceKey(51);
    const keyC = deviceKey(52);
    const enrolled = await store.machines.enroll(
      {
        name: "raced",
        hostname: "raced.example.ts.net",
        publicKey: keyA.text,
        agentVersion: "0.1.0",
      },
      "alice",
    );
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    // The condition lives in the UPDATE, not only in the read before it: a row that changes owner
    // between alice's read and her write is not reimaged. Two stores race on one database.
    const second = await openStore({ d1: harness.db, now: clock(), newId: counter() });
    try {
      const [first, again] = await Promise.all([
        store.machines.enroll(
          {
            name: "raced",
            hostname: "raced.example.ts.net",
            publicKey: keyB.text,
            agentVersion: "0.1.0",
          },
          "alice",
        ),
        second.machines.enroll(
          {
            name: "raced",
            hostname: "raced.example.ts.net",
            publicKey: keyC.text,
            agentVersion: "0.1.0",
          },
          "alice",
        ),
      ]);
      // Both are alice, so whoever wins, the row stays alice's and exactly one key is stored.
      const after = await store.machines.get(enrolled.machine.id);
      expect(after?.owner).toBe("alice");
      expect([keyB.text, keyC.text]).toContain(after?.publicKey);
      expect([first, again].length).toBe(2);
    } finally {
      await second.close();
    }
  });
});

// Catches: a repeated enrollment writing a second event, or moving updated_at.
test("a same-name enrollment with the same key writes nothing", async () => {
  await harness.withStore(async (store) => {
    const key = deviceKey(5);
    const input = enrollment({ name: "idem", key });
    const first = await store.machines.enroll(input, "owner");
    if (
      first === "name_taken" ||
      first === "revoked" ||
      first === "invalid_request" ||
      first === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    const second = await store.machines.enroll(input, "owner");
    if (
      second === "name_taken" ||
      second === "revoked" ||
      second === "invalid_request" ||
      second === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    expect(second.kind).toBe("enrolled");
    expect(second.machine.updatedAt).toBe(first.machine.updatedAt);
    expect(second.machine.id).toBe(first.machine.id);
  });
});

// Catches: revocation that leaves the key readable, or a revoked name being enrolled again.
test("revocation takes the key away and the name cannot be enrolled again", async () => {
  await harness.withStore(async (store) => {
    const key = deviceKey(6);
    const enrolled = await store.machines.enroll(enrollment({ name: "gone", key }), "owner");
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    const revoked = await store.machines.revoke(enrolled.machine.id, "owner");
    expect(revoked?.status).toBe("revoked");
    expect(await store.machines.deviceKey(enrolled.machine.id)).toBeUndefined();
    // The list still shows it, with its status.
    expect((await store.machines.list()).map((row) => row.status)).toStrictEqual(["revoked"]);
    // The refused answer is `revoked`, not `name_taken`: the caller learns why.
    expect(
      await store.machines.enroll(enrollment({ name: "gone", key: deviceKey(7) }), "owner"),
    ).toBe("revoked");
    // Revoking twice is a no-op and answers the same row.
    expect((await store.machines.revoke(enrolled.machine.id, "owner"))?.status).toBe("revoked");
    expect(await store.machines.revoke("missing", "owner")).toBeUndefined();
  });
});

// Catches: a probe that writes on every read (the write amplification D087 throttles).
test("the reachability write is throttled and a failure does not move lastSeen", async () => {
  await harness.withStore(async (store) => {
    const key = deviceKey(8);
    const enrolled = await store.machines.enroll(enrollment({ name: "probe", key }), "owner");
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    const id = enrolled.machine.id;
    // The first successful probe writes online and a fresh lastSeen.
    expect(await store.machines.recordProbe(id, { reachable: true, at: 1_000_000 })).toBe(true);
    let machine = await store.machines.get(id);
    expect(machine?.status).toBe("online");
    expect(machine?.lastSeen).toBe(1_000_000);
    // Ten probes inside the throttle change neither status nor lastSeen.
    for (let index = 1; index <= 10; index += 1) {
      expect(
        await store.machines.recordProbe(id, { reachable: true, at: 1_000_000 + index * 1_000 }),
      ).toBe(false);
    }
    machine = await store.machines.get(id);
    expect(machine?.lastSeen).toBe(1_000_000);
    // Past the throttle the lastSeen moves again.
    expect(await store.machines.recordProbe(id, { reachable: true, at: 1_031_000 })).toBe(true);
    expect((await store.machines.get(id))?.lastSeen).toBe(1_031_000);
    // A failure flips the status offline and keeps the last time it was seen.
    expect(await store.machines.recordProbe(id, { reachable: false, at: 1_100_000 })).toBe(true);
    machine = await store.machines.get(id);
    expect(machine?.status).toBe("offline");
    expect(machine?.lastSeen).toBe(1_031_000);
  });
});

// Catches: a probe that brings a revoked machine back online.
test("a revoked machine is never written by a probe", async () => {
  await harness.withStore(async (store) => {
    const enrolled = await store.machines.enroll(
      enrollment({ name: "ghost", key: deviceKey(9) }),
      "owner",
    );
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    await store.machines.revoke(enrolled.machine.id, "owner");
    expect(
      await store.machines.recordProbe(enrolled.machine.id, { reachable: true, at: 2_000_000 }),
    ).toBe(false);
    const machine = await store.machines.get(enrolled.machine.id);
    expect(machine?.status).toBe("revoked");
    expect(machine?.lastSeen).toBeNull();
  });
});

// Catches: enrolling something that is not a 32-byte Ed25519 key.
test.each([
  ["a short key", Buffer.from(new Uint8Array(31).fill(1)).toString("base64url")],
  ["a long key", Buffer.from(new Uint8Array(33).fill(1)).toString("base64url")],
  ["a non-base64url value", "not-a-key"],
  ["an empty key", ""],
])("a device key that is not 32 base64url bytes is refused: %s", async (_label, publicKey) => {
  await harness.withStore(async (store) => {
    await expect(
      store.machines.enroll(
        { name: "bad", hostname: "bad.example.ts.net", publicKey, agentVersion: "0.1.0" },
        "owner",
      ),
    ).rejects.toThrow();
    expect(await store.machines.list()).toStrictEqual([]);
  });
});

// Catches: an event row missing from the change that made it, or an actor not recorded.
test("each change leaves one event naming the actor, and a reimage keeps the replaced fingerprint", async () => {
  await harness.withStore(async (store) => {
    const first = deviceKey(10);
    const second = deviceKey(11);
    const enrolled = await store.machines.enroll(
      enrollment({ name: "audit", key: first }),
      "owner",
    );
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    // The reimage is the enrolling operator's; a different actor is refused (B1) and leaves no
    // event, which the assertions below depend on.
    await store.machines.enroll(enrollment({ name: "audit", key: second }), "owner");
    await store.machines.revoke(enrolled.machine.id, "bob");
    const rows = await query(
      EventRowSchema,
      "SELECT kind, actor, detail FROM machine_events WHERE machine_id = ? ORDER BY rowid",
      [enrolled.machine.id],
    );
    expect(rows.map((row) => row.kind)).toStrictEqual(["enrolled", "reimaged", "revoked"]);
    expect(rows.map((row) => row.actor)).toStrictEqual(["owner", "owner", "bob"]);
    expect(rows[1]?.detail).toBe(await deviceKeyFingerprint(first.raw));
  });
});

// Catches: a deviceKey lookup that throws for a missing row or hands out a revoked key.
test("deviceKey answers undefined for an unknown machine and the stored bytes for a live one", async () => {
  await harness.withStore(async (store) => {
    expect(await store.machines.deviceKey("missing")).toBeUndefined();
    const key = deviceKey(12);
    const enrolled = await store.machines.enroll(enrollment({ name: "lookup", key }), "owner");
    if (
      enrolled === "name_taken" ||
      enrolled === "revoked" ||
      enrolled === "invalid_request" ||
      enrolled === "not_found"
    ) {
      throw new Error("unexpected refusal");
    }
    expect(await store.machines.deviceKey(enrolled.machine.id)).toStrictEqual(key.raw);
    // A stored row whose key is not 32 bytes is not handed to a verifier.
    const sql = createSql(harness.db);
    try {
      await sql.run("UPDATE machines SET public_key = ? WHERE id = ?", [
        new Uint8Array(8).buffer,
        enrolled.machine.id,
      ]);
    } finally {
      await sql.close();
    }
    expect(await store.machines.deviceKey(enrolled.machine.id)).toBeUndefined();
  });
});

// Catches: the base64url helpers disagreeing on the same bytes.
test("a device key round-trips through its spelling", () => {
  for (let seed = 0; seed < 4; seed += 1) {
    const raw = new Uint8Array(32).fill(seed * 37);
    expect(decodeDeviceKey(encodeDeviceKey(raw))).toStrictEqual(raw);
  }
});

// Catches: a status CHECK the model does not agree with.
test("the stored status vocabulary is the model's", async () => {
  await harness.withStore(async () => {
    const sql = createSql(harness.db);
    try {
      await expect(
        sql.run(
          "INSERT INTO machines (id, name, hostname, public_key, key_algorithm, agent_version, " +
            "status, created_at, updated_at) VALUES ('x','x','x.example.ts.net',?, 'ed25519','0', " +
            "'bogus','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
          [new Uint8Array(32).buffer],
        ),
      ).rejects.toThrow();
    } finally {
      await sql.close();
    }
    expect(MACHINE_STATUSES).toStrictEqual(["online", "offline", "revoked"]);
  });
});
