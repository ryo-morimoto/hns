import * as v from "valibot";
import { OperationIdSchema } from "./codecs.ts";
import {
  OFFICE_PATH_HASH_PATTERN,
  OFFICE_PARAMS_HASH_PATTERN,
  OFFICE_SHA256_PATTERN,
  OfficeEngineReportSchema,
  OfficeEngineRequestSchema,
  OfficeRequestSchema,
  OfficeResultSchema,
  type OfficeCacheKey,
  type OfficeEngineReport,
  type OfficeJob,
  type OfficeResult,
} from "./office.ts";
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
// The signature header carries no field of the message; it is the signature itself.
export type SignedHeaders = Readonly<Pick<RequestSignature, SignedField> & { signature: string }>;

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
 * refuses to write bytes the intent does not name.
 *
 * **The bytes come from one of two sources and never both**, which is why this
 * is a union of two members over a shared body rather than an optional field
 * each. A `content` write carries base64 in the body because the body is JSON;
 * a `source` write names an office cache entry, so a 31 MB converted PDF never
 * crosses the Worker's body bound (0241; D103 §5).
 */
export type MachineWriteRequest = {
  readonly op: "write";
  /** The project directory below ROOT, as names separated by `/`. */
  readonly projectRoot: string;
  /** The file below the project root; both separators are accepted. */
  readonly path: string;
  /** The version the writer saw, or {@link AbsentVersion} when it expects the name to be free. */
  readonly expectedVersion: AbsentVersion;
  /** The attempt's id; echoed in the result so the Worker can tie the answer. */
  readonly operationId: string;
  /** The intent's content hash, `sha256:<hex>`; the machine checks the bytes it writes. */
  readonly contentHash: string;
} & (
  | {
      /** The bytes to write, base64; the body carries them. */
      readonly content: string;
      readonly source?: undefined;
    }
  | {
      /** The office cache entry to copy; the body carries no bytes. */
      readonly source: OfficeCacheSource;
    }
);

/** The schema for {@link OfficeCacheSource}: the 5-tuple and its `kind`, and no other key (§4). */
export const OfficeCacheSourceSchema: v.GenericSchema<unknown, OfficeCacheSource> = v.strictObject({
  kind: v.literal("office-cache"),
  workspaceId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  pathHash: v.pipe(v.string(), v.regex(OFFICE_PATH_HASH_PATTERN, "a path hash is 16 hex")),
  version: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a version is sha256:<64 hex>")),
  operation: v.picklist(["preview", "render"]),
  paramsHash: v.pipe(v.string(), v.regex(OFFICE_PARAMS_HASH_PATTERN, "a params hash is 16 hex")),
});

/**
 * The write request as it arrives, parsed at the boundary.
 *
 * @remarks
 * **The bytes come from exactly one of two places, and never both.** A `content` write carries the
 * bytes in the body as base64; a `source` write names a file the machine already holds, in the
 * office cache, and carries none. The two are one union so a request that names both does not
 * parse, and a request that names neither does not either: a body that carried both would leave
 * the machine choosing which bytes to write.
 *
 * `contentHash` is required on both: the machine checks the bytes it is about to write against
 * the hash the intent recorded, for a cache's bytes as much as for a body's.
 */
export const MachineWriteRequestSchema: v.GenericSchema<unknown, MachineWriteRequest> = v.pipe(
  v.union([
    v.strictObject({
      op: v.literal("write"),
      projectRoot: v.string(),
      path: v.string(),
      expectedVersion: v.pipe(v.string(), v.minLength(1)),
      operationId: OperationIdSchema,
      contentHash: v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/u)),
      content: v.string(),
    }),
    v.strictObject({
      op: v.literal("write"),
      projectRoot: v.string(),
      path: v.string(),
      expectedVersion: v.pipe(v.string(), v.minLength(1)),
      operationId: OperationIdSchema,
      contentHash: v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/u)),
      source: OfficeCacheSourceSchema,
    }),
  ]),
  v.check(
    (request) => !("content" in request && "source" in request),
    "a write carries a content or a source, not both",
  ),
);

/**
 * One read from the office cache, as a write names its bytes (0241; D103).
 *
 * @remarks
 * **Structured, never a key string.** The parts are the artifact's 5-tuple ({@link OfficeCacheKey}),
 * and the machine builds the cache path from them with {@link officeCachePath} — the same function
 * the artifact route uses — so a `source` can only name a file inside the cache: no part is a
 * path segment the request supplies, and the file name is derived from `operation`, not given.
 *
 * `version` is the artifact's content hash. The machine reads the cache's bytes, checks their
 * SHA-256 against `contentHash` (the write's own field), and renames only then: a file replaced
 * between the `office` answer and the write is refused as `engine_failed` rather than copied
 * (0241 C8).
 *
 * `kind` is the discriminator: the field is a union member so a second source (a run's output,
 * a checkpoint's file) can be added without changing the write's own fields.
 */
