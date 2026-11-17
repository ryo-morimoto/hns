import type { CallDigest, PolicyDocument, SignedGrant, ToolCall, ToolManifest } from "./types.ts";

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters --
   This module is the canonical-JSON boundary itself: it takes an untrusted value and either writes its
   bytes or refuses it, so it must inspect a typeof here rather than branch on a parsed type. */

/**
 * Canonical JSON (RFC 8785, JCS) and the hashes the capability contract is made of.
 *
 * @remarks
 * A call is identified by bytes, not by an object: the agent judges one `callHash` and the machine
 * recomputes it from the operation it is about to run, so the two must be able to produce the same
 * text from equal values. Every hash here is `sha256` over **UTF-8 bytes of `canonicalize(...)`**
 * and is written as lowercase hex.
 *
 * The rules Phase 1 uses, and what it refuses:
 *
 * - Object keys are sorted by **UTF-16 code unit** (`Array.prototype.sort` on the keys is exactly
 *   that order; a locale-aware compare is not). No whitespace between tokens.
 * - Strings are JSON-escaped as JCS says: `"` and `\\` are escaped, U+0000–U+001F are escaped
 *   (backspace, tab, newline, form feed, and carriage return in their short form; everything else in
 *   that range as `\u00xx`), and every other code point is written as itself. A string with a
 *   **lone surrogate** (an unpaired UTF-16 code unit) has no UTF-8 form and is refused.
 * - Numbers are **safe integers only** (`Number.isSafeInteger`). This is narrower than JCS, which
 *   also allows fractions and `1e21` and up in exponential form: a value that is not a safe integer
 *   throws {@link UnsupportedFormatError}, and a caller turns that into `unsupported`
 *   (`docs/capability.md` §14, "浮動小数の全範囲（safe integer だけ）").
 * - `-0` is written as `0`, as JCS requires (`JSON.stringify(-0)` is `"0"`). A negative safe
 *   integer is written with its sign (`-1`). Because the accepted range stops at
 *   `Number.MAX_SAFE_INTEGER`, no accepted number is ever written in exponential form.
 * - `undefined` (as a value or an array element), `NaN`, `Infinity`, functions, symbols, bigints,
 *   `Date`, class instances, and cyclic values are refused: a value reaches the canonical form only
 *   after a schema accepted it, and these are never in one.
 */

/**
 * A value that has no canonical JSON form under this contract.
 *
 * @remarks
 * Thrown by {@link canonicalize} for a number outside the safe integers, a lone surrogate, an
 * `undefined` / `NaN` / `Infinity` / `-0`-adjacent value, a hole, a cycle, or a value that is not
 * plain data. It is not a denial itself: a caller that decides on the value maps it to `unsupported`
 * (fail closed) rather than to a match.
 */
export class UnsupportedFormatError extends Error {
  /**
   * @param reason - What could not be represented, for a log; it carries no value from the input.
   */
  constructor(reason: string) {
    super("canonical JSON cannot represent " + reason);
    this.name = "UnsupportedFormatError";
  }
}

/** The characters JCS escapes besides `"` and `\\`, in their short form. */
const SHORT_ESCAPES = new Map<string, string>([
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\f", "\\f"],
  ["\r", "\\r"],
]);

/**
 * An unpaired UTF-16 code unit: a high surrogate not followed by a low one, or a low surrogate not
 * preceded by a high one.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function canonicalString(value: string): string {
  // A lone surrogate cannot be encoded as UTF-8, so it has no canonical bytes.
  if (LONE_SURROGATE.test(value)) {
    throw new UnsupportedFormatError("a string with a lone surrogate");
  }
  let out = '"';
  for (const character of value) {
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else {
      const code = character.codePointAt(0);
      if (code === undefined) throw new UnsupportedFormatError("an empty string unit");
      if (code < 0x20) {
        out += SHORT_ESCAPES.get(character) ?? "\\u" + code.toString(16).padStart(4, "0");
      } else out += character;
    }
  }
  return out + '"';
}

function canonicalNumber(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new UnsupportedFormatError("a number that is not a safe integer");
  }
  // JCS writes -0 as 0, which is what JSON.stringify does for it.
  return Object.is(value, -0) ? "0" : String(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value: unknown, ancestors: readonly object[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return canonicalString(value);
    case "object":
      break;
    default:
      throw new UnsupportedFormatError("a " + typeof value);
  }
  if (ancestors.includes(value)) throw new UnsupportedFormatError("a cyclic value");
  const line = [...ancestors, value];
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) items.push(canonicalValue(item, line));
    return "[" + items.join(",") + "]";
  }
  if (!isPlainObject(value)) throw new UnsupportedFormatError("an instance that is not plain data");
  const keys = Object.keys(value).sort();
  const members: string[] = [];
  for (const key of keys)
    members.push(canonicalString(key) + ":" + canonicalValue(value[key], line));
  return "{" + members.join(",") + "}";
}

/**
 * Serialize a value as canonical JSON (RFC 8785).
 *
 * @param value - Plain data: `null`, booleans, safe integers, well-formed strings, arrays, and plain
 * objects of these.
 * @returns The canonical text: keys in UTF-16 code unit order, no whitespace, JCS escapes, `-0` as
 * `0`.
 * @throws UnsupportedFormatError when the value has no canonical form under Phase 1 (see the module
 * remarks).
 */
