import * as v from "valibot";

/** The minimum secret length the edge accepts; a shorter key is a configuration error. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** A verified session; `expiresAt` is an epoch millisecond timestamp. */
export interface Session {
  readonly subject: string;
  readonly expiresAt: number;
}

/** The JSON carried inside the cookie; `exp` is in epoch seconds. */
interface SessionPayload {
  readonly v: 1;
  readonly sub: string;
  readonly exp: number;
}

const SessionPayloadSchema: v.GenericSchema<unknown, SessionPayload> = v.object({
  v: v.literal(1),
  sub: v.pipe(v.string(), v.minLength(1)),
  exp: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// RFC 4648 §5 base64url. This is an encoding alphabet, not the operationId rule.
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_CHARS = new Set(BASE64URL_ALPHABET);

/**
 * Base64url-encode bytes without padding.
 *
 * @internal
 */
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * Decode base64url; malformed input is expected at the cookie boundary.
 *
 * @internal
 * @returns The bytes, or null when the value is not valid base64url.
 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length === 0) return null;
  for (const char of value) {
    if (!BASE64URL_CHARS.has(char)) return null;
  }
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - remainder) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    // A malformed cookie is untrusted input, not a defect.
    return null;
  }
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Read exactly one cookie value by name.
 *
 * @internal
 * @returns The value, or null when the cookie is absent or repeated.
 *
 * @remarks
 * A repeated `hns_session` is rejected rather than resolved to the first one: two cookies
 * with the same name are an ambiguous request, and choosing one is a guess.
 */
function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    if (trimmed.slice(0, separator) !== name) continue;
    if (found !== null) return null;
    found = trimmed.slice(separator + 1);
  }
  return found;
}

/**
 * Import the HMAC key for one operation.
 *
 * @internal
 */
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Sign a session into the value of the `hns_session` cookie.
 *
 * @param secret - The HMAC key; at least {@link MIN_SESSION_SECRET_LENGTH} characters.
 * @param session - The subject and expiry to encode.
 * @returns The cookie value, without attributes or a `Set-Cookie` prefix.
 * @throws Error when the secret is short, the subject is empty, or the expiry is not finite.
 *
 * @remarks
 * Issuing the cookie (`Secure`, `HttpOnly`, `SameSite`, `Max-Age`) belongs to the login
 * face. This function owns only the value format.
 */
export async function signSession(secret: string, session: Session): Promise<string> {
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error("session secret is shorter than " + String(MIN_SESSION_SECRET_LENGTH));
  }
  if (session.subject.length === 0) throw new Error("session subject is empty");
  if (!Number.isFinite(session.expiresAt)) throw new Error("session expiry is not finite");
  const payload: SessionPayload = {
    v: 1,
    sub: session.subject,
    exp: Math.floor(session.expiresAt / 1000),
  };
  const payloadPart = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart));
  return payloadPart + "." + encodeBase64Url(new Uint8Array(signature));
}

/**
 * Verify an `hns_session` cookie.
 *
 * @param header - The raw `Cookie` header, or null.
 * @param secret - The HMAC key from `HNS_SESSION_SECRET`; undefined or short means deny.
 * @param now - Epoch milliseconds used to check expiry; injected in tests.
 * @returns The session, or null for any missing, malformed, expired, or forged value.
 *
 * @remarks
 * Every failure returns null. The caller decides the response (the edge returns 401). No
 * branch distinguishes forged from expired in the response, so a caller cannot probe the
 * cookie format.
 */
export async function readSessionCookie(
  header: string | null,
  secret: string | undefined,
  now: number = Date.now(),
): Promise<Session | null> {
  if (secret === undefined || secret.length < MIN_SESSION_SECRET_LENGTH) return null;
  const value = cookieValue(header, "hns_session");
  if (value === null) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (payloadPart === undefined || signaturePart === undefined) return null;
  const payloadBytes = decodeBase64Url(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (payloadBytes === null || signature === null) return null;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payloadPart));
  if (!valid) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(payloadBytes));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = v.safeParse(SessionPayloadSchema, raw);
  if (!parsed.success) return null;
  if (parsed.output.exp * 1000 <= now) return null;
  return { subject: parsed.output.sub, expiresAt: parsed.output.exp * 1000 };
}
