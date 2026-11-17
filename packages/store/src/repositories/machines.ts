/* oxlint-disable anti-slop/no-unknown-parameters --
   These functions are the DB boundary: they take an unknown row and parse it.
*/
import * as v from "valibot";
import {
  DEVICE_KEY_ALGORITHM,
  ED25519_PUBLIC_KEY_BYTES,
  IsoTimestampSchema,
  MACHINE_STATUSES,
  decodeDeviceKey,
  deviceKeyFingerprint,
  encodeDeviceKey,
  parseMachineEnrollment,
  type DeviceKeyFingerprint,
  type IsoTimestamp,
  type Machine,
  type MachineEnrollment,
  type MachineRegistration,
  type MachineRegistryRefusal,
  type MachineStatus,
} from "@hns/core";
import type { StoreContext } from "../db.ts";

/**
 * The machine registry: the D1 rows that say which machines exist, what device key each signs
 * with, and whether the Worker could reach it (0148, D087).
 *
 * @remarks
 * The registry is the **only** place a device key is read for verification: the Workspace object
 * asks {@link MachineRepository.deviceKey} when a machine signs a request, and gets `undefined`
 * for a machine that has no row, is revoked, or whose stored key is malformed. A missing key is
 * the fail-closed answer, so revocation takes effect on the next request without a second list
 * to keep correct.
 *
 * **Every writing method is one D1 batch** (the row change and its event together), because D1 has
 * no interactive transaction. Enrollment reads the existing row first to tell an enrollment from a
 * reimage; the unique `name` column is what keeps two concurrent enrollments from creating two
 * rows, and the loser sees the constraint rather than a second machine.
 *
 * There is no index (D049). A registry of a handful of machines is one table scan, and a list is
 * the read the operator asked for.
 */
export interface MachineRepository {
  /**
   * Every machine, oldest first.
   *
   * @remarks
   * A list is a D1 read, not a cached copy: a revoked machine is still listed (with its status),
   * because the operator needs to see it.
   */
  list(): Promise<readonly Machine[]>;
  /** The machine with this id, or undefined when D1 has no such row. */
  get(id: string): Promise<Machine | undefined>;
  /**
   * Register a machine, or replace its key as a reimage.
   *
   * @param enrollment - The name, hostname, device public key, and agent version to store.
   * @param actor - The session subject that asked; recorded in the event, never returned.
   * @returns A value: `enrolled` for a new row, `reimaged` (with the replaced fingerprint) for an
   * existing name, or one {@link MachineRegistryRefusal}.
   *
   * @remarks
   * **Same name, new key is a reimage** (D087 U-02): the key is replaced in the same row, so the
   * machine id (and every workspace that bound it) survives, and the old key stops verifying
   * immediately. The event row keeps the replaced fingerprint so the change is visible.
   *
   * **Same name, same key is idempotent**: a browser that retried a registration does not get a
   * second event, and nothing is written.
   *
   * **A revoked name is refused** with `revoked`, not `name_taken`: the caller learns that the
   * machine was revoked, and a reimaged machine must choose a new name.
   */
  enroll(
    enrollment: MachineEnrollment,
    actor: string,
  ): Promise<MachineRegistration | MachineRegistryRefusal>;
  /**
   * Revoke a machine.
   *
   * @param id - The machine to revoke.
   * @param actor - The session subject that asked; recorded in the event.
   * @returns The revoked machine, or undefined when no row has this id.
   *
   * @remarks
   * Revocation is terminal and immediate: the row's status becomes `revoked` and
   * {@link deviceKey} stops returning a key for it, so the machine's next signed request is
   * refused. Revoking an already revoked machine is a no-op (no second event), so a retried
   * mutation is safe.
   */
  revoke(id: string, actor: string): Promise<Machine | undefined>;
  /**
   * The device key a machine signs with, or undefined when it must not be trusted.
   *
   * @param id - The machine id from a signed request's `x-hns-machine` header.
   * @returns The raw 32-byte Ed25519 public key for an `online` or `offline` machine, and
   * `undefined` for a missing row, a revoked machine, or a row whose key is not a 32-byte blob.
   *
   * @remarks
   * This is the lookup the 0245 pack verification calls: a revoked or missing machine has no key,
   * and the caller refuses. The read answers `undefined` rather than throwing for a missing table
   * or a malformed row, because a key that cannot be established is not a key. The key and the
   * status are read in one statement, so a revoke between two reads cannot hand a revoked key out.
   */
  deviceKey(id: string): Promise<Uint8Array | undefined>;
  /**
   * Record what a reachability probe found.
   *
   * @param id - The machine probed.
   * @param observation - Whether it answered, and the clock the probe used (epoch milliseconds).
   * @returns Whether anything was written.
   *
   * @remarks
   * **Throttled write** (D087 U-03): the stored `last_seen` moves at most once per
   * {@link MACHINE_LAST_SEEN_THROTTLE_MS}. A probe that finds the same status and a
   * `last_seen` younger than the throttle writes nothing. This is the delayed write the issue
   * asks for: every list read may probe, but the registry writes at most a few times per minute.
   *
   * A revoked machine is never written: revocation does not become `online` by a probe.
   */
  recordProbe(id: string, observation: MachineProbeObservation): Promise<boolean>;
}

