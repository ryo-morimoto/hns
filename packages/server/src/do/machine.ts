import {
  CheckpointPrepareResultSchema,
  MACHINE_REFUSALS,
  MACHINE_RPC_PATH,
  MIRROR_FAILURES,
  MachineReadResultSchema,
  MachineWriteResultSchema,
  SIGNED_HEADER_BY_FIELD,
  signatureMessage,
} from "@hns/core";
import type {
  CheckpointPrepareResult,
  MachineReadResult,
  MachineRefusalCode,
  MachineWriteRequest,
  MachineWriteResult,
  MirrorFailure,
  MirrorTarget,
  RequestSignature,
} from "@hns/core";
import * as v from "valibot";
import { checkpointRequestBody } from "../checkpoint/agent-wire.ts";

/**
 * The connection id this Worker presents for its machine calls.
 *
 * @remarks
 * The machine's gate refuses the older connection after a reconnect, comparing a seq that names
 * the connection instance (0147). One Worker is the only caller here, so a constant id and seq
 * keep it current. The tunnel's connection and seq come from the machine registry (0148); when
 * that lands it replaces these constants and nothing else in this module changes.
 */
const WORKER_CONNECTION = "hns-worker";

/** The connection sequence; it names the connection, not the request. */
const WORKER_SEQ = "1";

/** The refusals that prove the machine wrote nothing. */
const DEFINITE_REFUSALS = new Set(["path_denied", "forbidden", "not_found", "invalid_request"]);

/** The largest answer this client reads; the machine's own response bound is 256 KiB. */
const MAX_ANSWER_BYTES = 1_048_576;

/**
 * Read the answer body up to {@link MAX_ANSWER_BYTES}, or undefined when it is larger or fails.
 *
 * @param response - The machine's answer.
 * @returns The decoded text, or undefined when the body cannot be read or exceeds the bound.
 *
 * @remarks
 * The bound is enforced while the body streams, so a body without a usable `content-length`
 * is cut off at the limit instead of being materialized first. A body that cannot be read is
 * no answer, never a success.
 */
async function readAnswerText(response: Response): Promise<string | undefined> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ANSWER_BYTES) {
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
  return new TextDecoder().decode(bytes);
}

/** The prefixes of the Ed25519 PKCS#8 encoding, up to the 32-byte seed. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Why the Worker has no answer it can act on.
 *
 * @remarks
 * `denied` means the machine refused before writing, so the caller can report the refusal;
 * `too_large` is the one refusal with its own status (413) on both faces. `unavailable` means
 * no usable answer arrived (a transport failure, a malformed body, an unexpected status, or an
 * authentication failure): for a write it is the `unknown` case, and for a read it is "cannot
 * read right now".
 */
const MACHINE_FAILURES = ["denied", "too_large", "unavailable"] as const;

/** One way the Worker has no usable answer. */
type MachineFailure = (typeof MACHINE_FAILURES)[number];

/** What one machine call answered: a result, or the failure and a short diagnostic code. */
export type MachineFilesAnswer<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly failure: MachineFailure;
      /**
       * A short diagnostic: the machine's refusal code when it answered with one, else a
       * fixed phrase. Never the body.
       */
      readonly detail: string;
      /** The machine's refusal code, when the answer carried one; what a refusal records. */
      readonly refusal?: MachineRefusalCode | undefined;
    };

/**
 * What the machine's `op:"mirror"` answered: the status the contract records.
 *
 * @remarks
 * The push's answer, not the Worker's record: the Workspace reports it to its own
 * `/rpc/checkpoint/mirror`, which applies the transition table and re-checks the ref through the
 * binding. `skipped` is the machine deciding the run is over Artifacts' push limit, so a skipped
 * run costs no push. A refused or unanswered call is a value too: the mirror is best effort and
 * its failure is recorded as `failed` by the caller, never thrown at the checkpoint.
 */
export type MachineMirrorAnswer =
  | {
      readonly ok: true;
      readonly status: "mirrored";
      readonly ref: string;
      readonly commit: string;
    }
  | { readonly ok: true; readonly status: "skipped"; readonly reason: "too_large" }
  | {
      readonly ok: true;
      readonly status: "failed";
      readonly failure: MirrorFailure;
      readonly ref: string;
    }
  | {
      readonly ok: false;
      /**
       * Why no status arrived: the machine's own refusal (the call reached it and it said no), or
       * that no usable answer came back at all (a transport failure, a bad key, a malformed body).
       */
      readonly failure: "refused" | "unavailable";
      /** A short diagnostic: the machine's refusal code, or a fixed phrase. Never a body. */
      readonly detail: string;
    };

