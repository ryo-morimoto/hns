import * as v from "valibot";
import type { IncomingHttpHeaders } from "node:http";
import {
  CHECKPOINT_PACK_CONTENT_TYPE,
  CheckpointPackUploadResultSchema,
  CheckpointPrepareResultSchema,
  MACHINE_RPC_PATH,
  MIRROR_FAILURES,
  MachineReadResultSchema,
  MachineWriteRequestSchema,
  OBS_REQUEST_ID_PATTERN,
  SIGNED_HEADER_BY_FIELD,
} from "@hns/core";
import type {
  CheckpointPackUploadResult,
  CheckpointPrepareResult,
  JsonValue,
  MirrorFailure,
  MachineReadResult,
  MachineWriteRequest,
  SignedHeaders,
} from "@hns/core";
import { MachineRefusal, REFUSAL_CODES } from "./refusal.ts";
import type { RefusalCode } from "./refusal.ts";

export { SIGNED_HEADERS } from "@hns/core";
export type { SignedHeaderName, SignedHeaders } from "@hns/core";

/** The header each field arrives in, from the core map. */
const HEADER_OF: Readonly<Record<keyof SignedHeaders, string>> = SIGNED_HEADER_BY_FIELD;

/** A header value as Node hands it over, before any parsing. */
const HeaderValue = v.union([v.string(), v.array(v.string()), v.undefined()]);

/** Exactly one occurrence of a header, as non-empty text; missing or repeated fails. */
const HeaderText = v.pipe(
  HeaderValue,
  v.transform((value) => (Array.isArray(value) ? value : [value ?? ""])),
  v.length(1),
  v.transform((values) => values.join("")),
  v.minLength(1),
);

/**
 * Each signed header as it arrives: exactly once, and matching the rule of the field it carries.
 *
 * @remarks
 * The machine id and the connection follow the edge's correlation-id rule (it is the same safe
 * printable set); the rest are a sequence, a timestamp, a nonce, and a base64url signature.
 */
const SIGNED_HEADER_RULES = {
  machineId: v.pipe(HeaderText, v.regex(OBS_REQUEST_ID_PATTERN)),
  connection: v.pipe(HeaderText, v.regex(OBS_REQUEST_ID_PATTERN)),
  seq: v.pipe(HeaderText, v.regex(/^[1-9][0-9]{0,15}$/u)),
  timestamp: v.pipe(HeaderText, v.regex(/^[0-9]{1,16}$/u)),
  nonce: v.pipe(HeaderText, v.regex(/^[\w-]{16,64}$/u)),
  signature: v.pipe(HeaderText, v.regex(/^[\w-]{86}$/u)),
} satisfies Record<keyof SignedHeaders, v.GenericSchema<unknown, string>>;

const SignedHeadersSchema: v.GenericSchema<unknown, SignedHeaders> = v.object(SIGNED_HEADER_RULES);

/**
 * The wire headers keyed by field, each still unparsed.
 *
 * @param headers - The request's headers as Node parsed them.
 * @returns One value per field of {@link SignedHeaders}; the schema refuses a missing or
 * repeated one.
 */
function headerValuesByField(
  headers: IncomingHttpHeaders,
): Record<keyof SignedHeaders, string | string[] | undefined> {
  let values: Record<keyof SignedHeaders, string | string[] | undefined> = {
    machineId: undefined,
    connection: undefined,
    seq: undefined,
    timestamp: undefined,
    nonce: undefined,
    signature: undefined,
  };
  for (const [field, header] of Object.entries(HEADER_OF)) {
    Object.assign(values, { [field]: headers[header] });
  }
  return values;
}

/**
 * Parse the signed headers of one request.
 *
 * @param headers - The request's headers as Node parsed them.
 * @returns The six fields, with `seq` and `timestamp` still as text.
 * @throws {MachineRefusal} With code `unauthorized`: a request that cannot
 * even carry a signature is not authenticated, and a repeated header is
 * refused rather than guessed.
 */
export function parseSignedHeaders(headers: IncomingHttpHeaders): SignedHeaders {
  const parsed = v.safeParse(SignedHeadersSchema, headerValuesByField(headers));
  if (!parsed.success) {
    throw new MachineRefusal("unauthorized", "the request is not signed with the machine headers");
  }
  return parsed.output;
}

/**
 * The route a checkpoint pack arrives on, below {@link MACHINE_RPC_PATH}.
 *
 * @remarks
 * `/rpc/checkpoint/<runId>/pack`. The signed message already covers the path, so a pack signed
 * for one Run cannot be replayed at another: the signature covers the path string, and the path
 * holds the Run id.
 */
