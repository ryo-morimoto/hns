import * as v from "valibot";
import { problem } from "../edge/problem.ts";

/**
 * The machines REST face: the control-plane public keys a machine enrolls with (0148 / D087).
 *
 * @remarks
 * **Who reads it.** A machine reads it after enrollment to learn the public half of the key the
 * Worker signs its requests with (`ControlPlaneKeys`, 0147), and a person reads it to compare that
 * key against the deployment. It is not a discovery endpoint for machines: the machine is given
 * the `hostname` at enrollment, and a machine that has no key refuses every request.
 *
 * **Why it needs a session anyway (D059).** The public keys are not secret, but the response says
 * which control-plane key this deployment uses, and the issue that adds a face declares its
 * authentication in the same change. The edge checks `hns_session` before this handler runs, so an
 * unauthenticated caller gets `401` and learns nothing. The body is public-key material only: the
 * seed and the device keys never appear in it.
 *
 * **Revocation is absent, not hidden.** A revoked machine's device key is not part of this
 * response (this response carries the control-plane key, not device keys), and the registry's
 * `deviceKey` is what refuses a revoked machine elsewhere.
 */

/** One control-plane public key, as the face serves it. */
export interface ControlPlaneKeyView {
  /** The raw 32-byte Ed25519 public key, base64url without padding. */
  readonly publicKey: string;
  /** The algorithm; always `ed25519`, so a client can refuse anything else. */
  readonly algorithm: "ed25519";
}

/** The body of `GET /api/machines/keys`. */
interface KeysBody {
  /**
   * The keys currently trusted for inbound requests, newest first.
   *
   * @remarks
   * An array because a rotation lists the old and the new key side by side (0147 C25); a machine
   * that keeps both accepts either. Empty means the deployment has no key, and every machine
   * request is refused.
   */
  readonly keys: readonly ControlPlaneKeyView[];
}

/** The prefixes of the Ed25519 PKCS#8 encoding, up to the 32-byte seed. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Decode the Worker's control-plane seed into the public key it signs with.
 *
 * @param seed - The base64url 32-byte Ed25519 seed from `HNS_CONTROL_PLANE_KEY`.
 * @returns The public half as base64url, or undefined when the secret is not an Ed25519 seed.
 *
 * @remarks
 * The runtime derives the public half: an Ed25519 JWK exported from the private key carries `x`,
 * the 32-byte public key. The import is `extractable` only for that export; nothing else sees it.
 */
async function controlPlanePublicKey(seed: string): Promise<ControlPlaneKeyView | undefined> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const padded = seed.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    return undefined;
  }
  if (bytes.byteLength !== 32) return undefined;
  const der = new Uint8Array(PKCS8_PREFIX.byteLength + bytes.byteLength);
  der.set(PKCS8_PREFIX);
  der.set(bytes, PKCS8_PREFIX.byteLength);
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, [
      "sign",
    ]);
    const jwk = v.parse(
      v.object({ x: v.pipe(v.string(), v.minLength(1)) }),
      await crypto.subtle.exportKey("jwk", privateKey),
    );
    return { publicKey: jwk.x, algorithm: "ed25519" };
  } catch {
    return undefined;
  }
}

/**
 * Create the `GET /api/machines/keys` handler.
 *
 * @param env - The Worker environment, for the control-plane secret.
 * @returns A handler that serves the public keys, or a typed problem.
 *
 * @remarks
 * A missing or malformed `HNS_CONTROL_PLANE_KEY` is `unavailable`: the route exists but the
 * deployment has no key, and an empty list would let a machine believe it was enrolled with no
 * key. The response never carries the seed.
 */
export function createKeysFace(): (request: {
  readonly env: { readonly HNS_CONTROL_PLANE_KEY?: string | undefined };
}) => Promise<Response> {
  return async function keys(request) {
    const seed = request.env.HNS_CONTROL_PLANE_KEY;
    if (seed === undefined || seed.length === 0) {
      return problem(
        "unavailable",
        "The control-plane key is not configured.",
        "/api/machines/keys",
      );
    }
    const key = await controlPlanePublicKey(seed);
    if (key === undefined) {
      return problem(
        "unavailable",
        "The control-plane key is not an Ed25519 seed.",
        "/api/machines/keys",
      );
    }
    const body: KeysBody = { keys: [key] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };
}
