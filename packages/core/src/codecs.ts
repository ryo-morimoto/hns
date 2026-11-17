import * as v from "valibot";
import type { Brand, ConversationId, ProjectId } from "./types.ts";

/**
 * An ISO 8601 timestamp.
 *
 * @remarks
 * Only `isoTimestamp()` / `IsoTimestampSchema` build the brand. The value is the validated
 * string, not a `Date`; the store writes `new Date().toISOString()`.
 */
export type IsoTimestamp = Brand<string, "IsoTimestamp">;

/**
 * The valibot schema for `IsoTimestamp`.
 *
 * @remarks
 * `v.parse` throws `ValiError` for a non-string or a string that is not ISO 8601; the transform
 * only adds the brand.
 */
export const IsoTimestampSchema: v.GenericSchema<unknown, IsoTimestamp> = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.transform((value): IsoTimestamp => {
    // SAFETY: the value passed v.isoTimestamp(); the brand exists only in the type.
    return value as IsoTimestamp;
  }),
);

/**
 * Build an `IsoTimestamp` from a string.
 *
 * @param value - Untrusted timestamp text.
 * @returns The same text, branded.
 * @throws ValiError when `value` is not an ISO 8601 timestamp.
 */
export function isoTimestamp(value: string): IsoTimestamp {
  return v.parse(IsoTimestampSchema, value);
}

/**
 * A mutation id on the wire.
 *
 * @remarks
 * Opaque to the workspace, which never uses it as a path. The wire rule is letters, digits, `_`
 * and `-`, 1 to 64 characters; only `operationId()` / `OperationIdSchema` build the brand.
 */
export type OperationId = Brand<string, "OperationId">;

/**
 * The base64url alphabet, in one place: letters, digits, `_` and `-`.
 *
 * @remarks
 * The operation id uses it, and so does a device key's spelling ({@link encodeDeviceKey}); one
 * constant keeps the two from drifting.
 */
export const BASE64URL_ALPHABET = "A-Za-z0-9_-";

/** The wire format, in one place: letters, digits, "_" and "-", 1 to 64 characters. */
const OPERATION_ID_ALPHABET = BASE64URL_ALPHABET;
const OPERATION_ID_MAX_LENGTH = 64;
const OPERATION_ID = new RegExp(`^[${OPERATION_ID_ALPHABET}]{1,${OPERATION_ID_MAX_LENGTH}}$`);
const NOT_OPERATION_ID = new RegExp(`[^${OPERATION_ID_ALPHABET}]`, "g");

/**
 * The valibot schema for `OperationId`.
 *
 * @remarks
 * `v.parse` throws `ValiError` when the value is not a string or falls outside the wire rule.
 */
export const OperationIdSchema: v.GenericSchema<unknown, OperationId> = v.pipe(
  v.string(),
  v.regex(
    OPERATION_ID,
    `operationId must be 1-${OPERATION_ID_MAX_LENGTH} characters of [${OPERATION_ID_ALPHABET}]`,
  ),
  v.transform((value): OperationId => {
    // SAFETY: the value passed the regex; the brand exists only in the type.
    return value as OperationId;
  }),
);

/**
 * Build an `OperationId` from a string.
 *
 * @param value - Id text that must already match the wire rule.
 * @returns The same text, branded.
 * @throws ValiError when `value` is empty, longer than 64 characters, or contains another
 * character.
 */
export function operationId(value: string): OperationId {
  return v.parse(OperationIdSchema, value);
}

/**
 * Derive an OperationId from arbitrary text: outside characters become "-", then the length is capped.
 *
 * @param text - Arbitrary text, such as a tool call's diagnostic label.
 * @returns An id that satisfies `OperationIdSchema`.
 * @throws ValiError when `text` is empty, because the derived id would have no characters.
 *
 * @remarks
 * Every character outside the wire alphabet becomes `-`; a longer result is truncated to 64
 * characters. Only empty text fails.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(operationIdFrom("a b")).toBe("a-b");
 * expect(operationIdFrom("x".repeat(80)).length).toBe(64);
 * ```
 */
export function operationIdFrom(text: string): OperationId {
  return operationId(text.replaceAll(NOT_OPERATION_ID, "-").slice(0, OPERATION_ID_MAX_LENGTH));
}

/**
 * Parse an untrusted value into a `ProjectId`.
 *
 * @remarks
 * Any string is accepted; the schema exists to move an id across the boundary and add the brand.
 * `v.parse` throws `ValiError` for a non-string.
 */
export const ProjectIdSchema: v.GenericSchema<unknown, ProjectId> = v.pipe(
  v.string(),
  v.transform((value): ProjectId => {
    // SAFETY: the value is a validated string; the brand exists only in the type.
    return value as ProjectId;
  }),
);

/**
 * Parse an untrusted value into a `ConversationId`.
 *
 * @remarks
 * Any string is accepted; the schema exists to move an id across the boundary and add the brand.
 * `v.parse` throws `ValiError` for a non-string.
 */
export const ConversationIdSchema: v.GenericSchema<unknown, ConversationId> = v.pipe(
  v.string(),
  v.transform((value): ConversationId => {
    // SAFETY: the value is a validated string; the brand exists only in the type.
    return value as ConversationId;
  }),
);