/** The mirror answer's body: the machine's `parseMirrorResult` shape, read here.
 *
 * @remarks
 * The server may import core, agent, store, and workspace only (docs/packages.md), so it cannot
 * read `@hns/machine`'s parser; this is that parser's shape, and `agent-wire.ts` is where the
 * same rule is written for the checkpoint's body. When the machine's contract changes, this
 * changes with it.
 */
const MirrorResultSchema = v.variant("status", [
  v.object({
    status: v.literal("mirrored"),
    ref: v.pipe(v.string(), v.minLength(1)),
    commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  }),
  v.object({ status: v.literal("skipped"), reason: v.literal("too_large") }),
  v.object({
    status: v.literal("failed"),
    failure: v.picklist(MIRROR_FAILURES),
    ref: v.pipe(v.string(), v.minLength(1)),
  }),
]);

/**
 * The body of one mirror request, as the machine's wire contract names it (0246).
 *
 * @param request - The Run, the target the Workspace issued, and the commit C the ref must land on.
 * @returns The JSON text the agent parses.
 *
 * @remarks
 * The token is a secret: it is in this body and nowhere else — not in a log line, not in an event,
 * not in a stored record. The ref is the one the target names, which the machine re-derives from
 * the Run and refuses when it differs.
 */
export function mirrorRequestBody(request: {
  readonly runId: string;
  readonly commit: string;
  readonly target: MirrorTarget;
}): string {
  return JSON.stringify({
    op: "mirror",
    runId: request.runId,
    remote: request.target.remote,
    token: request.target.token,
    ref: request.target.ref,
    commit: request.commit,
    expiresAt: request.target.expiresAt,
  });
}

/** What every machine call carries: the target, the correlation id, and the deadline. */
export interface MachineCall {
  /** The machine to call; the workspace's lease (or its last holder) names it. */
  readonly machineId: string;
  /** The inbound correlation id; it is forwarded and never signed. */
  readonly requestId: string;
  /** Aborted when the request's deadline expires. */
  readonly signal: AbortSignal;
}

/**
 * The port the Workspace uses to reach the machine.
 *
 * @remarks
 * A port, not an HTTP client, so the Workspace's unit tests run without a network or a key. The
 * production implementation signs with the control-plane key (D100) and is the only place a
 * machine URL is read.
 */
export interface MachineFiles {
  /** Apply one versioned write. */
  write(
    request: MachineWriteRequest,
    call: MachineCall,
  ): Promise<MachineFilesAnswer<MachineWriteResult>>;
  /** Read one file below the machine's ROOT. */
  read(
    request: { readonly path: string },
    call: MachineCall,
  ): Promise<MachineFilesAnswer<MachineReadResult>>;
  /**
   * Make (or find) one Run's checkpoint and report its metadata.
   *
   * @remarks
   * The machine commits the Run's tree to `refs/hns/checkpoints/<runId>` and answers the
   * checkpoint contract's prepare result: the commit, the pack's key, and the sizes. The pack is
   * not in the answer; it arrives at the Workspace as a signed binary request and is stored
   * before the checkpoint is recorded. A failure here is the machine not having made a
   * checkpoint, so the caller records nothing and acknowledges nothing.
   */
  checkpoint(
    request: { readonly runId: string },
    call: MachineCall,
  ): Promise<MachineFilesAnswer<CheckpointPrepareResult>>;
  /**
   * Push one Run's checkpoint commit to Artifacts on the machine's side (0246).
   *
   * @remarks
   * This is the transport 0246 left unimplemented: the Workspace issues the target and sends it
   * here once, **after** the checkpoint was acknowledged. The machine pushes with git and reads
   * the ref back, and answers the contract's status. Nothing about the push may change the
   * checkpoint's answer, so every failure is a value: the caller reports it as the mirror's state
   * and never fails the checkpoint for it (0245).
   *
   * Optional, so a port with no mirror (a test, or a deployment without a machine wire) is still a
   * valid one: the Workspace reads an absent member as "no mirror can be pushed".
   */
  mirror?(
    request: { readonly runId: string; readonly commit: string; readonly target: MirrorTarget },
    call: MachineCall,
  ): Promise<MachineMirrorAnswer>;
}