const PACK_PATH_PREFIX = MACHINE_RPC_PATH + "/checkpoint/";
const PACK_PATH_SUFFIX = "/pack";

/**
 * The `op` a successful pack upload answers with.
 *
 * @remarks
 * A pack upload is not one of {@link OPERATION_NAMES}: it has no JSON operation and no body to
 * parse. The name is still in the response envelope so a caller can tell the two success shapes
 * apart without reading the route it called.
 */
export const PACK_RESPONSE_OP = "pack";

/**
 * The media type a pack's body must carry.
 *
 * @remarks
 * The checkpoint contract's ({@link CHECKPOINT_PACK_CONTENT_TYPE}), re-exported through this
 * module because the route reads it. The body is a git pack, never JSON, and a request that
 * labels it as anything else is refused before a byte of it is kept.
 */
export const MACHINE_PACK_CONTENT_TYPE = CHECKPOINT_PACK_CONTENT_TYPE;

/**
 * Whether a request path is the pack route, and for which Run.
 *
 * @param path - The request URL as the client sent it, query excluded by the caller.
 * @returns The Run id when the path is the pack route, otherwise undefined.
 *
 * @remarks
 * Only the shape is decided here; whether the Run id is usable is the checkpoint's
 * `assertRunId`. A path that does not match is not the pack route, so the agent answers it the
 * way it answers every other unknown route.
 */
export function checkpointPackRunId(path: string): string | undefined {
  if (!path.startsWith(PACK_PATH_PREFIX) || !path.endsWith(PACK_PATH_SUFFIX)) return undefined;
  const runId = path.slice(PACK_PATH_PREFIX.length, path.length - PACK_PATH_SUFFIX.length);
  return runId === "" || runId.includes("/") ? undefined : runId;
}

/**
 * The pack route for one Run.
 *
 * @param runId - The Run id.
 * @returns `/rpc/checkpoint/<runId>/pack`; {@link checkpointPackRunId} reads it back.
 */
export function checkpointPackPath(runId: string): string {
  return PACK_PATH_PREFIX + runId + PACK_PATH_SUFFIX;
}

/** The operations the agent answers; each is one closed member. */
export const OPERATION_NAMES = [
  "health",
  "stat",
  "read",
  "list",
  "write",
  "checkpoint",
  "mirror",
] as const;

/** One operation name. */
export type OperationName = (typeof OPERATION_NAMES)[number];

/**
 * One checkpoint of one Run, as the Worker asks for it.
 *
 * @remarks
 * The answer is metadata only ({@link CheckpointResult}): the pack is a separate binary request
 * to {@link checkpointPackPath}. `committedAt` is Unix seconds and pins the commit, so a retried
 * prepare of a Run that has no checkpoint yet still makes the same commit.
 */
export interface CheckpointRequest {
  readonly op: "checkpoint";
  /** The Run id; it names `refs/hns/checkpoints/<runId>` and is the idempotency key. */
  readonly runId: string;
  /** Commit time in Unix seconds; the default is the machine's clock. */
  readonly committedAt?: number | undefined;
}

