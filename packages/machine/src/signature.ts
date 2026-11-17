import { createHash, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { signatureMessage } from "@hns/core";
import type { RequestSignature } from "@hns/core";
import { verificationKey } from "./control-plane.ts";
import type { ControlPlaneKeys } from "./control-plane.ts";
import { MachineRefusal } from "./refusal.ts";
import type { SignedHeaders } from "./wire.ts";

/** The default clock window: a request is accepted for a minute either way. */
export const DEFAULT_WINDOW_MS = 60_000;

/** Nonces remembered at once; the oldest is dropped first. */
const DEFAULT_NONCE_LIMIT = 4096;

export { signatureMessage } from "@hns/core";
export type { RequestSignature } from "@hns/core";

/**
 * The sha256 of a request body, in hex.
 *
 * @param body - The exact bytes that will be sent.
 * @returns 64 lowercase hex characters.
 */
export function bodyHash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Check one request signature against one control-plane public key.
 *
 * @param input - The fields the signature covers, as received.
 * @param publicKey - One enrolled control-plane key.
 * @param signature - The base64url signature from the header.
 * @returns true only for a 64-byte signature that verifies over the message.
 *
 * @remarks
 * A signature that is not 64 bytes, or not base64url, is false rather than a
 * throw: a caller cannot distinguish "wrong length" from "wrong key", and the
 * refusal is the same.
 */
export function verifyRequestSignature(
  input: RequestSignature,
  publicKey: KeyObject,
  signature: string,
): boolean {
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.byteLength !== 64) return false;
  return verify(null, signatureMessage(input), publicKey, bytes);
}

/**
 * The nonces accepted inside the clock window, so a replay is refused once.
 *
 * @remarks
 * A nonce is remembered for `windowMs` after acceptance, which is as long as a
 * timestamp can still be inside the window. The bound is a backstop: past it the
 * oldest nonce is forgotten, so a request that is expensive to produce could
 * replay inside the window. Only a caller that can sign can create nonces.
 */
export class NonceCache {
  readonly #seen = new Map<string, number>();
  readonly #limit: number;

  constructor(limit = DEFAULT_NONCE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("the nonce limit must be positive");
    this.#limit = limit;
  }

  /** How many nonces are remembered now. */
  get size(): number {
    return this.#seen.size;
  }

  /**
   * Remember a nonce, or report that it was already used.
   *
   * @param nonce - The nonce from the request header.
   * @param expiresAt - Epoch milliseconds after which the replay window closes.
   * @param now - Epoch milliseconds, the verifier's clock.
   * @returns true when the nonce is fresh; false when it is still remembered.
   */
  accept(nonce: string, expiresAt: number, now: number): boolean {
    for (const [seen, expiry] of this.#seen) {
      if (expiry > now) break;
      this.#seen.delete(seen);
    }
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, expiresAt);
    while (this.#seen.size > this.#limit) {
      const oldest = this.#seen.keys().next();
      if (oldest.done === true) break;
      this.#seen.delete(oldest.value);
    }
    return true;
  }
}

/** How to decide whether a request is authentic and fresh. */
export interface RequestVerifierOptions {
  /** The machine this agent runs for; a request naming another one is refused. */
  readonly machineId: string;
  /** Where the enrolled control-plane public keys come from. */
  readonly controlPlane: ControlPlaneKeys;
  /** The clock; tests pass a fixed one. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** How far from the clock a timestamp may be. Defaults to 60 seconds. */
  readonly windowMs?: number | undefined;
  /** Nonces remembered at once. Defaults to 4096. */
  readonly nonceLimit?: number | undefined;
}

/** One request as the verifier sees it: already parsed headers and raw body. */
export interface VerifiableRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: SignedHeaders;
  readonly body: Uint8Array;
}

/**
 * The one place a request is authenticated: key, clock window, signature, nonce.
 *
 * @remarks
 * The order is fail closed and deliberate. The key is looked up first, so an
 * unregistered machine learns nothing. The clock is checked before the
 * signature, so an expired request never reaches the nonce cache. The nonce is
 * recorded only after the signature verifies, so an unauthenticated caller
 * cannot burn a nonce the legitimate signer is about to use.
 */
export class RequestVerifier {
  readonly #machineId: string;
  readonly #controlPlane: ControlPlaneKeys;
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #nonces: NonceCache;

  constructor(options: RequestVerifierOptions) {
    this.#machineId = options.machineId;
    this.#controlPlane = options.controlPlane;
    this.#now = options.now ?? Date.now;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#nonces = new NonceCache(options.nonceLimit ?? DEFAULT_NONCE_LIMIT);
  }

  /**
   * Authenticate one request.
   *
   * @param request - The method, path, parsed headers, and body bytes.
   * @returns Nothing; a rejection is the answer.
   * @throws {MachineRefusal} `unauthorized` for another machine, an empty
   * enrollment, a malformed key, or a bad signature; `stale_request` outside
   * the window; `replayed` for a nonce already accepted.
   */
  async verify(request: VerifiableRequest): Promise<void> {
    const { headers } = request;
    if (headers.machineId !== this.#machineId) {
      throw new MachineRefusal("unauthorized", "the request names another machine");
    }
    const enrolled = await this.#controlPlane.publicKeys();
    if (enrolled.length === 0) {
      throw new MachineRefusal("unauthorized", "the machine has no enrolled control-plane key");
    }
    const keys = enrolled.map(verificationKey);
    const now = this.#now();
    const timestamp = Number(headers.timestamp);
    if (Math.abs(now - timestamp) > this.#windowMs) {
      throw new MachineRefusal("stale_request", "the timestamp is outside the accepted window");
    }
    const signed: RequestSignature = {
      machineId: headers.machineId,
      connection: headers.connection,
      seq: headers.seq,
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      method: request.method,
      path: request.path,
      bodyHash: bodyHash(request.body),
    };
    if (!keys.some((key) => verifyRequestSignature(signed, key, headers.signature))) {
      throw new MachineRefusal("unauthorized", "the signature does not match any enrolled key");
    }
    if (!this.#nonces.accept(headers.nonce, now + this.#windowMs, now)) {
      throw new MachineRefusal("replayed", "the nonce was already accepted");
    }
  }
}