/**
 * What a Worker needs to sign a request to a machine.
 *
 * @remarks
 * The machine's identity travels per call (the workspace's lease holder); the registry (0148)
 * will be the authority on which machine that is. Until then the lease is.
 */
export interface MachineTarget {
  /** The machine agent's origin, from `HNS_AGENT_URL`. */
  readonly agentUrl: string;
  /** base64url of the 32-byte Ed25519 control-plane seed, from `HNS_CONTROL_PLANE_KEY`. */
  readonly controlPlaneKey: string;
}

/** The shape of the machine's answer envelope. */
const AnswerSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), op: v.string(), result: v.unknown() }),
  // The code is the machine's closed refusal vocabulary (the core list `@hns/machine` also
  // uses): a refusal the Worker records is a member of it, never free text.
  v.object({ ok: v.literal(false), code: v.picklist(MACHINE_REFUSALS), message: v.string() }),
]);

/** The sha256 of some bytes, in hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Decode base64url into bytes. */
function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Import the control-plane seed as a signing key. */
async function signingKey(secret: string): Promise<CryptoKey> {
  const seed = fromBase64Url(secret);
  if (seed.byteLength !== 32) throw new Error("the control-plane key is not a 32-byte seed");
  const der = new Uint8Array(PKCS8_PREFIX.byteLength + seed.byteLength);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.byteLength);
  return await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

/** base64url of an ArrayBuffer. */
function toBase64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * Sign one request the way the machine's enrollment expects.
 *
 * @param target - The machine's origin and the control-plane key.
 * @param machineId - The machine the request names; it is part of the signed message.
 * @param body - The exact body bytes that will be sent.
 * @param requestId - The correlation id; it is forwarded, never signed.
 * @param now - The clock the timestamp comes from.
 * @returns The headers of one signed request.
 * @throws Error when the control-plane key is not a 32-byte Ed25519 seed.
 *
 * @remarks
 * The signed fields are the machine's own contract (`@hns/core`); the path is always
 * {@link MACHINE_RPC_PATH} because that is the only route the agent answers. The nonce is
 * random per request, and the timestamp is the Worker's clock, so the machine's window and
 * replay cache are what bound a retry.
 */
async function signedHeaders(
  target: MachineTarget,
  machineId: string,
  body: Uint8Array,
  requestId: string,
  now: number,
): Promise<Headers> {
  const timestamp = String(now);
  const nonce = crypto.randomUUID();
  const signature: RequestSignature = {
    machineId,
    connection: WORKER_CONNECTION,
    seq: WORKER_SEQ,
    timestamp,
    nonce,
    method: "POST",
    path: MACHINE_RPC_PATH,
    bodyHash: await sha256Hex(body),
  };
  const key = await signingKey(target.controlPlaneKey);
  const signatureBytes = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    signatureMessage(signature),
  );
  const headers = new Headers({ "content-type": "application/json" });
  if (requestId !== "") headers.set("x-request-id", requestId);
  headers.set(SIGNED_HEADER_BY_FIELD.machineId, signature.machineId);
  headers.set(SIGNED_HEADER_BY_FIELD.connection, signature.connection);
  headers.set(SIGNED_HEADER_BY_FIELD.seq, signature.seq);
  headers.set(SIGNED_HEADER_BY_FIELD.timestamp, signature.timestamp);
  headers.set(SIGNED_HEADER_BY_FIELD.nonce, signature.nonce);
  headers.set(SIGNED_HEADER_BY_FIELD.signature, toBase64Url(signatureBytes));
  return headers;
}

/**
 * Create the production port: one signed POST per call to the machine's `/rpc`.
 *
 * @param target - The machine's origin and the control-plane key; the id travels per call.
 * @param options - The clock; tests pass a fixed one.
 * @returns A port the Workspace calls for a write or a read.
 *
 * @remarks
 * The body is sent as JSON and the answer is parsed at the boundary; a body that does not parse
 * is `unavailable`, never a success. A refusal the machine marks definite (path denied, a
 * missing parent, a symbolic link, an invalid request, too large) is `denied`; every other
 * refusal, a transport failure, or an unexpected status is `unavailable`, which the Workspace
 * turns into `unknown` for a write.
 */
