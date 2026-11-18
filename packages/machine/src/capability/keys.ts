import * as v from "valibot";
import { canonicalize, sha256Hex } from "@hns/core/capability";
import type { GrantAlgorithm } from "@hns/core/capability";
import type { ControlPlaneKeys } from "../control-plane.ts";

/**
 * The control-plane public keys a grant is verified with (0225, `docs/capability.md` §5).
 *
 * @remarks
 * A grant is signed by the control plane's own Ed25519 key — the one the Worker already signs its
 * machine requests with (0148) — and the machine learns its public half from
 * `GET /api/machines/keys`, not from the grant. That matters: a grant that carried its own
 * verification key could be made to verify itself (trust on first use), so the contract puts the
 * key on another channel and the machine **refuses a grant it has no key for**.
 *
 * **Which key.** The grant names one by `keyId`: the first 32 hex characters of
 * `sha256Hex(JCS(base64url(raw 32-byte public key)))`, which is exactly the `keyId` the issuer
 * (0224's `grantSigner`) puts in every grant it signs. This module recomputes that id from the keys
 * the face served and selects the one the grant names; a face with no matching key is a refusal.
 *
 * **The one-way bridge.** `ControlPlaneKeys` (0147) is what the machine enrolled, as raw bytes.
 * This module wraps it so verification takes the same value as every other signature the machine
 * checks: `GrantKeys.publicKey(keyId, alg)` answers the WebCrypto key for one `keyId`, or a typed
 * refusal. There is no second key store and no fallback to a pinned key.
 */

/** The `keyId` length the issuer writes (0224's `KEY_ID_LENGTH`): 16 bytes of SHA-256, as hex. */
const KEY_ID_LENGTH = 32;

/** A raw Ed25519 public key is 32 bytes. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * The `keyId` of a raw public key.
 *
 * @param raw - The 32-byte Ed25519 public key.
 * @returns `sha256Hex(JCS(base64url(raw)))`'s first 32 hex characters, the issuer's fingerprint.
 * @throws Error when `raw` is not 32 bytes: an id over something the verifier cannot use would be
 * an id no grant could honestly name.
 *
 * @remarks
 * Byte-compatible with 0224's `grantSigner`: that module hashes the JWK's `x` (unpadded base64url of
 * the same bytes) and takes the same 32 characters. The two must not drift — a grant naming the
 * issuer's id and a verifier computing another id refuse every grant — so the machine's tests
 * compute this twice, once through the issuer's signer.
 */
export async function grantKeyId(raw: Uint8Array): Promise<string> {
  if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error("a control-plane key is 32 bytes");
  }
  return (await sha256Hex(canonicalize(base64Url(raw)))).slice(0, KEY_ID_LENGTH);
}

/** Unpadded base64url of some bytes. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** What choosing a key for one grant decided. */
export type GrantKeyLookup =
  | { readonly ok: true; readonly key: CryptoKey }
  | {
      readonly ok: false;
      readonly code: "grant_invalid" | "grant_algorithm_mismatch";
      readonly message: string;
    };

/**
 * The keys a grant may be verified with, chosen by `keyId`.
 *
 * @remarks
 * `publicKey` is what `verifyGrant` calls; it never throws, so a machine that has no key for a
 * grant answers a denial instead of failing the request.
 */
export interface GrantKeys {
  /**
   * The verification key one grant names.
   *
   * @param keyId - The grant's `payload.keyId`.
   * @param alg - The grant's `payload.alg`.
   * @returns The WebCrypto verification key, or a refusal when no enrolled key has that id, the
   * enrolled key is not an Ed25519 key, or the grant asks for another algorithm.
   */
  publicKey(keyId: string, alg: GrantAlgorithm): Promise<GrantKeyLookup>;
}

/**
 * Build {@link GrantKeys} over the keys the machine enrolled with.
 *
 * @param enrolled - Where the enrolled control-plane public keys come from (0147 / 0148). Its
 * `publicKeys()` is read on every lookup, so a rotation is seen without a restart; an empty list,
 * or a list that cannot be read, refuses every grant.
 * @returns A lookup that imports the matching raw key into WebCrypto and caches it.
 *
 * @remarks
 * The import is `{name: "Ed25519"}` and non-extractable, verify-only, exactly as a request
 * signature's key is: the machine holds public material either way. A key that is not 32 bytes, or
 * that WebCrypto refuses, is `grant_invalid` — the enrolled key is corrupt, which is not the same
 * as the grant being wrong, but the answer to the caller is the same: nothing runs.
 */