/** How often a probe may move the stored `last_seen`: once per 30 seconds (D087 U-03). */
export const MACHINE_LAST_SEEN_THROTTLE_MS = 30_000;

/**
 * What one reachability probe observed.
 *
 * @remarks
 * `at` is the probe's clock in epoch milliseconds; `reachable` is whether the machine answered.
 * The two are one observation: a probe that never reached the machine proves it was not seen.
 */
export interface MachineProbeObservation {
  readonly reachable: boolean;
  readonly at: number;
}

/**
 * A BLOB column's value, as the runtime hands it back.
 *
 * @remarks
 * D1 returns a blob as `ArrayBuffer`; miniflare's workerd returns the same bytes as a plain
 * number array for a `RETURNING` row. Both are the blob, so the boundary accepts either and the
 * public model always sees bytes.
 */
const BlobSchema = v.union([v.instance(ArrayBuffer), v.instance(Uint8Array), v.array(v.number())]);

/** A `machines` row, as stored. */
const MachineRowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  hostname: v.pipe(v.string(), v.minLength(1)),
  public_key: BlobSchema,
  key_algorithm: v.literal(DEVICE_KEY_ALGORITHM),
  agent_version: v.pipe(v.string(), v.minLength(1)),
  last_seen: v.nullable(v.pipe(v.number(), v.integer())),
  status: v.picklist(MACHINE_STATUSES),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/** A row with the key and the status, read together for the verification lookup. */
const KeyedStatusRowSchema = v.object({
  public_key: BlobSchema,
  status: v.picklist(MACHINE_STATUSES),
});

/** The row a probe reads before deciding whether to write. */
const ProbeRowSchema = v.object({
  status: v.picklist(MACHINE_STATUSES),
  last_seen: v.nullable(v.pipe(v.number(), v.integer())),
});

/**
 * Parse a stored row into the public {@link Machine}.
 *
 * @remarks
 * The key crosses to the model's base64url spelling here, and the fingerprint is computed from the
 * stored bytes: the row holds the bytes, the model holds the spelling a person compares. A key
 * that is not 32 bytes is a corrupt row and throws, so it can never reach a verifier as a
 * shortened key.
 */
