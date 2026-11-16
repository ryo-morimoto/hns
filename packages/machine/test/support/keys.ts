import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { MachineKeyRegistry } from "../../src/index.ts";

/** One machine identity: the private half the machine keeps, the public half D1 holds. */
export interface MachineKeys {
  readonly machineId: string;
  /** The device key, which lives on the machine with mode 0600 in production. */
  readonly privateKey: KeyObject;
  /** The 32 raw bytes a D1 Machine record stores. */
  readonly publicKey: Uint8Array;
  /** A registry that answers with this machine's public key. */
  readonly registry: MachineKeyRegistry;
}

/** The raw SPKI tail of an Ed25519 key: the 12-byte prefix is stripped. */
const rawPublicKey = (key: KeyObject): Uint8Array => {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(12));
};

/**
 * Make an in-memory machine identity, standing in for the D1 Machine record.
 *
 * @param machineId - The id the agent and the record share.
 * @returns The key pair, its raw public half, and a registry that serves it.
 */
export function generateMachineKeys(machineId: string = randomUUID()): MachineKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = rawPublicKey(publicKey);
  return {
    machineId,
    privateKey,
    publicKey: raw,
    registry: {
      publicKey: async (id: string) => (id === machineId ? raw : undefined),
    },
  };
}
