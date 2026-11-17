import * as v from "valibot";
import { ConversationIdSchema, IsoTimestampSchema } from "@hns/core";
import type { ConversationCursor } from "@hns/store";

/** One cursor is `[updatedAt, id]`, in the list's ordering key. */
const CursorSchema = v.tuple([IsoTimestampSchema, ConversationIdSchema]);

/** Encode UTF-8 text as unpadded base64url. */
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Decode unpadded base64url to UTF-8 text, or undefined when it is not valid. */
function decode(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Encode the position a conversation page stopped at.
 *
 * @param cursor - The page's next position, or null when the page is the last one.
 * @returns The opaque cursor, or null.
 *
 * @remarks
 * The cursor is the keyset pair, not an offset: a client returns it unchanged as `after`. It
 * carries no authority, so a forged one can only move the window.
 */
export function encodeCursor(cursor: ConversationCursor | null): string | null {
  if (cursor === null) return null;
  return encode(JSON.stringify([cursor.updatedAt, cursor.id]));
}

/**
 * Decode an `after` argument.
 *
 * @param value - The client's cursor.
 * @returns The position, or undefined when the text is not a cursor.
 *
 * @remarks
 * Never throws: the argument is untrusted, and the resolver answers an invalid one with
 * `invalid_argument` rather than a 500.
 */
export function decodeCursor(value: string): ConversationCursor | undefined {
  const text = decode(value);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = v.safeParse(CursorSchema, parsed);
  if (!result.success) return undefined;
  return { updatedAt: result.output[0], id: result.output[1] };
}
