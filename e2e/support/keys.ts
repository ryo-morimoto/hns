import { createPrivateKey, createPublicKey } from "node:crypto";

export const CONTROL_PLANE_SEED_B64 = Buffer.from(new Uint8Array(32).fill(23)).toString("base64url");

/**
 * The Ed25519 control-plane keys the journey's machine trusts.
 *
 * @returns The `ControlPlaneKeys` shape the machine takes: a promise of the raw keys.
 *
 * @remarks
 * The edge signs with the seed ({@link CONTROL_PLANE_SEED_B64}); the machine verifies with the
 * public half derived from the same seed here, so the two are one pair by construction. The
 * private key is built from the seed exactly as the edge's signer builds it (PKCS#8, DER).
 */
export function journeyKeys(): { publicKeys(): Promise<readonly Uint8Array[]> } {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([prefix, Buffer.from(CONTROL_PLANE_SEED_B64, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  // The RFC 8410 SubjectPublicKeyInfo is 12 bytes of prefix and the 32 key bytes.
  const raw = new Uint8Array(spki.subarray(12));
  return { publicKeys: async () => [raw] };
}