const CheckpointRequestSchema: v.GenericSchema<unknown, CheckpointRequest> = v.object({
  op: v.literal("checkpoint"),
  runId: v.pipe(v.string(), v.minLength(1)),
  committedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

/**
 * Push one checkpoint commit to Artifacts, as the Worker asks for it.
 *
 * @remarks
 * The Worker builds this from the `MirrorTarget` its prepare answered with and the commit that
 * prepare reported. `token` is a secret: the agent uses it in the push's environment and does not
 * copy it into its log or its answer (the answer names the status, the ref, and the commit only).
 * `ref` must be a branch under `refs/heads/`: a private ref cannot be read back through the
 * binding, so a push to one would be a mirror nothing could confirm.
 */
export interface MirrorRequest {
  readonly op: "mirror";
  /** The workspace's git repository is ROOT; `committedAt` is not needed because C exists. */
  readonly runId: string;
  readonly remote: string;
  /** The write token; a secret, valid only for the push. */
  readonly token: string;
  readonly ref: string;
  /** The commit C the ref must land on. */
  readonly commit: string;
  /** When the token stops working (ISO 8601). Advisory: the push itself decides. */
  readonly expiresAt: string;
}

const MirrorRequestSchema: v.GenericSchema<unknown, MirrorRequest> = v.object({
  op: v.literal("mirror"),
  runId: v.pipe(v.string(), v.minLength(1)),
  remote: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  token: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  ref: v.pipe(v.string(), v.startsWith("refs/heads/"), v.maxLength(1024)),
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  expiresAt: v.pipe(v.string(), v.minLength(1)),
});

/** The closed request body: an operation and the ROOT-relative path it names. */
export type Operation =
  | { readonly op: "health" }
  | { readonly op: "stat"; readonly path: string }
  | { readonly op: "read"; readonly path: string }
  | { readonly op: "list"; readonly path: string }
  | MachineWriteRequest
  | CheckpointRequest
  | MirrorRequest;

const OperationSchema: v.GenericSchema<unknown, Operation> = v.union([
  v.variant("op", [
    v.object({ op: v.literal("health") }),
    v.object({ op: v.literal("stat"), path: v.string() }),
    v.object({ op: v.literal("read"), path: v.string() }),
    v.object({ op: v.literal("list"), path: v.string() }),
  ]),
  MachineWriteRequestSchema,
  CheckpointRequestSchema,
  MirrorRequestSchema,
]);

/**
 * Parse a request body into one operation.
 *
 * @param body - The exact bytes that were signed.
 * @returns The operation; unknown keys are dropped, a missing path is refused.
 * @throws {MachineRefusal} With code `invalid_request` for bytes that are not
 * UTF-8 JSON or do not name a known operation. A corrupt body is a refusal,
 * never a default.
 */
export function parseOperation(body: Uint8Array): Operation {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new MachineRefusal("invalid_request", "the body is not JSON");
  }
  const parsed = v.safeParse(OperationSchema, raw);
  if (!parsed.success) {
    throw new MachineRefusal("invalid_request", "the body does not name a known operation");
  }
  return parsed.output;
}

/** The kinds of entry a listing reports; anything else is `other`. */
export const MACHINE_FILE_KINDS = ["file", "directory", "symlink", "other"] as const;

/** One kind of file system entry. */
export type MachineFileKind = (typeof MACHINE_FILE_KINDS)[number];

/** What the health operation reports. */
export type HealthResult = { readonly root: string; readonly pid: number };

/** What the stat operation reports: absent, or the entry's kind and metadata. */
export type StatResult =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly kind: MachineFileKind;
      readonly size: number;
      readonly mtimeMs: number;
    };

/** What the read operation reports: the bytes as base64 and their sha256. */
export type ReadResult = MachineReadResult;

/** One entry of a listing. */
export type ListEntry = { readonly name: string; readonly kind: MachineFileKind };

/** What the list operation reports. */
export type ListResult = { readonly entries: readonly ListEntry[] };

/**
 * What the checkpoint operation reports: the checkpoint's metadata, never a pack.
 *
 * @remarks
 * This is the checkpoint contract's prepare answer (0243): the commit, the ref, the R2 key, the
 * object count, the pack's size, the largest blob's size, and whether this call made the commit.
 * The pack travels on {@link checkpointPackPath}, so no field here can hold its bytes and a
 * caller that forgot to upload has nothing to confuse them with.
 */
export type CheckpointResult = CheckpointPrepareResult;

/** What the pack upload reports: the Run and the bytes the body delivered. */
export type CheckpointPackResult = CheckpointPackUploadResult;

/**
 * What the mirror operation reports: the status the contract records, and never the token.
 *
 * @remarks
 * This is the push's answer, not the recorded state: the Worker reports it to the Workspace
 * object (`/rpc/checkpoint/mirror`), which applies the transition table. `status` is `skipped`
 * when the machine decides the run is over Artifacts' limits, so a skipped run costs no push.
 */
export type MirrorResult =
  | {
      readonly status: "mirrored";
      readonly ref: string;
      readonly commit: string;
    }
  | {
      readonly status: "skipped";
      readonly reason: "too_large";
    }
  | {
      readonly status: "failed";
      readonly failure: MirrorFailure;
      readonly ref: string;
    };

/**
 * A successful answer: the operation name and its result, which is JSON on the
 * wire and is parsed into the operation's result type by the caller.
 */
export interface SuccessBody {
  readonly ok: true;
  readonly op: OperationName;
  readonly result: JsonValue;
}

/**
 * A successful pack upload: metadata about the bytes, which are already gone.
 *
 * @remarks
 * `op: "pack"` because the upload is not one of {@link OPERATION_NAMES}: it is not a JSON
 * operation and it does not parse a body. The result is the checkpoint contract's upload answer.
 */
export interface PackSuccessBody {
  readonly ok: true;
  readonly op: typeof PACK_RESPONSE_OP;
  readonly result: JsonValue;
}

/** A refused answer: the closed code and a diagnostic message. */
export interface RefusalBody {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly message: string;
}

/** What the agent writes: one success or one refusal. */
export type ResponseBody = SuccessBody | PackSuccessBody | RefusalBody;

/** A JSON value, recursively: the result of an operation is one on the wire. */
const JsonValueSchema: v.GenericSchema<unknown, JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(JsonValueSchema),
    v.record(v.string(), JsonValueSchema),
  ]),
);