export function canonicalize(value: unknown): string {
  return canonicalValue(value, []);
}

const HEX = "0123456789abcdef";

/**
 * SHA-256 of the UTF-8 bytes of `text`, as lowercase hex.
 *
 * @remarks
 * Uses only `crypto.subtle`, so it runs wherever WebCrypto does (a Worker, Node 20+, a browser).
 * Every hash in this module is built from it.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += (HEX[byte >> 4] ?? "") + (HEX[byte & 0x0f] ?? "");
  }
  return hex;
}

/**
 * `sha256Hex(JCS(args))`: the arguments of one call.
 *
 * @param call - The call whose `args` are hashed.
 * @throws UnsupportedFormatError when `call.args` has no canonical form.
 */
export async function argsHash(call: ToolCall): Promise<string> {
  return sha256Hex(canonicalize(call.args));
}

/**
 * `sha256Hex(JCS({v: call.v, callId, toolId, toolVersion, argsHash}))`: the identity of one call.
 *
 * @remarks
 * The object is written with exactly these five keys, every one of them, and no others — `args`
 * itself is not hashed again, only its `argsHash`. JCS sorts the keys, so the order written here
 * does not matter; the member set does. A machine recomputes this from the operation it is about to
 * run and refuses when it differs from the one it was authorized with.
 *
 * @param call - The call.
 * @param hashedArgs - `argsHash(call)`.
 * @throws UnsupportedFormatError when the fields have no canonical form.
 */
export async function callHash(call: ToolCall, hashedArgs: string): Promise<string> {
  return sha256Hex(
    canonicalize({
      v: call.v,
      callId: call.callId,
      toolId: call.toolId,
      toolVersion: call.toolVersion,
      argsHash: hashedArgs,
    }),
  );
}

/** `argsHash` and `callHash` of one call, in that order (`callHash` is computed from `argsHash`). */
export async function digestCall(call: ToolCall): Promise<CallDigest> {
  const hashedArgs = await argsHash(call);
  return { argsHash: hashedArgs, callHash: await callHash(call, hashedArgs) };
}

/**
 * `sha256Hex(JCS(manifest))`: the contract a call was made against.
 *
 * @param manifest - The manifest. Its own fields are hashed as given; the manifest does not contain
 * its hash.
 * @throws UnsupportedFormatError when the manifest has no canonical form.
 */
export async function manifestHash(manifest: ToolManifest): Promise<string> {
  return sha256Hex(canonicalize(manifest));
}

/**
 * `sha256Hex(JCS(document))`: a policy revision's identity.
 *
 * @param document - The policy document.
 * @throws UnsupportedFormatError when the document has no canonical form.
 */
export async function policyHash(document: PolicyDocument): Promise<string> {
  return sha256Hex(canonicalize(document));
}

/**
 * The message a grant's signature covers: the UTF-8 bytes of `canonicalize(grant.payload)`.
 *
 * @param grant - The signed grant.
 * @returns The bytes a signature over JCS(payload) is made of.
 * @throws UnsupportedFormatError when the payload has no canonical form.
 */
export function signingInput(grant: SignedGrant): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalize(grant.payload));
}

/**
 * `sha256Hex(JCS({v: 1, proposalId, baseHash, candidateHash, credentialFingerprint}))`: what a human
 * approves.
 *
 * @remarks
 * The token binds the proposal to the revision it was built on, its exact candidate, and the
 * credential of the reader, so a decision made from a stale policy view or by another credential does
 * not match the one the proposer saw (`approval_stale`). Phase 1 passes `""` as the fingerprint.
 *
 * Collisions are not tolerated: a token is only ever compared against a freshly recomputed one for
 * the **same** proposal, so if a caller ever saw one token for two different inputs it must refuse
 * (`approval_stale`) rather than accept either — the token is never used to look a call up, and the
 * token's inputs are not widened to paper over a clash.
 *
 * @param input - The proposal id, the active revision's hash, the candidate's hash, and the reader's
 * fingerprint.
 * @throws UnsupportedFormatError when an input has no canonical form.
 */
export async function reviewToken(input: {
  readonly proposalId: string;
  readonly baseHash: string;
  readonly candidateHash: string;
  readonly credentialFingerprint: string;
}): Promise<string> {
  return sha256Hex(
    canonicalize({
      v: 1,
      proposalId: input.proposalId,
      baseHash: input.baseHash,
      candidateHash: input.candidateHash,
      credentialFingerprint: input.credentialFingerprint,
    }),
  );
}
