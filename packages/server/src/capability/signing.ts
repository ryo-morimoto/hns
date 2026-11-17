import { canonicalize, sha256Hex, signingInput } from "@hns/core/capability";
import * as v from "valibot";
import type { GrantAlgorithm, SignedGrant } from "@hns/core/capability";

/**
 * Signing a grant with the control-plane key (0224, D091).
 *
 * @remarks
 * There is **one** key: the control-plane Ed25519 key the Worker already signs machine requests
 * with (`HNS_CONTROL_PLANE_KEY`, 0148), whose public half `GET /api/machines/keys` serves. A grant
 * uses it too, so the machine verifies a grant with the key it already enrolled with and there is
 * no second key to distribute. The private half is a Worker secret and never leaves the Worker; a
 * grant's answer never carries a public key either (a machine with no key refuses every grant, and
 * trust-on-first-use is exactly what that refuses).
 *
 * Phase 1 signs `Ed25519` only. The contract carries `ECDSA-P256` for a verifier, but a signer here
 * refuses it (`grant_algorithm_mismatch`) rather than quietly signing with another algorithm:
 * issuing ECDSA would be a second key to distribute, which is Phase 2.
 *
 * Key material is imported `extractable` once, only to export the JWK's `x` (`keyId`), and the
 * signing key itself is imported non-extractable. The seed never appears in an error, a log, or a
 * value this module returns.
 */

/** The prefixes of the Ed25519 PKCS#8 encoding, up to the 32-byte seed. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * The length of the `keyId` fingerprint, in hex characters (16 bytes of SHA-256).
 *
 * @remarks
 * A `keyId` says *which* key signed; it is not the key and not a secret. It is never the whole
 * public key: the public half is served only by `GET /api/machines/keys`, so a grant cannot be used
 * as a key distribution channel.
 */
const KEY_ID_LENGTH = 32;

/**
 * The signature operation each algorithm signs with.
 *
 * @param algorithm - The grant's `alg`.
 * @returns The WebCrypto parameters; Phase 1 only issues `Ed25519`.
 * @throws Error for an algorithm this signer does not issue; the caller answers
 * `grant_algorithm_mismatch` before reaching here.
 */
const ED25519_PARAMETERS = { name: "Ed25519" } satisfies AlgorithmIdentifier;

function signParameters(algorithm: GrantAlgorithm) {
  if (algorithm === "Ed25519") return ED25519_PARAMETERS;
  throw new Error("the grant signer issues Ed25519 only");
}

/** The exported JWK's public half, parsed: the only member this module reads. */
const PublicHalfSchema = v.object({ x: v.pipe(v.string(), v.minLength(1)) });

/**
 * The `x` member of an exported Ed25519 JWK, or undefined when the export is not one.
 *
 * @param jwk - What `exportKey("jwk", …)` answered (typed as a JsonWebKey, read as untrusted).
 */
function publicHalfOf(jwk: JsonWebKey): string | undefined {
  const parsed = v.safeParse(PublicHalfSchema, jwk);
  return parsed.success ? parsed.output.x : undefined;
}

/**
 * Whether the runtime can sign with `algorithm` at all.
 *
 * @param algorithm - The grant's `alg`.
 * @returns `true` when `crypto.subtle` both names the algorithm and generates a key with it; `false`
 * on a runtime without it (an older isolate, a test double), so the caller can fail closed instead of
 * throwing out of a request.
 *
 * @remarks
 * The check reads the algorithm by string rather than through WebCrypto's `SubtleCrypto` index, so a
 * runtime whose types do not list `Ed25519` is still measured as it behaves: Node 24 generates an
 * Ed25519 key while `"Ed25519" in crypto.subtle` is `false` there, and a probe that trusted the
 * index would refuse a runtime that can sign.
 * @remarks
 * 0224 measured Ed25519 on Node 24 and on Workers in `cf dev`; this probe is what a runtime that
 * lacks it (a test double, an older isolate) is refused by, so a grant is never issued unsigned or
 * signed with something else.
 */
export async function supportsGrantAlgorithm(algorithm: GrantAlgorithm): Promise<boolean> {
  if (algorithm !== "Ed25519") return false;
  try {
    const key = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ]);
    return key.privateKey.type === "private";
  } catch {
    return false;
  }
}

