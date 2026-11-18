import { authorizeCall, digestCall, signingInput } from "@hns/core/capability";
import type { PolicyDecision, SignedGrant, ToolCall, ToolManifest } from "@hns/core/capability";
import { enrolledGrantKeys } from "../../src/capability/keys.ts";
import { verifyGrant } from "../../src/capability/verify.ts";
import type { GrantCounterBudget, GrantSpend } from "../../src/capability/counter.ts";
import { GrantCounter } from "../../src/capability/counter.ts";

/**
 * Test doubles for the machine verifier's mutation probes (0225).
 *
 * @remarks
 * A probe has to observe the product with one decision changed. Three of the verifier's checks live
 * in the contract's `authorizeCall` (0220), so a probe cannot reach into them; what it can do is
 * rebuild the product's own steps — this machine's id, the `keyId` lookup, the call's hash, then
 * `authorizeCall` — and replace exactly the check the probe is about. The product's `verifyGrant`
 * stays the control, and each probe fails if the suite's assertion does not tell the two apart.
 */

/** Which check a probe removes. */
export type VerifierMutation = "signature" | "expiry" | "scope" | "none";

/** What a probe's verifier needs, which is what the product's verifier needs. */
export interface ProbeInput {
  readonly grant: unknown;
  readonly call: ToolCall;
  readonly manifest: ToolManifest;
  /** The enrolled key's raw bytes; the probe imports them itself. */
  readonly keys: Uint8Array;
  readonly machineId: string;
  readonly now: Date;
  readonly activePolicy: { readonly revision: number; readonly hash: string };
}

/** Unpadded base64url of some bytes. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** The enrolled key, as the contract's `GrantKeys` lookup. */
function keysFor(input: ProbeInput) {
  return enrolledGrantKeys({ publicKeys: async () => [input.keys] });
}

/** The product steps after the grant parsed: the key by `keyId`, and the call's hash. */
async function authorizedPart(input: ProbeInput, grant: SignedGrant) {
  const lookup = await keysFor(input).publicKey(grant.payload.keyId, grant.payload.alg);
  if (!lookup.ok) throw new Error("the probe's key must be found: " + lookup.message);
  return {
    call: input.call,
    manifest: input.manifest,
    key: lookup.key,
    now: input.now,
    callHash: (await digestCall(input.call)).callHash,
    activePolicy: input.activePolicy,
  };
}

/**
 * The product verifier with one check removed.
 *
 * @param options - Which check to drop.
 * @param input - The verification's inputs.
 * @returns The decision the mutated verifier makes.
 *
 * @remarks
 * `authorizeCall` verifies the signature over `JCS(payload)`, so a payload cannot be edited after
 * signing without also refusing the signature. Each probe therefore takes the mutation where the
 * product's order allows it:
 *
 * - **signature** — the grant is signed by a key the machine never enrolled (an attacker with the
 *   machine's ability to write a grant but not the control-plane seed). The product refuses it at
 *   the signature; the mutant verifies the same payload with *that* key, which is exactly what a
 *   verifier that trusted the grant's own key would do (§5: "鍵を grant 応答に同梱しない（TOFU に
 *   しない）").
 * - **expiry** — the decision's clock is moved into the grant's window, which is "the times are not
 *   compared"; the grant is the honest one, so the signature step is untouched.
 * - **scope** — the honest grant is signed, then its scope is widened and the grant is signed *by the
 *   probe*, i.e. the signature is not the check under test here: the mutant is the verifier that
 *   takes the payload's scope as given. The control (the product, with the same payload) refuses it,
 *   which is what the suite's assertion measures.
 *
 * The two are different failures a verifier can have: trusting a key it should not, versus not
 * comparing a field it should.
 */
export async function verifyWith(
  options: { readonly mutation: VerifierMutation; readonly key?: CryptoKey | undefined },
  input: ProbeInput,
): Promise<PolicyDecision> {
  if (options.mutation === "none") {
    return (await verifyGrant({ ...input, keys: keysFor(input) })).decision;
  }
  // SAFETY: the caller hands `verifyWith` the same value the product's `verifyGrant` parses; a value
  // that is not a signed grant fails the checks below (`machineId` is read from a grant the parse
  // accepted), and the probe's own `verifyGrant` control is what the test compares against.
  const grant = input.grant as SignedGrant;
  if (grant.payload.machineId !== input.machineId) {
    return { outcome: "deny", code: "grant_invalid", message: "the grant is for another machine" };
  }
  const authorized = await authorizedPart(input, grant);
  switch (options.mutation) {
    case "signature": {
      // The product refuses a grant from a key it never enrolled. The mutant verifies with the key
      // that accompanied the grant — trust on first use — and so accepts it.
      if (options.key === undefined) throw new Error("the signature probe needs a key");
      return await authorizeCall({ ...authorized, grant, key: options.key });
    }
    case "expiry":
      return await authorizeCall({
        ...authorized,
        grant,
        now: new Date(Date.parse(grant.payload.issuedAt) + 1),
      });
    case "scope": {
      const signed = await reSign(adapt(grant, authorized.callHash));
      return await authorizeCall({ ...authorized, grant: signed });
    }
  }
}

/**
 * A key to verify a probe's grant with, for the algorithms this probe builds.
 *
 * @internal
 */
let probeSigningKey: CryptoKey | undefined;

/**
 * Sign a payload the probe built, with the fixture's control-plane key.
 *
 * @remarks
 * The scope probe widens a scope and must present a *signed* grant, or `authorizeCall` would refuse
 * it at the signature for a reason other than the scope. The key is the fixture's, so the mutant's
 * grant verifies exactly as the honest one does; only the scope differs.
 */
async function reSign(payload: SignedGrant["payload"]): Promise<SignedGrant> {
  if (probeSigningKey === undefined) throw new Error("the probe's key is not set");
  const signature = await globalThis.crypto.subtle.sign(
    { name: "Ed25519" },
    probeSigningKey,
    signingInput({ payload, signature: "" }),
  );
  return { payload, signature: bytesToBase64Url(new Uint8Array(signature)) };
}

/** Set the key the scope probe signs with (the fixture's control-plane key). */
export function setProbeSigningKey(key: CryptoKey): void {
  probeSigningKey = key;
}

/** The payload a probe hands to `authorizeCall`: the grant's, with the scope widened. */
function adapt(grant: SignedGrant, callHash: string): SignedGrant["payload"] {
  const payload = grant.payload;
  switch (payload.scope.kind) {
    case "read":
    case "write":
      return { ...payload, scope: { kind: payload.scope.kind, roots: ["."] } };
    case "exact":
      return { ...payload, scope: { kind: "exact", callHash } };
    case "exec":
      return { ...payload, scope: { kind: "exec", network: "proxy", writable: true } };
    default: {
      const unhandled: never = payload.scope;
      throw new Error("a scope the contract does not know: " + String(unhandled));
    }
  }
}

/**
 * The product counter with its bound removed.
 *
 * @param directory - The state directory (the product's own layout).
 * @returns A `GrantCounter` that spends without checking `maxCalls` / `maxBytes`.
 */
export function unboundedCounter(directory: string): GrantCounter {
  const always: GrantCounterBudget = (_spend: GrantSpend | undefined, _input) => true;
  return new GrantCounter(directory, { withinBudget: always });
}
