import { signatureMessage, type RequestSignature } from "@hns/core";
import type { SignedHeaders } from "./agent-wire.ts";

/**
 * The machine-to-Worker request signature, verified with the machine's device key.
 *
 * @remarks
 * The machine's own requests to the Worker (a checkpoint pack is the first) are signed with the
 * device key whose public half enrollment stores for the machine (D100). The message is the same
 * one {@link signatureMessage} defines for the other direction (version, machine id, connection,
 * seq, timestamp, nonce, method, path, and the sha256 of the body in hex), so one contract covers
 * both hops. What differs is only which key signs and who holds the public half.
 *
 * The module is WebCrypto only: it runs in the Worker, where `node:crypto` is not the platform's
 * key API. An Ed25519 public key imports from its raw 32 bytes through the fixed RFC 8410 prefix.
 */

/**
 * The device-key header that names the bytes a machine signed.
 *
 * @remarks
 * The machine signs the pack's sha256 as `bodyHash` and its inbound verifier checks it. When the
 * machine then forwards the pack over HTTP with that same signature, the Worker does not see the
 * original body; the machine repeats the hash it verified in this header. The Worker recomputes
 * the hash from the bytes it received and refuses a disagreement, so the header is a claim the
 * Worker checks, never one it trusts. It is not signed for that reason: the bytes are.
 */
export const BODY_HASH_HEADER = "x-hns-body-hash";

/** Bytes in a raw Ed25519 public key, the form enrollment stores. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/** RFC 8410 SubjectPublicKeyInfo prefix for an Ed25519 key: the 12 bytes before the 32 key bytes. */
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * The sha256 of some bytes, in lowercase hex.
 *
 * @param bytes - The bytes to hash.
 * @returns 64 hex characters, the spelling `signatureMessage` carries as `bodyHash`.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Decode base64url into bytes; throws when the text is not base64url. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Import a device public key for verification.
 *
 * @param raw - The raw 32-byte Ed25519 public key enrollment stored for the machine.
 * @returns A key `crypto.subtle.verify` accepts.
 * @throws Error when `raw` is not 32 bytes or the runtime cannot import it.
 *
 * @remarks
 * A key that cannot be imported is a refusal for the caller, never a verification against
 * something else.
 */
async function deviceVerificationKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error("a device key is not a 32-byte Ed25519 key");
  }
  const der = new Uint8Array(SPKI_PREFIX.byteLength + raw.byteLength);
  der.set(SPKI_PREFIX);
  der.set(raw, SPKI_PREFIX.byteLength);
  return await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
}

/**
 * The fields a machine-signed request signs, with the body hash computed here.
 *
 * @param input - The headers, the method, the path, and the bytes that arrived.
 * @returns The message and the signature bytes.
 *
 * @remarks
 * `bodyHash` is recomputed from `body` on every call, never read from {@link BODY_HASH_HEADER}:
 * the signature is checked against the bytes the caller holds, so a header changed in transit
 * cannot move the check to different bytes.
 */
async function signedRequest(input: {
  readonly headers: SignedHeaders;
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
}): Promise<{ readonly message: RequestSignature; readonly signature: Uint8Array<ArrayBuffer> }> {
  const message: RequestSignature = {
    machineId: input.headers.machineId,
    connection: input.headers.connection,
    seq: input.headers.seq,
    timestamp: input.headers.timestamp,
    nonce: input.headers.nonce,
    method: input.method,
    path: input.path,
    bodyHash: await sha256Hex(input.body),
  };
  return { message, signature: fromBase64Url(input.headers.signature) };
}

/**
 * Verify one machine-signed request against the machine's enrolled device key.
 *
 * @param input - The signed headers, the method, the path, and the bytes that arrived.
 * @param publicKey - The machine's enrolled Ed25519 public key (raw 32 bytes).
 * @returns True only when the signature is 64 bytes and verifies over the recomputed message.
 *
 * @remarks
 * `content-type` and `content-length` are outside the message (the machine's contract says so),
 * so the caller compares them with the body separately. A malformed signature, a key that cannot
 * be imported, or a failing verification are all false, never a throw: a caller cannot tell them
 * apart and refuses the same way.
 */
export async function verifyDeviceRequest(
  input: {
    readonly headers: SignedHeaders;
    readonly method: string;
    readonly path: string;
    readonly body: Uint8Array;
  },
  publicKey: Uint8Array,
): Promise<boolean> {
  let signed: Awaited<ReturnType<typeof signedRequest>>;
  try {
    signed = await signedRequest(input);
  } catch {
    return false;
  }
  if (signed.signature.byteLength !== 64) return false;
  let key: CryptoKey;
  try {
    key = await deviceVerificationKey(publicKey);
  } catch {
    return false;
  }
  return await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signed.signature,
    signatureMessage(signed.message),
  );
}
