import * as v from "valibot";
import { OperationIdSchema } from "./codecs.ts";
import type { MutationUnknownReason } from "./types.ts";

/**
 * The machine agent's RPC contract: what a Worker sends it and what it answers.
 *
 * @remarks
 * The same definitions are used by the signer (the Worker) and the verifier (the
 * machine), so the signed message cannot drift between the two sides. The
 * signature covers the machine id, the connection instance, the sequence, the
 * timestamp, the nonce, the method, the path, and the body hash; it does **not**
 * cover `x-request-id`, which is a correlation value and never an
 * authentication input. A request body is JSON and is parsed at the boundary.
 */

/** The version tag inside the signed message; changing the covered fields changes it. */
export const MACHINE_REQUEST_VERSION = "hns.machine.request.v1";

/**
 * The headers that carry one signed request.
 *
 * @remarks
 * The names are the wire contract: whatever calls the agent must spell them the
 * same. `x-hns-seq` names the connection instance, not the request count, so
 * every request of one connection carries it unchanged. `x-request-id` is not
 * in this list because it is not signed.
 */
export const SIGNED_HEADERS = [
  "x-hns-machine",
  "x-hns-connection",
  "x-hns-seq",
  "x-hns-timestamp",
  "x-hns-nonce",
  "x-hns-signature",
] as const;

/** One signed header name. */
export type SignedHeaderName = (typeof SIGNED_HEADERS)[number];

/**
 * The header that carries each signed field, derived from {@link SIGNED_HEADERS}.
 *
 * @remarks
 * Both the signer and the verifier read names from here, so a renamed header cannot leave one
 * side reading a literal that the other side no longer sends. The order is the array's order.
 */
export const SIGNED_HEADER_BY_FIELD = {
  machineId: SIGNED_HEADERS[0],
  connection: SIGNED_HEADERS[1],
  seq: SIGNED_HEADERS[2],
  timestamp: SIGNED_HEADERS[3],
  nonce: SIGNED_HEADERS[4],
  signature: SIGNED_HEADERS[5],
} as const;

/** The only route the machine agent answers; the signature covers this path. */
export const MACHINE_RPC_PATH = "/rpc";

/**
 * The exact fields one machine request signature covers.
 *
 * @remarks
 * Every field is the text that travels on the wire (the seq and timestamp stay
 * decimal strings), because a number formatted differently would sign
 * differently. `bodyHash` is the SHA-256 of the body bytes, in hex.
 */
export interface RequestSignature {
  readonly machineId: string;
  readonly connection: string;
  readonly seq: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
}

/**
 * The bytes an Ed25519 signature is computed over.
 *
 * @param input - The fields the signature covers.
 * @returns The UTF-8 encoding of a JSON array, so no field can be shifted into
 * another by concatenation.
 *
 * @remarks
 * The signer and the verifier must both call this; building the message by hand
 * on one side would silently accept a different signature.
 *
 * @example
 * ```ts @import.meta.vitest
 * const message = signatureMessage({
 *   machineId: "m1",
 *   connection: "c1",
 *   seq: "1",
 *   timestamp: "0",
 *   nonce: "0123456789abcdef",
 *   method: "POST",
 *   path: "/rpc",
 *   bodyHash: "00",
 * });
 * expect(new TextDecoder().decode(message)).toBe(
 *   '["hns.machine.request.v1","m1","c1","1","0","0123456789abcdef","POST","/rpc","00"]',
 * );
 * ```
 */
export function signatureMessage(input: RequestSignature): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      MACHINE_REQUEST_VERSION,
      input.machineId,
      input.connection,
      input.seq,
      input.timestamp,
      input.nonce,
      input.method,
      input.path,
      input.bodyHash,
    ]),
  );
}

/**
 * One versioned write, as the Worker asks the machine to apply it.
 *
 * @remarks
 * `projectRoot` and `path` are separate: the machine resolves each one below
 * its ROOT, so a `path` cannot name a sibling project and a `projectRoot`
 * cannot climb out. The machine recomputes the version of the target and
 * compares it with `expectedVersion`; the Worker's recorded version is only a
 * fast path. `contentHash` is the hash the intent recorded, so the machine
 * refuses to write bytes the intent does not name. `content` is base64 because
 * the body is JSON.
 */
export interface MachineWriteRequest {
  readonly op: "write";
  /** The project directory below ROOT, as names separated by `/`. */
  readonly projectRoot: string;
  /** The file below the project root; both separators are accepted. */
  readonly path: string;
  /** The version the writer saw, or `"absent"`. */
  readonly expectedVersion: string;
  /** The attempt's id; echoed in the result so the Worker can tie the answer. */
  readonly operationId: string;
  /** The bytes to write, base64. */
  readonly content: string;
  /** The intent's content hash, `sha256:<hex>`; the machine checks the bytes. */
  readonly contentHash: string;
}

/** The write request as it arrives, parsed at the boundary. */
export const MachineWriteRequestSchema: v.GenericSchema<unknown, MachineWriteRequest> = v.object({
  op: v.literal("write"),
  projectRoot: v.string(),
  path: v.string(),
  expectedVersion: v.pipe(v.string(), v.minLength(1)),
  operationId: OperationIdSchema,
  content: v.string(),
  contentHash: v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/u)),
});

/** The unknown reasons a machine may answer with, taken from the core model. */
export const MACHINE_WRITE_UNKNOWN_REASONS = [
  "io",
  "crash",
  "timeout",
] as const satisfies readonly MutationUnknownReason[];

/**
 * What the machine answers for a write: the mutation result plus the resolved path.
 *
 * @remarks
 * `applied` carries the version of the bytes it wrote; `conflict` carries the
 * version it found instead and means nothing was written; `unknown` means the
 * machine could not decide, so the Worker must not round it to either of the
 * other two. Each member is a `MutationResult` member plus the resolved path,
 * spelled as a union so narrowing on `status` works at the call site.
 */
export type MachineWriteResult =
  | {
      readonly status: "applied";
      readonly operationId: string;
      readonly version: string;
      readonly path: string;
    }
  | {
      readonly status: "conflict";
      readonly operationId: string;
      readonly currentVersion: string;
      readonly path: string;
    }
  | {
      readonly status: "unknown";
      readonly operationId: string;
      readonly reason: MutationUnknownReason;
      readonly path: string;
    };

/** The write result as it arrives, parsed at the boundary. */
export const MachineWriteResultSchema: v.GenericSchema<unknown, MachineWriteResult> = v.variant(
  "status",
  [
    v.object({
      status: v.literal("applied"),
      operationId: v.string(),
      version: v.string(),
      path: v.string(),
    }),
    v.object({
      status: v.literal("conflict"),
      operationId: v.string(),
      currentVersion: v.string(),
      path: v.string(),
    }),
    v.object({
      status: v.literal("unknown"),
      operationId: v.string(),
      reason: v.picklist(MACHINE_WRITE_UNKNOWN_REASONS),
      path: v.string(),
    }),
  ],
);

/**
 * What the machine answers for a read: the bytes as base64 and their version.
 *
 * @remarks
 * `version` names the exact bytes in `content`, in the `sha256:<hex>` spelling
 * the workspace uses. A read never follows a symbolic link as its final
 * component, so the bytes come from below ROOT.
 */
export type MachineReadResult = {
  readonly path: string;
  readonly size: number;
  readonly version: string;
  readonly content: string;
};

/** The read result as it arrives, parsed at the boundary. */
export const MachineReadResultSchema: v.GenericSchema<unknown, MachineReadResult> = v.object({
  path: v.string(),
  size: v.number(),
  version: v.string(),
  content: v.string(),
});
