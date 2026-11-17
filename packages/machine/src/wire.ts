import * as v from "valibot";
import type { IncomingHttpHeaders } from "node:http";
import {
  MachineReadResultSchema,
  MachineWriteRequestSchema,
  OBS_REQUEST_ID_PATTERN,
  SIGNED_HEADER_BY_FIELD,
} from "@hns/core";
import type { JsonValue, MachineReadResult, MachineWriteRequest, SignedHeaders } from "@hns/core";
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

/** The operations the agent answers; each is one closed member. */
export const OPERATION_NAMES = ["health", "stat", "read", "list", "write"] as const;

/** One operation name. */
export type OperationName = (typeof OPERATION_NAMES)[number];

/** The closed request body: an operation and the ROOT-relative path it names. */
export type Operation =
  | { readonly op: "health" }
  | { readonly op: "stat"; readonly path: string }
  | { readonly op: "read"; readonly path: string }
  | { readonly op: "list"; readonly path: string }
  | MachineWriteRequest;

const OperationSchema: v.GenericSchema<unknown, Operation> = v.union([
  v.variant("op", [
    v.object({ op: v.literal("health") }),
    v.object({ op: v.literal("stat"), path: v.string() }),
    v.object({ op: v.literal("read"), path: v.string() }),
    v.object({ op: v.literal("list"), path: v.string() }),
  ]),
  MachineWriteRequestSchema,
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
 * A successful answer: the operation name and its result, which is JSON on the
 * wire and is parsed into the operation's result type by the caller.
 */
export interface SuccessBody {
  readonly ok: true;
  readonly op: OperationName;
  readonly result: JsonValue;
}

/** A refused answer: the closed code and a diagnostic message. */
export interface RefusalBody {
  readonly ok: false;
  readonly code: RefusalCode;
  readonly message: string;
}

/** What the agent writes: one success or one refusal. */
export type ResponseBody = SuccessBody | RefusalBody;

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
