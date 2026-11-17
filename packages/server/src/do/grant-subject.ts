import { principalOf } from "../policy/principals.ts";
import type { GrantRequester } from "./grant-ledger.ts";

/**
 * The grant route's **subject binding** (0224, NB7).
 *
 * @remarks
 * `POST /rpc/grants` is an internal route: the Session namespace is reachable only through the
 * `SESSION` binding, and only the Worker's `requestGrant` calls it. That is a fact about the
 * deployment, not about the request, so the route refuses to rely on it alone: the Worker proves
 * its own identity with the session secret, and the requester the body names must **be** the verified
 * person (or a run of an agent acting for one), not anything the body says it is.
 *
 * Without this, a caller that reached the object by another way — a misrouted binding, a future face
 * that forwards without checking, a compromised internal client — could ask for a grant for any
 * person's workspace and `requestedBy`, and the ledger would record the wrong principal.
 */

/** The header the Worker proves itself with. */
export const GRANT_INTERNAL_HEADER = "x-hns-session-token";

/** The header carrying the verified session subject the Worker checked. */
export const GRANT_SUBJECT_HEADER = "x-hns-subject";

/**
 * Derive the token the Worker presents from the session secret.
 *
 * @param secret - `HNS_SESSION_SECRET` (the Worker's own HMAC key; never logged).
 * @returns The token, or undefined when the secret is missing or unusable (the route then refuses
 * every request, the same way a missing key refuses every machine request).
 *
 * @remarks
 * `sha256("hns.grant-rpc.v1:" + secret)`, in hex. A hash and not the secret: the object sees a value
 * that proves the Worker knows the secret without the object ever holding the secret, and a log
 * that leaked the header would leak no key. The prefix makes it a purpose-bound token, not a
 * general "knows the secret" credential.
 */
export async function grantInternalToken(secret: string | undefined): Promise<string | undefined> {
  if (secret === undefined || secret.length === 0) return undefined;
  const bytes = new TextEncoder().encode("hns.grant-rpc.v1:" + secret);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Whether two tokens are the same, without an early exit on the first differing byte. */
export function sameToken(given: string | undefined, expected: string | undefined): boolean {
  if (given === undefined || expected === undefined) return false;
  if (given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < given.length; index += 1) {
    difference |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** Whether a requester the body named is the verified subject the Worker proved. */
export type RequesterCheck = "ok" | "subject_mismatch" | "agent_for_human";

/**
 * Check the requester against the verified subject.
 *
 * @param requester - The principal the body named.
 * @param subject - The verified session subject the Worker sent in the header.
 * @returns `ok` when the requester is the subject, or an agent acting for it; the refusal otherwise.
 *
 * @remarks
 * A person's requester is the subject, exactly. An agent's requester is the subject's agent id (the
 * `agent:` namespace of the same subject, which is how the session names an agent), so an agent can
 * ask for itself and nobody else. A run is a property of the agent's requester, not an identity of
 * its own.
 */
export function checkRequester(requester: GrantRequester, subject: string): RequesterCheck {
  const verified = principalOf(subject);
  if (verified.kind !== requester.kind) {
    return requester.kind === "agent" ? "agent_for_human" : "subject_mismatch";
  }
  return requester.id === verified.id ? "ok" : "subject_mismatch";
}
