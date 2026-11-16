import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { signatureMessage } from "../../src/index.ts";
import type { ControlPlaneKeys, RequestSignature } from "../../src/index.ts";

/** One control-plane key: the Worker keeps the private half, the machine enrolls the public half. */
export interface ControlPlaneKeyPair {
  readonly privateKey: KeyObject;
  /** The 32 raw bytes the machine receives at enrollment. */
  readonly publicKey: Uint8Array;
}

/** The raw SPKI tail of an Ed25519 key: the 12-byte prefix is stripped. */
const rawPublicKey = (key: KeyObject): Uint8Array => {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(12));
};

/**
 * Make a control-plane key pair, standing in for the key the Worker signs with.
 *
 * @returns The private half (to sign in a test) and the raw public half (to enroll).
 */
export function generateControlPlaneKey(): ControlPlaneKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: rawPublicKey(publicKey) };
}

/**
 * A registry that serves the given public keys, as the machine's enrollment would.
 *
 * @param pairs - The key pairs the control plane currently trusts; several in a rotation.
 * @returns A source whose `publicKeys` answers with the public halves.
 */
export function controlPlaneKeys(pairs: readonly ControlPlaneKeyPair[]): ControlPlaneKeys {
  const keys = pairs.map((pair) => pair.publicKey);
  return {
    publicKeys: async () => keys,
  };
}

/**
 * Sign one request the way the control plane would.
 *
 * @param input - The fields the signature covers.
 * @param privateKey - The control-plane private key.
 * @returns The base64url signature the header carries.
 */
export function signRequest(input: RequestSignature, privateKey: KeyObject): string {
  return sign(null, signatureMessage(input), privateKey).toString("base64url");
}