/**
 * Decode a base64url string into its bytes.
 *
 * @param text - Unpadded base64url.
 * @returns The bytes.
 * @throws Error when the text is not base64url; the message names no part of the text.
 */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** base64url of some bytes, unpadded (the contract's signature spelling). */
function toBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * What the grant signer is given: the control-plane seed.
 *
 * @remarks
 * `seed` is the **raw 32-byte Ed25519 seed** in base64url, which is the form `HNS_CONTROL_PLANE_KEY`
 * has (0147 / 0148): the PEM / JWK / raw question the issue left open is answered by "the secret is
 * already raw", so 0224 adds no format and the deployment's secret is unchanged.
 */
export interface GrantSignerOptions {
  /** base64url of the 32-byte Ed25519 seed; `HNS_CONTROL_PLANE_KEY`. */
  readonly seed: string;
  /** The clock the signature is not given (the payload carries the times); present so a caller has
   * one source for "now" beside the key. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/** What a signer does: one grant, signed. */
export interface GrantSigner {
  /** The algorithm this signer issues; `Ed25519` in Phase 1. */
  readonly alg: GrantAlgorithm;
  /**
   * The key the signature names.
   *
   * @remarks
   * A **fingerprint of the control-plane key itself**: `sha256(raw public key)`'s first 16 bytes in
   * hex. Two rotations produce two `keyId`s, so a machine that keeps both public keys can pick the
   * one the grant was signed with; the id is not the public key (which is served only by
   * `GET /api/machines/keys`) and nothing secret is derived from it — the seed's hash is never
   * computed or exposed.
   */
  readonly keyId: string;
  /**
   * Sign one grant payload.
   *
   * @param payload - The payload (or anything with the same canonical form). It is signed as
   * `JCS(payload)`'s UTF-8 bytes, the contract's signing input.
   * @returns The base64url signature over `JCS(payload)`.
   * @throws Error when WebCrypto refuses the key or the sign; the caller refuses to issue the grant
   * (fail closed) instead of returning an unsigned payload.
   */
  sign(payload: SignedGrant["payload"]): Promise<string>;
  /**
   * Verify one signature with the key that made it.
   *
   * @param payload - The payload the signature was made over.
   * @param signature - The base64url signature.
   * @returns `true` when the control-plane key verifies it, `false` for anything else (a malformed
   * signature is `false`, never a throw).
   * @remarks
   * The issuer signs with this key and then verifies with it before answering: a signer that
   * produces bytes its own public half does not accept is a defect, and a grant that fails is
   * withheld rather than handed out unverifiable.
   */
  verify(payload: SignedGrant["payload"], signature: string): Promise<boolean>;
}

/** A signer whose key cannot be imported: no grant is ever issued through it. */
export type GrantSignerResult =
  | { readonly ok: true; readonly signer: GrantSigner }
  | {
      readonly ok: false;
      readonly code: "grant_algorithm_mismatch" | "unavailable";
      readonly message: string;
    };

/**
 * Import the control-plane seed as the key grants are signed with.
 *
 * @param options - The base64url 32-byte Ed25519 seed.
 * @returns The signer, or a typed refusal: `unavailable` when WebCrypto cannot use Ed25519 or the
 * seed is not a 32-byte key (the deployment has no usable key), `grant_algorithm_mismatch` never
 * here (it is the verifier's code) but listed so a caller has one closed vocabulary.
 *
 * @remarks
 * The seed is imported twice: once `extractable` for the `keyId` export, and once
 * non-extractable for signing. The export is the only use of the private material beyond signing,
 * and it yields the public half's `x`; nothing else leaves this function. A malformed seed is
 * `unavailable` with a message that names no part of the secret.
 */
export async function grantSigner(options: GrantSignerOptions): Promise<GrantSignerResult> {
  if (!(await supportsGrantAlgorithm("Ed25519"))) {
    return {
      ok: false,
      code: "unavailable",
      message: "this runtime cannot sign with Ed25519, so no grant is issued",
    };
  }
  let seed: Uint8Array<ArrayBuffer>;
  try {
    seed = fromBase64Url(options.seed);
  } catch {
    return { ok: false, code: "unavailable", message: "the control-plane key is not base64url" };
  }
  if (seed.byteLength !== 32) {
    return {
      ok: false,
      code: "unavailable",
      message: "the control-plane key is not a 32-byte Ed25519 seed",
    };
  }
  const der = new Uint8Array(PKCS8_PREFIX.byteLength + seed.byteLength);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.byteLength);
  let privateKey: CryptoKey;
  let verifyKey: CryptoKey;
  let publicKey: Uint8Array;
  try {
    const exported = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "Ed25519" },
      true,
      ["sign"],
    );
    const x = publicHalfOf(await globalThis.crypto.subtle.exportKey("jwk", exported));
    if (x === undefined) {
      return {
        ok: false,
        code: "unavailable",
        message: "the control-plane key has no Ed25519 public half",
      };
    }
    publicKey = fromBase64Url(x);
    privateKey = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    verifyKey = await globalThis.crypto.subtle.importKey(
      "raw",
      new Uint8Array(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    return {
      ok: false,
      code: "unavailable",
      message: "WebCrypto could not import the control-plane key",
    };
  }
  const fingerprint = await sha256Hex(canonicalize(toBase64Url(new Uint8Array(publicKey).buffer)));
  return {
    ok: true,
    signer: {
      alg: "Ed25519",
      keyId: fingerprint.slice(0, KEY_ID_LENGTH),
      async sign(payload) {
        const bytes = await globalThis.crypto.subtle.sign(
          signParameters("Ed25519"),
          privateKey,
          signingInput({ payload, signature: "" }),
        );
        return toBase64Url(bytes);
      },
      async verify(payload, signature) {
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = fromBase64Url(signature);
        } catch {
          return false;
        }
        try {
          return await globalThis.crypto.subtle.verify(
            signParameters("Ed25519"),
            verifyKey,
            bytes,
            signingInput({ payload, signature }),
          );
        } catch {
          return false;
        }
      },
    },
  };
}

/**
 * The public half of a seed, as raw bytes.
 *
 * @param seed - base64url of the 32-byte Ed25519 seed.
 * @returns The 32-byte public key, or `undefined` when the seed is not one.
 *
 * @remarks
 * For a test or a verifier that holds the same secret (the integration test verifies grants the way
 * a machine does). Production serves the public key through `GET /api/machines/keys` and never
 * needs this.
 */
export async function controlPlanePublicKey(seed: string): Promise<Uint8Array | undefined> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(seed);
  } catch {
    return undefined;
  }
  if (bytes.byteLength !== 32) return undefined;
  const der = new Uint8Array(PKCS8_PREFIX.byteLength + bytes.byteLength);
  der.set(PKCS8_PREFIX);
  der.set(bytes, PKCS8_PREFIX.byteLength);
  try {
    const exported = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "Ed25519" },
      true,
      ["sign"],
    );
    const x = publicHalfOf(await globalThis.crypto.subtle.exportKey("jwk", exported));
    return x === undefined ? undefined : fromBase64Url(x);
  } catch {
    return undefined;
  }
}