async function parseMachine(row: unknown): Promise<Machine> {
  const parsed = v.parse(MachineRowSchema, row);
  const bytes = bytesOf(parsed.public_key);
  return {
    id: parsed.id,
    name: parsed.name,
    hostname: parsed.hostname,
    publicKey: encodeDeviceKey(bytes),
    keyAlgorithm: parsed.key_algorithm,
    fingerprint: await deviceKeyFingerprint(bytes),
    agentVersion: parsed.agent_version,
    lastSeen: parsed.last_seen,
    status: parsed.status,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

/** The bytes of a stored blob, whatever shape the runtime returned it in. */
function bytesOf(blob: ArrayBuffer | Uint8Array | readonly number[]): Uint8Array<ArrayBuffer> {
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob.slice(0));
  if (blob instanceof Uint8Array) return new Uint8Array(blob);
  return new Uint8Array(blob);
}

/** Whether a machine may hold a device key: everything but `revoked`. */
function holdsKey(status: MachineStatus): boolean {
  switch (status) {
    case "online":
    case "offline":
      return true;
    case "revoked":
      return false;
  }
}

/** Whether two device keys are the same bytes, compared in their model spelling. */
function sameKey(a: string, b: string): boolean {
  return a === b;
}

/** One event the registry records beside the change it explains. */
type MachineEventKind = "enrolled" | "reimaged" | "revoked";

/**
 * Build the machine repository over `context`.
 *
 * @internal
 */
export function machineRepository(context: StoreContext): MachineRepository {
  const { sql, now, newId } = context;

  /** The event insert for one change; it runs in the same batch as the change. */
  const eventStatement = (
    machineId: string,
    name: string,
    kind: MachineEventKind,
    actor: string,
    detail: string,
    at: IsoTimestamp,
  ) => ({
    sql:
      "INSERT INTO machine_events (id, machine_id, name, kind, actor, detail, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    params: [newId(), machineId, name, kind, actor, detail, at],
  });

  /** The key as the BLOB value D1 binds: the raw bytes, never the base64url spelling. */
  const keyBlob = (publicKey: string): ArrayBuffer => decodeDeviceKey(publicKey).buffer;

  const get = async (id: string): Promise<Machine | undefined> => {
    const row = await sql.get("SELECT * FROM machines WHERE id = ?", [id]);
    return row === undefined ? undefined : await parseMachine(row);
  };

  return {
    async list() {
      const rows = await sql.all("SELECT * FROM machines ORDER BY created_at, id");
      return await Promise.all(rows.map(async (row) => await parseMachine(row)));
    },
    get,
    async enroll(enrollment, actor) {
      const input = parseMachineEnrollment(enrollment);
      const at = now();
      const fingerprint = await deviceKeyFingerprint(decodeDeviceKey(input.publicKey));
      const existing = await sql.get("SELECT * FROM machines WHERE name = ?", [input.name]);
      if (existing === undefined) {
        const id = newId();
        const [rows] = await sql.batch([
          {
            sql:
              "INSERT INTO machines (id, name, hostname, public_key, key_algorithm, " +
              "agent_version, last_seen, status, created_at, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, NULL, 'offline', ?, ?) RETURNING *",
            params: [
              id,
              input.name,
              input.hostname,
              keyBlob(input.publicKey),
              DEVICE_KEY_ALGORITHM,
              input.agentVersion,
              at,
              at,
            ],
          },
          eventStatement(id, input.name, "enrolled", actor, fingerprint, at),
        ]);
        const created = await parseMachine(rows?.[0]);
        return { kind: "enrolled", machine: created };
      }
      const current = await parseMachine(existing);
      if (current.status === "revoked") return "revoked";
      if (sameKey(current.publicKey, input.publicKey))
        return { kind: "enrolled", machine: current };
      const replaced: DeviceKeyFingerprint = current.fingerprint;
      // Reimage: same row, same id, new key. `status` goes back to `offline` until probed, and
      // `last_seen` is cleared so the new key's first probe is what says the machine is up.
      const [rows] = await sql.batch([
        {
          sql:
            "UPDATE machines SET hostname = ?, public_key = ?, agent_version = ?, " +
            "last_seen = NULL, status = 'offline', updated_at = ? WHERE id = ? RETURNING *",
          params: [input.hostname, keyBlob(input.publicKey), input.agentVersion, at, current.id],
        },
        eventStatement(current.id, current.name, "reimaged", actor, replaced, at),
      ]);
      const machine = await parseMachine(rows?.[0]);
      return { kind: "reimaged", machine, previousFingerprint: replaced };
    },
    async revoke(id, actor) {
      const at = now();
      const current = await get(id);
      if (current === undefined) return undefined;
      if (current.status === "revoked") return current;
      const [rows] = await sql.batch([
        {
          sql: "UPDATE machines SET status = 'revoked', updated_at = ? WHERE id = ? RETURNING *",
          params: [at, id],
        },
        eventStatement(current.id, current.name, "revoked", actor, "", at),
      ]);
      return await parseMachine(rows?.[0]);
    },
    async deviceKey(id) {
      let row: unknown;
      try {
        // One statement sees one version of the row, so a revoke between two reads cannot hand a
        // revoked key out.
        row = await sql.get("SELECT public_key, status FROM machines WHERE id = ?", [id]);
      } catch {
        // A database without the table has no key, which the caller treats as a refusal.
        return undefined;
      }
      if (row === undefined) return undefined;
      const keyed = v.safeParse(KeyedStatusRowSchema, row);
      if (!keyed.success || !holdsKey(keyed.output.status)) return undefined;
      const bytes = bytesOf(keyed.output.public_key);
      return bytes.byteLength === ED25519_PUBLIC_KEY_BYTES ? bytes : undefined;
    },
    async recordProbe(id, observation) {
      const row = await sql.get("SELECT status, last_seen FROM machines WHERE id = ?", [id]);
      if (row === undefined) return false;
      const probe = v.parse(ProbeRowSchema, row);
      if (probe.status === "revoked") return false;
      const next: MachineStatus = observation.reachable ? "online" : "offline";
      const movedLastSeen =
        observation.reachable &&
        (probe.last_seen === null ||
          observation.at - probe.last_seen >= MACHINE_LAST_SEEN_THROTTLE_MS);
      // A probe that neither changes the status nor may move `last_seen` writes nothing: this is
      // the delayed write the throttle exists for.
      if (probe.status === next && !movedLastSeen) return false;
      const updated = await sql.run(
        "UPDATE machines SET status = ?, last_seen = COALESCE(?, last_seen), updated_at = ? " +
          "WHERE id = ? AND status <> 'revoked'",
        [next, movedLastSeen ? observation.at : null, now(), id],
      );
      return updated > 0;
    },
  };
}