const ResponseBodySchema: v.GenericSchema<unknown, ResponseBody> = v.union([
  v.object({
    ok: v.literal(false),
    code: v.picklist(REFUSAL_CODES),
    message: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    op: v.picklist(OPERATION_NAMES),
    result: JsonValueSchema,
  }),
  v.object({
    ok: v.literal(true),
    op: v.literal(PACK_RESPONSE_OP),
    result: JsonValueSchema,
  }),
]);

/**
 * Parse a response body received from the agent.
 *
 * @param text - The response body as text.
 * @returns The envelope; `result` stays `JsonValue` until the operation's
 * parser is applied.
 * @throws When the text is not a machine response. A caller that cannot parse
 * the answer must not treat it as success.
 */
export function parseResponseBody(text: string): ResponseBody {
  const parsed = v.safeParse(ResponseBodySchema, JSON.parse(text));
  if (!parsed.success) throw new Error("the response is not a machine response");
  return parsed.output;
}

const HealthResultSchema: v.GenericSchema<unknown, HealthResult> = v.object({
  root: v.string(),
  pid: v.number(),
});

const StatResultSchema: v.GenericSchema<unknown, StatResult> = v.variant("exists", [
  v.object({ exists: v.literal(false) }),
  v.object({
    exists: v.literal(true),
    kind: v.picklist(MACHINE_FILE_KINDS),
    size: v.number(),
    mtimeMs: v.number(),
  }),
]);

const ReadResultSchema: v.GenericSchema<unknown, ReadResult> = MachineReadResultSchema;

const ListResultSchema: v.GenericSchema<unknown, ListResult> = v.object({
  entries: v.array(v.object({ name: v.string(), kind: v.picklist(MACHINE_FILE_KINDS) })),
});

/**
 * Parse the result of a health answer.
 *
 * @param value - A success envelope's `result`.
 * @returns The root and pid the agent reported.
 * @throws When the value is not a health result.
 */
export function parseHealthResult(value: JsonValue): HealthResult {
  return v.parse(HealthResultSchema, value);
}

/**
 * Parse the result of a stat answer.
 *
 * @param value - A success envelope's `result`.
 * @returns Whether the path exists, and its kind and metadata when it does.
 * @throws When the value is not a stat result.
 */
export function parseStatResult(value: JsonValue): StatResult {
  return v.parse(StatResultSchema, value);
}

/**
 * Parse the result of a read answer.
 *
 * @param value - A success envelope's `result`.
 * @returns The path, byte size, content version, and base64 content.
 * @throws When the value is not a read result.
 */
export function parseReadResult(value: JsonValue): ReadResult {
  return v.parse(ReadResultSchema, value);
}

/**
 * Parse the result of a list answer.
 *
 * @param value - A success envelope's `result`.
 * @returns The entries, in the order the file system returned them.
 * @throws When the value is not a list result.
 */
export function parseListResult(value: JsonValue): ListResult {
  return v.parse(ListResultSchema, value);
}

/**
 * Parse the result of a checkpoint answer.
 *
 * @param value - A success envelope's `result`.
 * @returns The checkpoint's metadata; a value carrying a pack is not a checkpoint result.
 * @throws When the value is not a prepare result.
 *
 * @remarks
 * The parser is the checkpoint contract's schema (0243), so an answer that gained a field is
 * refused at the boundary instead of being read as if it still had the old shape.
 */
export function parseCheckpointResult(value: JsonValue): CheckpointResult {
  return v.parse(CheckpointPrepareResultSchema, value);
}

/**
 * Parse the result of a pack upload answer.
 *
 * @param value - A success envelope's `result`.
 * @returns The Run and the byte count the upload received.
 * @throws When the value is not an upload result.
 */
export function parseCheckpointPackResult(value: JsonValue): CheckpointPackResult {
  return v.parse(CheckpointPackUploadResultSchema, value);
}

/** The mirror answer's shape: the contract's statuses, and the failures it may name. */
const MirrorResultSchema: v.GenericSchema<unknown, MirrorResult> = v.variant("status", [
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
 * Parse the result of a mirror answer.
 *
 * @param value - A success envelope's `result`.
 * @returns The status, the commit when it mirrored, and the closed failure when it did not.
 * @throws When the value is not a mirror result, or names a failure outside the contract's.
 *
 * @remarks
 * The parser is the closed vocabulary's, so a machine that invented a failure word cannot have
 * it recorded: the answer would be refused at the boundary instead of stored.
 */
export function parseMirrorResult(value: JsonValue): MirrorResult {
  return v.parse(MirrorResultSchema, value);
}
