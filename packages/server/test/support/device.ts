import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { signatureMessage } from "@hns/core";

/**
 * The machine's device key, for tests: one key pair per test, WebCrypto for the signing.
 *
 * @remarks
 * The machine signs its own requests with its device key (D100): the private half stays on the
 * machine, the public half is what enrollment stores. These helpers stand in for both halves so
 * a test signs exactly what the machine signs and the Worker verifies with `crypto.subtle`.
 * The key is derived from a seed with `node:crypto` (a test may use it; the Worker may not).
 */

/**
 * The header a machine adds beside the signature, naming the bytes it signed.
 *
 * @remarks
 * `signatureMessage` carries the body hash, but the Worker never sees the body the machine
 * verified: the machine forwards the pack. It repeats the hash here, and the Worker recomputes
 * the hash from the bytes it received and refuses a disagreement. The header is not signed; the
 * bytes are.
 */
export const BODY_HASH_HEADER = "x-hns-body-hash";

/** One device key pair. */
export interface TestDeviceKey {
  readonly privateKey: CryptoKey;
  /** The raw 32-byte Ed25519 public key, the form `machines.public_key` stores. */
  readonly publicKey: Uint8Array;
}

/** The raw public bytes of an Ed25519 private key, through its SPKI form (12-byte prefix). */
function rawPublicOf(privateKey: ReturnType<typeof createPrivateKey>): Uint8Array {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(12, 44));
}

/**
 * Make one device key pair.
 *
 * @param seed - A distinct value per test; the same seed is the same key.
 * @returns The signing key WebCrypto accepts and the raw public half.
 */
export async function deviceKeyFromSeed(seed: number): Promise<TestDeviceKey> {
  const raw = new Uint8Array(32).fill(seed);
  const der = new Uint8Array(16 + raw.byteLength);
  der.set([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  der.set(raw, 16);
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, [
    "sign",
  ]);
  const nodeKey = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: rawPublicOf(nodeKey) };
}

/** What one signed request needs beyond its key. */
export interface DeviceSignInput {
  readonly machineId: string;
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
  readonly connection?: string | undefined;
  readonly seq?: string | undefined;
  readonly timestamp?: string | undefined;
  readonly nonce?: string | undefined;
}

/**
 * Sign one machine request, the way the machine's agent does.
 *
 * @param input - The fields the signature covers.
 * @param key - The device key pair.
 * @returns The signed headers, the repeated body hash included.
 */
export async function signDeviceHeaders(
  input: DeviceSignInput,
  key: TestDeviceKey,
): Promise<Record<string, string>> {
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const message = {
    machineId: input.machineId,
    connection: input.connection ?? "machine-conn",
    seq: input.seq ?? "1",
    timestamp: input.timestamp ?? String(Date.now()),
    nonce: input.nonce ?? crypto.randomUUID(),
    method: input.method,
    path: input.path,
    bodyHash,
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, signatureMessage(message)),
  );
  return {
    "x-hns-machine": message.machineId,
    "x-hns-connection": message.connection,
    "x-hns-seq": message.seq,
    "x-hns-timestamp": message.timestamp,
    "x-hns-nonce": message.nonce,
    "x-hns-signature": Buffer.from(signature).toString("base64url"),
    [BODY_HASH_HEADER]: bodyHash,
    "x-hns-message": JSON.stringify(message),
  };
}

/** The sha256 of some bytes, in hex: the spelling the tests compare against. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
