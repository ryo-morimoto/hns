import { createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { MachineRefusal } from "./refusal.ts";

/** Bytes in a raw Ed25519 public key. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Where the agent finds the public key of the machine record.
 *
 * @remarks
 * 0148 supplies this from the D1 Machine record; tests supply a fixture, so the
 * agent is written against the interface instead of a database that does not
 * exist yet. The key is the public half of the device key whose private half
 * stays on the machine (mode 0600, never in Cloudflare).
 */
export interface MachineKeyRegistry {
  /**
   * The registered Ed25519 public key for a machine.
   *
   * @param machineId - The machine the agent runs for.
   * @returns The raw 32 key bytes, or undefined when the machine is not
   * registered or its key was revoked.
   */
  publicKey(machineId: string): Promise<Uint8Array | undefined>;
}

/** RFC 8410 SubjectPublicKeyInfo prefix for an Ed25519 key: the 12 bytes before the 32 key bytes. */
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Turn the raw key bytes a Machine record holds into a verification key.
 *
 * @param raw - The 32-byte Ed25519 public key.
 * @returns A key Node can verify with.
 * @throws {MachineRefusal} With code `unauthorized` when `raw` is not exactly
 * 32 bytes or is not an Ed25519 key: a corrupt Machine record must refuse the
 * request instead of verifying against something else.
 */
export function verificationKey(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new MachineRefusal("unauthorized", "the machine record's key is not an Ed25519 key");
  }
  const der = new Uint8Array(SPKI_PREFIX.byteLength + raw.byteLength);
  der.set(SPKI_PREFIX);
  der.set(raw, SPKI_PREFIX.byteLength);
  const key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new MachineRefusal("unauthorized", "the machine record's key is not an Ed25519 key");
  }
  return key;
}
