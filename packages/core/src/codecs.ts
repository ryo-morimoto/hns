import * as v from "valibot";
import type { Brand } from "./types.ts";

/** An ISO 8601 timestamp. Only isoTimestamp() / IsoTimestampSchema build the brand. */
export type IsoTimestamp = Brand<string, "IsoTimestamp">;

export const IsoTimestampSchema: v.GenericSchema<unknown, IsoTimestamp> = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.transform((value): IsoTimestamp => {
    // SAFETY: the value passed v.isoTimestamp(); the brand exists only in the type.
    return value as IsoTimestamp;
  }),
);

export function isoTimestamp(value: string): IsoTimestamp {
  return v.parse(IsoTimestampSchema, value);
}

/** A mutation id on the wire. Opaque to the workspace, which never uses it as a path. */
export type OperationId = Brand<string, "OperationId">;

/** The wire format, in one place: letters, digits, "_" and "-", 1 to 64 characters. */
const OPERATION_ID_ALPHABET = "A-Za-z0-9_-";
const OPERATION_ID_MAX_LENGTH = 64;
const OPERATION_ID = new RegExp(`^[${OPERATION_ID_ALPHABET}]{1,${OPERATION_ID_MAX_LENGTH}}$`);
const NOT_OPERATION_ID = new RegExp(`[^${OPERATION_ID_ALPHABET}]`, "g");

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

export function operationId(value: string): OperationId {
  return v.parse(OperationIdSchema, value);
}

/** Derive an OperationId from arbitrary text: outside characters become "-", then the length is capped. */
export function operationIdFrom(text: string): OperationId {
  return operationId(text.replaceAll(NOT_OPERATION_ID, "-").slice(0, OPERATION_ID_MAX_LENGTH));
}
