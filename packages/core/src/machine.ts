import * as v from "valibot";
import { OperationIdSchema } from "./codecs.ts";
import {
  MUTATION_UNKNOWN_REASONS,
  type AbsentVersion,
  type MutationUnknownReason,
} from "./types.ts";

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

/** The header that carries the signature itself; it authenticates the other fields. */
export const SIGNATURE_HEADER = "x-hns-signature" as const;

/**
 * The field each header bears, excluding the signature header: the one place the header-to-field
 * pairs are written.
 *
 * @remarks
 * Every later name is derived from this object: {@link SIGNED_FIELDS} (the same pairs, reversed),
 * {@link RequestSignature} (its keys), {@link SignedHeaders} (its keys plus the signature), and
 * {@link SIGNED_HEADER_BY_FIELD} (the same pairs again). A header added to {@link SIGNED_HEADERS}
 * does not compile until this map names its field, and a field added here reaches the signer and
 * the verifier together. The order is {@link SIGNED_HEADERS}'s order.
 */
export const SIGNED_FIELD_BY_HEADER = {
  "x-hns-machine": "machineId",
  "x-hns-connection": "connection",
  "x-hns-seq": "seq",
  "x-hns-timestamp": "timestamp",
  "x-hns-nonce": "nonce",
} as const satisfies Record<Exclude<SignedHeaderName, typeof SIGNATURE_HEADER>, string>;

/** One field a machine request signature carries in a header. */
export type SignedField = (typeof SIGNED_FIELD_BY_HEADER)[keyof typeof SIGNED_FIELD_BY_HEADER];

/** The signed fields, in header order. */
export const SIGNED_FIELDS = [
  "machineId",
  "connection",
  "seq",
  "timestamp",
  "nonce",
] as const satisfies readonly SignedField[];

/** The header-to-field map with the keys and values swapped. */
type HeaderByField = {
  readonly [K in keyof typeof SIGNED_FIELD_BY_HEADER as (typeof SIGNED_FIELD_BY_HEADER)[K]]: K;
} & { readonly signature: typeof SIGNATURE_HEADER };

/**
 * The header that carries each signed field, the inverse of {@link SIGNED_FIELD_BY_HEADER}.
 *
 * @remarks
 * Both the signer and the verifier read names from here, so a renamed header cannot leave one
 * side reading a literal that the other side no longer sends. The order is the array's order.
 */
// SAFETY: the mapped type is the inverse of SIGNED_FIELD_BY_HEADER, which covers every header of
// SIGNED_HEADERS except SIGNATURE_HEADER; this loop walks that list once, so each field is set.
export const SIGNED_HEADER_BY_FIELD = Object.fromEntries(
  SIGNED_HEADERS.map((header) => [
    header === SIGNATURE_HEADER ? "signature" : SIGNED_FIELD_BY_HEADER[header],
    header,
  ]),
) as HeaderByField;

/** The only route the machine agent answers; the signature covers this path. */
export const MACHINE_RPC_PATH = "/rpc";

/**
 * The exact fields one machine request signature covers.
 *
 * @remarks
 * Every field is the text that travels on the wire (the seq and timestamp stay
 * decimal strings), because a number formatted differently would sign
 * differently. `bodyHash` is the SHA-256 of the body bytes, in hex. The signature header is not
 * a field here: it authenticates the rest of the message. The header-borne fields come from
 * {@link SIGNED_FIELD_BY_HEADER}, so this type cannot list them again.
 */
export type RequestSignature = Readonly<{ [K in SignedField]: string }> & {
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
};

/**
 * The signed headers as the verifier parses them: every header-borne field, still on the wire
 * spelling. The signature is one of them; it is not part of the message it authenticates.
 */
export type SignedHeaders = Readonly<
  { readonly [K in SignedField]: string } & { readonly "x-hns-signature": string }
>;

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
  /** The version the writer saw, or {@link AbsentVersion} when it expects the name to be free. */
  readonly expectedVersion: AbsentVersion;
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
export const MACHINE_WRITE_UNKNOWN_REASONS = MUTATION_UNKNOWN_REASONS;

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
      readonly currentVersion: AbsentVersion;
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
