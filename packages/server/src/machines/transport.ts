import { MACHINE_RPC_PATH, SIGNED_HEADER_BY_FIELD, signatureMessage } from "@hns/core";
import type { RequestSignature } from "@hns/core";

/**
 * The Worker's transport to a machine: one control-plane-signed `POST` per call, through the
 * tunnel host the registry holds (0147 / D053 / D100).
 *
 * @remarks
 * This module is the **fetch** half of 0148's "D1 + fetch" (D049): the registry says which
 * hostname to call, and this does the call. The machine verifies with the control-plane public
 * key it received at enrollment, so nothing here holds the machine's device key.
 *
 * **What 0148 delivers and what it does not.** The transport is implemented and tested here; the
 * Workspace object's use of it for `op:mirror` and the checkpoint pack push is 0249. 0246's
 * Result already says its push has no launcher, and wiring the object to a machine through the
 * tunnel is that issue's start-up path, not a second copy of it here.
 */

/** How long one Worker-to-machine call may take. The machine's own deadline is shorter. */
export const MACHINE_CALL_TIMEOUT_MS = 3_000;

/** The control-plane seed is 32 bytes; the Worker secret carries its base64url spelling. */
const CONTROL_PLANE_SEED_BYTES = 32;

/** The prefixes of the Ed25519 PKCS#8 encoding, up to the 32-byte seed. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** The connection this Worker presents; seq names the connection instance, not the request. */
export const WORKER_CONNECTION = "hns-worker";

/** The connection sequence; it names the connection, not the request. */
export const WORKER_SEQ = "1";

/** The largest answer the Worker reads from a machine. */
export const MAX_MACHINE_ANSWER_BYTES = 1_048_576;

/**
 * Why a machine call produced no answer the Worker can act on.
 *
 * @remarks
 * Closed vocabulary. `unreachable` covers a transport failure, the deadline, and an unreadable
 * answer; `refused` is the machine's own refusal (with its code when it carried one);
 * `not_configured` is a missing hostname or control-plane key, which is a deployment gap and not
 * the machine's fault. None of these is ever reported as success.
 */
export const MACHINE_CALL_FAILURES = ["unreachable", "refused", "not_configured"] as const;

/** One way a machine call has no usable answer. */
export type MachineCallFailure = (typeof MACHINE_CALL_FAILURES)[number];

/** What one machine call answered. */
export type MachineAnswer =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | {
      readonly ok: false;
      readonly failure: MachineCallFailure;
      /** A short diagnostic, never a body: a failure name or the machine's refusal code. */
      readonly detail: string;
    };

/** Where one machine is, as the registry says. */
export interface MachineEndpoint {
  /** The tunnel hostname (`machines.hostname`), a DNS name without a scheme or a path. */
  readonly hostname: string;
}