export type OfficeCacheSource = { readonly kind: "office-cache" } & OfficeCacheKey;

/** The unknown reasons a machine may answer with, taken from the core model. */
export const MACHINE_WRITE_UNKNOWN_REASONS = MUTATION_UNKNOWN_REASONS;

/**
 * The closed set of refusals a machine agent can answer with.
 *
 * @remarks
 * A refusal is an expected answer, not a bug: the caller is unauthenticated, the request is a
 * replay, the path is outside ROOT, or a limit is reached. The code is the contract; the
 * message is diagnostic. The machine agent's implementation is the same list; a parity test
 * pins the two, so a code added on one side without the other fails loudly.
 */
export const MACHINE_REFUSALS = [
  "unauthorized",
  "stale_request",
  "replayed",
  "stale_connection",
  "invalid_request",
  "path_denied",
  "forbidden",
  "not_found",
  "busy",
  "too_large",
  "deadline_exceeded",
  "method_not_allowed",
  "internal",
] as const;

/** One refusal a machine may answer with (one member of {@link MACHINE_REFUSALS}). */
export type MachineRefusalCode = (typeof MACHINE_REFUSALS)[number];

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

/**
 * The office operations the machine's `/rpc` accepts, as request and result pairs (§5).
 *
 * @remarks
 * Two ops are added beside the file operations, and **the ones already there are unchanged**: an
 * older Worker that never sends `office` still gets exactly the answers it did. The pair is
 * written here, next to the rest of the RPC contract, but the vocabulary is
 * `@hns/core/office`'s: the request is a job and the result is `OfficeResult`, so all four
 * lanes read one definition.
 *
 * **Neither request carries bytes and neither result does.** A preview may be 50 MiB and a JSON
 * answer is bounded at 256 KiB, so the artifact travels on `GET /artifact`, a binary route signed
 * over the whole request target (`MACHINE_ARTIFACT_PATH` and `artifactTarget` in
 * `./office.ts`). Adding `office` here does not widen the JSON surface; it adds a route.
 */
export interface MachineOfficeRequest {
  readonly op: "office";
  /** The job: what to read, what to do, and the bounds to enforce. */
  readonly job: OfficeJob;
}

/**
 * The office job as it arrives, parsed at the boundary with the contract's own schema.
 *
 * @remarks
 * `OfficeRequestSchema` is `./office.ts`'s, not a second object written here: one wire has one
 * definition. It is strict, so a body with a second key is refused rather than silently dropped
 * (0228 chose `strictObject` for the granted call for the same reason).
 */
export const MachineOfficeRequestSchema: v.GenericSchema<unknown, MachineOfficeRequest> =
  OfficeRequestSchema;

/**
 * The engine probe (§5): no parameters, one report.
 *
 * @remarks
 * Its own op because nothing else reads the pack's manifest, and it does not take the office's
 * single slot: a probe while a job runs answers the capability rather than `engine_busy`.
 */
export interface MachineOfficeEngineRequest {
  readonly op: "officeEngine";
}

/** The engine probe as it arrives, parsed at the boundary with the contract's own schema. */
export const MachineOfficeEngineRequestSchema: v.GenericSchema<
  unknown,
  MachineOfficeEngineRequest
> = OfficeEngineRequestSchema;

/**
 * What the office ops answer (§5).
 *
 * @remarks
 * An office job answers `OfficeResult` and a probe answers `OfficeEngineReport`; both are the
 * contract's types, re-exported as the machine's results so a caller of this module does not have
 * to name two entry points for one answer. A refusal (bad signature, busy slot, deadline) is a
 * {@link MachineRefusalCode} beside these, never inside them: the two are different kinds of
 * answer, one expected and typed per job, one about the request itself.
 */
export type MachineOfficeResult = OfficeResult;

/** The office job answer as it arrives, parsed at the boundary. */
export const MachineOfficeResultSchema: v.GenericSchema<unknown, MachineOfficeResult> =
  OfficeResultSchema;

/** The engine report as it arrives, parsed at the boundary. */
export const MachineOfficeEngineResultSchema: v.GenericSchema<unknown, OfficeEngineReport> =
  OfficeEngineReportSchema;
