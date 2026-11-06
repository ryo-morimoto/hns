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

export const OperationIdSchema: v.GenericSchema<unknown, OperationId> = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9_-]{1,64}$/, "operationId must be 1-64 characters of [A-Za-z0-9_-]"),
  v.transform((value): OperationId => {
    // SAFETY: the value passed the regex; the brand exists only in the type.
    return value as OperationId;
  }),
);

export function operationId(value: string): OperationId {
  return v.parse(OperationIdSchema, value);
}
