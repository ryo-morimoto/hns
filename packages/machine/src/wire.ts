import * as v from "valibot";
import type { IncomingHttpHeaders } from "node:http";
import { MachineReadResultSchema, MachineWriteRequestSchema } from "@hns/core";
import type { JsonValue, MachineReadResult, MachineWriteRequest } from "@hns/core";
import { MachineRefusal, REFUSAL_CODES } from "./refusal.ts";
import type { RefusalCode } from "./refusal.ts";

export { SIGNED_HEADERS } from "@hns/core";
export type { SignedHeaderName } from "@hns/core";

/** The parsed headers of one signed request, each field still on the wire spelling. */
export interface SignedHeaders {
  readonly machineId: string;
  readonly connection: string;
  /** A positive decimal string; the signature covers the text, not a number. */
  readonly seq: string;
  /** Epoch milliseconds as a decimal string. */
  readonly timestamp: string;
  readonly nonce: string;
  /** Base64url of the 64-byte Ed25519 signature. */
  readonly signature: string;
}

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

const SignedHeadersSchema: v.GenericSchema<unknown, SignedHeaders> = v.object({
  machineId: v.pipe(HeaderText, v.regex(/^[A-Za-z0-9._:-]{1,128}$/)),
  connection: v.pipe(HeaderText, v.regex(/^[A-Za-z0-9._:-]{1,128}$/)),
  seq: v.pipe(HeaderText, v.regex(/^[1-9][0-9]{0,15}$/)),
  timestamp: v.pipe(HeaderText, v.regex(/^[0-9]{1,16}$/)),
  nonce: v.pipe(HeaderText, v.regex(/^[\w-]{16,64}$/)),
  signature: v.pipe(HeaderText, v.regex(/^[\w-]{86}$/)),
});

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
  const parsed = v.safeParse(SignedHeadersSchema, {
    machineId: headers["x-hns-machine"],
    connection: headers["x-hns-connection"],
    seq: headers["x-hns-seq"],
    timestamp: headers["x-hns-timestamp"],
    nonce: headers["x-hns-nonce"],
    signature: headers["x-hns-signature"],
  });
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