/** What one call needs beyond its target. */
export interface MachineCallOptions {
  /** The control-plane Ed25519 seed (base64url), from `HNS_CONTROL_PLANE_KEY`. */
  readonly controlPlaneKey: string;
  /** The machine id the request names; it is part of the signed message. */
  readonly machineId: string;
  /** The correlation id; forwarded, never signed. */
  readonly requestId?: string | undefined;
  /** The deadline; the call is aborted past it. */
  readonly signal?: AbortSignal | undefined;
  /** The clock; tests pass a fixed one. */
  readonly now?: (() => number) | undefined;
  /** How long the call may take. Defaults to {@link MACHINE_CALL_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/**
 * The transport: call one machine's `/rpc` with a control-plane signature.
 *
 * @remarks
 * The signed fields are the machine's own contract (`@hns/core`): the machine id, the connection,
 * the seq, the timestamp, a fresh nonce, the method, the path, and the SHA-256 of the body. The
 * path is always {@link MACHINE_RPC_PATH}, because that is the only route the agent answers; the
 * health probe is an `{"op":"health"}` body on the same route (0147), not a second path.
 */
export interface MachineTransport {
  /**
   * Send one operation to a machine.
   *
   * @param endpoint - The machine's tunnel hostname.
   * @param body - The JSON body bytes to sign and send.
   * @param options - The control-plane key, the machine id, the deadline, and the clock.
   * @returns The machine's answer, or a typed failure.
   *
   * @remarks
   * The call never throws for an expected failure: a bad key, a transport failure, the deadline,
   * and a machine refusal are values. It fails closed for a hostname that is not a DNS name, so a
   * malformed registry row cannot make the Worker fetch an arbitrary origin.
   */
  call(
    endpoint: MachineEndpoint,
    body: Uint8Array,
    options: MachineCallOptions,
  ): Promise<MachineAnswer>;
}

/** The tunnel hostname rules: a DNS name, no scheme, no path, no userinfo, no port. */
const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/**
 * Build the origin of one machine's `/rpc`.
 *
 * @param endpoint - The registry's hostname.
 * @returns The absolute URL, or undefined when the hostname is not a DNS name.
 *
 * @remarks
 * The scheme is always https: the tunnel terminates TLS at Cloudflare, and a plaintext call would
 * hand the control-plane signature to the network.
 */
export function machineRpcUrl(endpoint: MachineEndpoint): string | undefined {
  if (!HOSTNAME.test(endpoint.hostname)) return undefined;
  return "https://" + endpoint.hostname + MACHINE_RPC_PATH;
}

/** Decode base64url into bytes; throws on text that is not base64url. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** base64url without padding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Import the control-plane seed as an Ed25519 signing key. */
async function signingKey(secret: string): Promise<CryptoKey> {
  const seed = fromBase64Url(secret);
  if (seed.byteLength !== CONTROL_PLANE_SEED_BYTES) {
    throw new Error("the control-plane key is not a 32-byte seed");
  }
  const der = new Uint8Array(PKCS8_PREFIX.byteLength + seed.byteLength);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.byteLength);
  return await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

/** The SHA-256 of some bytes, in hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Read the answer body up to `limit` bytes, or undefined when it is larger or cannot be read. */
async function readAnswerBytes(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The machine's refusal envelope, as the transport reads it for a diagnostic code. */
const RefusalBody = /"code"\s*:\s*"([a-z_]+)"/u;

/**
 * Build the production transport.
 *
 * @param fetchImpl - The `fetch` to use; production leaves it out.
 * @returns The port.
 */
export function createMachineTransport(fetchImpl: typeof fetch = fetch): MachineTransport {
  return {
    async call(endpoint, body, options) {
      const url = machineRpcUrl(endpoint);
      if (url === undefined) {
        return { ok: false, failure: "not_configured", detail: "hostname is not a DNS name" };
      }
      if (options.controlPlaneKey.length === 0 || options.machineId.length === 0) {
        return { ok: false, failure: "not_configured", detail: "machine or key is not set" };
      }
      const clock = options.now ?? (() => Date.now());
      const timestamp = String(clock());
      const nonce = crypto.randomUUID();
      let signatureBytes: ArrayBuffer;
      try {
        const key = await signingKey(options.controlPlaneKey);
        const message: RequestSignature = {
          machineId: options.machineId,
          connection: WORKER_CONNECTION,
          seq: WORKER_SEQ,
          timestamp,
          nonce,
          method: "POST",
          path: MACHINE_RPC_PATH,
          bodyHash: await sha256Hex(body),
        };
        signatureBytes = await crypto.subtle.sign(
          { name: "Ed25519" },
          key,
          signatureMessage(message),
        );
      } catch (error) {
        return {
          ok: false,
          failure: "not_configured",
          detail: "control-plane key: " + (error instanceof Error ? error.name : "unusable"),
        };
      }
      const headers = new Headers({ "content-type": "application/json" });
      if (options.requestId !== undefined && options.requestId !== "") {
        headers.set("x-request-id", options.requestId);
      }
      headers.set(SIGNED_HEADER_BY_FIELD.machineId, options.machineId);
      headers.set(SIGNED_HEADER_BY_FIELD.connection, WORKER_CONNECTION);
      headers.set(SIGNED_HEADER_BY_FIELD.seq, WORKER_SEQ);
      headers.set(SIGNED_HEADER_BY_FIELD.timestamp, timestamp);
      headers.set(SIGNED_HEADER_BY_FIELD.nonce, nonce);
      headers.set(SIGNED_HEADER_BY_FIELD.signature, toBase64Url(new Uint8Array(signatureBytes)));
      const timeout = options.timeoutMs ?? MACHINE_CALL_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const forwarded = options.signal;
      const onAbort = (): void => controller.abort();
      forwarded?.addEventListener("abort", onAbort);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: new Uint8Array(body),
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (error) {
        return {
          ok: false,
          failure: "unreachable",
          detail: error instanceof Error ? error.name : "transport",
        };
      } finally {
        clearTimeout(timer);
        forwarded?.removeEventListener("abort", onAbort);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_MACHINE_ANSWER_BYTES) {
        return { ok: false, failure: "unreachable", detail: "answer too large" };
      }
      const bytes = await readAnswerBytes(response, MAX_MACHINE_ANSWER_BYTES);
      if (bytes === undefined) {
        return { ok: false, failure: "unreachable", detail: "unreadable answer" };
      }
      const text = new TextDecoder().decode(bytes);
      if (response.status < 200 || response.status >= 300) {
        const code = RefusalBody.exec(text)?.[1] ?? String(response.status);
        return { ok: false, failure: "refused", detail: code };
      }
      return { ok: true, status: response.status, body: text };
    },
  };
}

/** A transport that never reaches a machine; the fail-closed default when none is configured. */
export const NO_MACHINE_TRANSPORT: MachineTransport = {
  call: async () => ({
    ok: false,
    failure: "not_configured",
    detail: "no machine transport",
  }),
};
