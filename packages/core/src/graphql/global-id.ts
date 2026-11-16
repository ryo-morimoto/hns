/** A decoded global id: the GraphQL type name and the model id it names. */
export interface GlobalId {
  readonly type: string;
  readonly id: string;
}

/** The closed result of {@link fromGlobalId}; a failure is a value, not an exception. */
export type GlobalIdResult =
  | { readonly ok: true; readonly value: GlobalId }
  | { readonly ok: false; readonly reason: "malformed" };

/** The GraphQL name grammar: `[_A-Za-z][_0-9A-Za-z]*`. */
const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/u;

/**
 * Encode a type and an id as one base64url string.
 *
 * @param type - The GraphQL type name, e.g. `Project`.
 * @param id - The model id, e.g. a UUID or `default`.
 * @returns `base64url("<type>:<id>")`, unpadded.
 * @throws Error when `type` is not a GraphQL name or `id` is empty; both are programming errors.
 *
 * @remarks
 * The type prefix is what keeps Relay's normalised store from merging two entities that happen to
 * share a raw id. The encoding is ASCII-safe for the ids the model uses.
 */
export function toGlobalId(type: string, id: string): string {
  if (!NAME.test(type)) throw new Error("global id type is not a GraphQL name: " + type);
  if (id.length === 0) throw new Error("global id is empty");
  return encodeBase64Url(type + ":" + id);
}

/**
 * Decode a global id.
 *
 * @param globalId - A value received at the GraphQL boundary.
 * @returns `{ ok: true, value }`, or `{ ok: false, reason: "malformed" }` for anything that is
 * not base64url of `<GraphQL name>:<non-empty id>`.
 *
 * @remarks
 * Never throws: a client-supplied id is untrusted input, and the caller answers it with a typed
 * failure rather than a 500.
 */
export function fromGlobalId(globalId: string): GlobalIdResult {
  const decoded = decodeBase64Url(globalId);
  if (decoded === undefined) return { ok: false, reason: "malformed" };
  const separator = decoded.indexOf(":");
  if (separator <= 0) return { ok: false, reason: "malformed" };
  const type = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!NAME.test(type) || id.length === 0) return { ok: false, reason: "malformed" };
  return { ok: true, value: { type, id } };
}

/** Encode UTF-8 text as unpadded base64url. */
function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Decode unpadded base64url to UTF-8 text, or undefined when it is not valid. */
function decodeBase64Url(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}