export function enrolledGrantKeys(enrolled: ControlPlaneKeys): GrantKeys {
  /** Imported keys, by `keyId`, so one grant's repeated calls do not import again. */
  const imported = new Map<string, CryptoKey>();
  return {
    async publicKey(keyId, alg) {
      if (alg !== "Ed25519") {
        // Phase 1 issues Ed25519 only; every enrolled control-plane key is Ed25519 (0148). An
        // ECDSA grant names an algorithm this machine has no key of, which is not a mismatch to
        // paper over.
        return {
          ok: false,
          code: "grant_algorithm_mismatch",
          message: "the machine has no " + alg + " control-plane key",
        };
      }
      let raws: readonly Uint8Array[];
      try {
        raws = await enrolled.publicKeys();
      } catch {
        return { ok: false, code: "grant_invalid", message: "the enrolled keys cannot be read" };
      }
      for (const raw of raws) {
        if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) continue;
        let id: string;
        try {
          id = await grantKeyId(raw);
        } catch {
          continue;
        }
        if (id !== keyId) continue;
        const known = imported.get(keyId);
        if (known !== undefined) return { ok: true, key: known };
        try {
          const key = await globalThis.crypto.subtle.importKey(
            "raw",
            new Uint8Array(raw),
            { name: "Ed25519" },
            false,
            ["verify"],
          );
          imported.set(keyId, key);
          return { ok: true, key };
        } catch {
          return {
            ok: false,
            code: "grant_invalid",
            message: "the enrolled control-plane key cannot be used",
          };
        }
      }
      return { ok: false, code: "grant_invalid", message: "no enrolled key has the grant's keyId" };
    },
  };
}

/** One key, as `GET /api/machines/keys` serves it. */
const ServedKeySchema = v.strictObject({
  publicKey: v.pipe(v.string(), v.minLength(1)),
  algorithm: v.literal("ed25519"),
});

/** The face's body. */
const ServedKeysSchema = v.strictObject({ keys: v.array(ServedKeySchema) });

/**
 * Read the control-plane public keys from `GET /api/machines/keys`.
 *
 * @param input - The face's absolute URL, the `fetch` to call it with, the session credential the
 * face requires (D059), and a timeout.
 * @returns A {@link ControlPlaneKeys} over the served keys, or a reason it could not be had.
 *
 * @remarks
 * This is the **enrollment** path (§5: "machine は enrollment で … から公開鍵を取得し"): the agent
 * reads the face once at start and keeps the keys it was given, as it does for request signatures,
 * so a grant is never verified against a key it learned from the grant itself. A face that answers
 * `unavailable`, `401`, a body that is not this shape, or a key that is not raw 32-byte base64url
 * yields no keys — and no keys refuses every grant (fail closed).
 *
 * The credential is sent as the session cookie the edge reads (`hns_session`); it is never logged
 * and never put in the answer's reason.
 */
export async function fetchControlPlaneKeys(input: {
  readonly url: string;
  readonly fetch: typeof globalThis.fetch;
  readonly session: string;
  /** How long the face may take; defaults to three seconds (0147's transport bound). */
  readonly timeoutMs?: number | undefined;
}): Promise<
  | { readonly ok: true; readonly keys: ControlPlaneKeys }
  | { readonly ok: false; readonly reason: string }
> {
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: "GET",
      headers: { cookie: "hns_session=" + input.session, accept: "application/json" },
      signal: AbortSignal.timeout(input.timeoutMs ?? 3_000),
    });
  } catch {
    return { ok: false, reason: "the key face could not be reached" };
  }
  if (!response.ok) {
    return { ok: false, reason: "the key face answered " + String(response.status) };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "the key face did not answer JSON" };
  }
  const parsed = v.safeParse(ServedKeysSchema, body);
  if (!parsed.success) return { ok: false, reason: "the key face's body is not the key list" };
  const raws: Uint8Array[] = [];
  for (const served of parsed.output.keys) {
    const raw = fromBase64Url(served.publicKey);
    if (raw === undefined) return { ok: false, reason: "a served key is not base64url" };
    if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
      return { ok: false, reason: "a served key is not a 32-byte Ed25519 key" };
    }
    raws.push(raw);
  }
  const keys = raws;
  return {
    ok: true,
    keys: { publicKeys: async () => keys },
  };
}

/** Decode unpadded base64url, or undefined for text outside it. */
function fromBase64Url(text: string): Uint8Array | undefined {
  let padded = "";
  for (const character of text) {
    if (character === "-") padded += "+";
    else if (character === "_") padded += "/";
    else padded += character;
  }
  while (padded.length % 4 !== 0) padded += "=";
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