export function createSignedMachineFiles(
  target: MachineTarget,
  options: { readonly now?: (() => number) | undefined } = {},
): MachineFiles {
  const clock = options.now ?? (() => Date.now());
  const url = target.agentUrl.replace(/\/+$/u, "") + MACHINE_RPC_PATH;

  async function send(body: string, call: MachineCall): Promise<MachineFilesAnswer<unknown>> {
    const bytes = new TextEncoder().encode(body);
    let response: Response;
    try {
      // Signing and sending are one step: a key the runtime cannot use means no request, and
      // the caller must treat it as no answer rather than as an applied write.
      const headers = await signedHeaders(target, call.machineId, bytes, call.requestId, clock());
      response = await fetch(url, {
        method: "POST",
        headers,
        body: bytes,
        signal: call.signal,
        // "error" is not implemented in workerd; "manual" keeps a redirect from being followed,
        // and a non-2xx answer becomes "unavailable" below.
        redirect: "manual",
      });
    } catch (error) {
      return {
        ok: false,
        failure: "unavailable",
        detail: error instanceof Error ? error.name + ": " + error.message : "transport",
      };
    }
    // Reading the answer can fail too (a cut connection, an unreadable body); that is no
    // answer, never a success. The size is bounded while streaming.
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
      return { ok: false, failure: "unavailable", detail: "answer too large" };
    }
    const text = await readAnswerText(response);
    if (text === undefined) {
      return { ok: false, failure: "unavailable", detail: "unreadable or oversized answer" };
    }
    let answer: v.InferOutput<typeof AnswerSchema>;
    try {
      answer = v.parse(AnswerSchema, JSON.parse(text));
    } catch {
      return { ok: false, failure: "unavailable", detail: "unparseable answer" };
    }
    if (answer.ok) {
      if (!response.ok) return { ok: false, failure: "unavailable", detail: "unexpected status" };
      return { ok: true, result: answer.result };
    }
    const failure: MachineFailure =
      answer.code === "too_large"
        ? "too_large"
        : DEFINITE_REFUSALS.has(answer.code)
          ? "denied"
          : "unavailable";
    return { ok: false, failure, detail: answer.code, refusal: answer.code };
  }

  return {
    async write(request, call) {
      const answer = await send(JSON.stringify(request), call);
      if (!answer.ok) return answer;
      try {
        return { ok: true, result: v.parse(MachineWriteResultSchema, answer.result) };
      } catch {
        return { ok: false, failure: "unavailable", detail: "unparseable write result" };
      }
    },
    async read(request, call) {
      const answer = await send(JSON.stringify({ op: "read", path: request.path }), call);
      if (!answer.ok) return answer;
      try {
        return { ok: true, result: v.parse(MachineReadResultSchema, answer.result) };
      } catch {
        return { ok: false, failure: "unavailable", detail: "unparseable read result" };
      }
    },
    async checkpoint(request, call) {
      const answer = await send(checkpointRequestBody(request.runId), call);
      if (!answer.ok) return answer;
      try {
        return { ok: true, result: v.parse(CheckpointPrepareResultSchema, answer.result) };
      } catch {
        return { ok: false, failure: "unavailable", detail: "unparseable checkpoint result" };
      }
    },
    async mirror(request, call) {
      // The same signed POST as every other operation, with the token in the body that is signed
      // and nowhere else. A refusal or no answer is a value: the caller records it as the mirror's
      // failure, and the checkpoint it belongs to was already acknowledged.
      const answer = await send(
        mirrorRequestBody({ runId: request.runId, commit: request.commit, target: request.target }),
        call,
      );
      if (!answer.ok) {
        return {
          ok: false,
          failure: answer.failure === "unavailable" ? "unavailable" : "refused",
          detail: answer.detail,
        };
      }
      // An answer whose body is not the contract's status is no answer: never a success, and never
      // a failure word the machine did not say. Each member is built from the parsed fields, so
      // what the type promises (a commit with `mirrored`, a failure with `failed`) is what is sent.
      const parsed = v.safeParse(MirrorResultSchema, answer.result);
      if (!parsed.success) {
        return { ok: false, failure: "unavailable", detail: "unparseable mirror result" };
      }
      const result = parsed.output;
      switch (result.status) {
        case "mirrored":
          return { ok: true, status: "mirrored", ref: result.ref, commit: result.commit };
        case "skipped":
          return { ok: true, status: "skipped", reason: result.reason };
        case "failed":
          return { ok: true, status: "failed", failure: result.failure, ref: result.ref };
      }
    },
  };
}
