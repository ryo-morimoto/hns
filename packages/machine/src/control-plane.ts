import { createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { MachineRefusal } from "./refusal.ts";

/** Bytes in a raw Ed25519 public key. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Where the machine finds the control-plane public keys it verifies inbound
 * requests with.
 *
 * @remarks
 * The control plane signs every Worker-to-machine request with its own Ed25519
 * key; the machine never holds that private half. The public half reaches the
 * machine when it enrolls, and the machine keeps every key it was given so a
 * rotation can list the old and the new one side by side. The machine's device
 * key is a different key for the other direction (machine to Worker) and is not
 * part of this list.
 */
export interface ControlPlaneKeys {
  /**
   * The control-plane public keys trusted right now.
   *
   * @returns The raw 32-byte keys. Empty means the machine has not enrolled or
   * every key was revoked, and every request is refused.
   */
  publicKeys(): Promise<readonly Uint8Array[]>;
}

/** RFC 8410 SubjectPublicKeyInfo prefix for an Ed25519 key: the 12 bytes before the 32 key bytes. */
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Turn the raw key bytes a control-plane enrollment holds into a verification key.
 *
 * @param raw - The 32-byte Ed25519 public key.
 * @returns A key Node can verify with.
 * @throws {MachineRefusal} With code `unauthorized` when `raw` is not exactly
 * 32 bytes or is not an Ed25519 key: a corrupt enrolled key must refuse the
 * request instead of verifying against something else.
 */
export function verificationKey(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new MachineRefusal("unauthorized", "an enrolled key is not an Ed25519 key");
  }
  const der = new Uint8Array(SPKI_PREFIX.byteLength + raw.byteLength);
  der.set(SPKI_PREFIX);
  der.set(raw, SPKI_PREFIX.byteLength);
  const key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new MachineRefusal("unauthorized", "an enrolled key is not an Ed25519 key");
  }
  return key;
}
