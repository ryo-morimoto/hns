import * as v from "valibot";
import { UnsupportedFormatError, digestCall, manifestHash, signingInput } from "./canonical.ts";
import { deny } from "./denial.ts";
import { isUnder } from "./paths.ts";
import {
  Base64UrlSchema,
  SignedGrantSchema,
  ToolCallSchema,
  ToolManifestSchema,
} from "./schemas.ts";
import type { DenialCode, PolicyDecision, SignedGrant, ToolCall, ToolManifest } from "./types.ts";

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type --
   The operation fields of call.args are this verifier's own boundary: they arrive from a model and are
   checked here, not parsed into a tool type first. */

/**
 * Verifying a signed grant against the call it is offered for.
 *
 * @remarks
 * `authorizeCall` is a **pure function**: it has no key store, no counter, and no clock of its own
 * (the caller passes `now`), so the same inputs always decide the same way. It verifies with
 * WebCrypto only (`globalThis.crypto.subtle`), so it runs in a Worker and in Node without a single
 * `node:crypto` import.
 *
 * The order of checks is the contract; each step refuses without looking at the next, so a refusal
 * names the earliest reason it could be decided:
 *
 * 1. **form** — the grant, the call, and the manifest are parsed by the strict schemas, and `now` is
 *    a real time (`grant_invalid`; a call or manifest that is not of this contract is
 *    `manifest_mismatch`; a value with no canonical form is `unsupported`).
 * 2. **algorithm** — the key's own algorithm must be the grant's `alg`
 *    (`grant_algorithm_mismatch`).
 * 3. **signature** — `signature` must be the base64url signature over `JCS(payload)`
 *    (`grant_invalid`).
 * 4. **revocation** — a grant the caller lists in `revokedGrants` is `grant_revoked`. It is
 *    checked **before** expiry on purpose: a grant the issuer took back must not be reported as one
 *    that merely ran out, however long the machine waited to check it, or an audit would read a
 *    revocation as a stale grant. Only when the caller passes no set does this step not run.
 * 5. **expiry** — `issuedAt` must not be after `now`, and `expiresAt` must be after it
 *    (`grant_expired`).
 * 6. **epoch** — `payload.epoch` must be exactly `lastEpoch` when the caller knows it, and it and
 *    `payload.policyHash` must be the `activePolicy`'s revision and hash (`epoch_stale`).
 * 7. **manifest** — `manifestHash`, `toolId`, and `toolVersion` must agree with the call and its
 *    manifest (`manifest_mismatch`).
 * 8. **scope** — the call must fit the grant's scope (`path_outside_root`, `command_not_allowed`,
 *    `egress_denied`, `scope_exceeded`, `unsupported`); `exact` must name this call's `callHash`
 *    (`scope_exceeded`).
 *
 * Every refusal is a `deny` value (`PolicyDecision`), never an exception. `maxCalls`, `maxBytes`, and
 * nonce reuse are counters and history the machine keeps outside this function.
 */

/** The operation fields a scope check reads, by tool. */
const OPERATION_FIELDS: Readonly<Record<ToolCall["toolId"], readonly string[]>> = {
  read_file: ["path"],
  write_file: ["path"],
  bash: ["envelope"],
};

function keyMatchesAlgorithm(key: CryptoKey, alg: SignedGrant["payload"]["alg"]): boolean {
  const named = key.algorithm;
  if (alg === "Ed25519") return named.name === "Ed25519";
  return named.name === "ECDSA" && "namedCurve" in named && named.namedCurve === "P-256";
}

/** The parameters WebCrypto verifies each algorithm with. */
function verifyAlgorithm(algorithm: SignedGrant["payload"]["alg"]): EcdsaParams | { name: string } {
  return algorithm === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
}

/** Decode unpadded base64url, or throw for text outside it. */
function base64Url(text: string): Uint8Array<ArrayBuffer> {
  let padded = "";
  for (const character of text) {
    padded += character === "-" ? "+" : character === "_" ? "/" : character;
  }
  while (padded.length % 4 !== 0) padded += "=";
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function signatureVerifies(grant: SignedGrant, key: CryptoKey): Promise<boolean> {
  if (!v.safeParse(Base64UrlSchema, grant.signature).success) return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64Url(grant.signature);
  } catch {
    return false;
  }
  try {
    return await globalThis.crypto.subtle.verify(
      verifyAlgorithm(grant.payload.alg),
      key,
      bytes,
      signingInput(grant),
    );
  } catch {
    // A key or signature the runtime cannot use is a refusal, not a defect the caller can act on.
    return false;
  }
}

/** What `authorizeCall` needs. */
export interface AuthorizeCallInput {
  readonly grant: SignedGrant;
  readonly call: ToolCall;
  readonly manifest: ToolManifest;
  /** The machine's trusted public key, chosen by `keyId` or pinned. Its algorithm must be the
   * grant's `alg`. */
  readonly key: CryptoKey;
  /** The machine's clock. A grant is valid while `issuedAt <= now < expiresAt`. */
  readonly now: Date;
  /** `callHash` of `call`, recomputed by the caller from the operation it will run. */
  readonly callHash: string;
  /** The newest epoch this machine has accepted; a grant older (or newer) than it is
   * `epoch_stale`, because the epoch it names is not the one the caller has been told is active. */
  readonly lastEpoch?: number | undefined;
  /**
   * The grant ids the caller has learned are revoked, or `undefined` when it knows nothing.
   *
   * @remarks
   * A revocation is the issuer taking a grant back **while it is still live** (the run the grant was
   * bound to ended, for instance), so it is `grant_revoked`, not `grant_expired`: the two are
   * different facts and an audit must be able to tell them apart (`DENIAL_CODES`). The list is
   * the caller's state, like `lastEpoch`: this function has no store of its own. `undefined` means
   * the caller has no revocation information, and then the check does not run — a machine that has
   * not been told about revocations must not pretend it has.
   */
  readonly revokedGrants?: ReadonlySet<string> | undefined;
  /** The active policy revision and hash the machine has. The grant's `epoch` and `policyHash` must
   * be this revision and hash, and they are copied into an `allow` so the audit row names the
   * revision the grant was issued under; an allow without them is impossible. */
  readonly activePolicy?: { readonly revision: number; readonly hash: string } | undefined;
}

function denyOf(code: DenialCode, message: string, input: AuthorizeCallInput): PolicyDecision {
  return deny(code, message, input.activePolicy);
}

function rootsContain(
  roots: readonly string[],
  path: string,
  input: AuthorizeCallInput,
): PolicyDecision | null {
  for (const root of roots) {
    const match = isUnder(path, root);
    // An unknown form is fail closed: it is never read as "outside" or as "inside".
    if (match.kind === "unsupported") {
      return denyOf("unsupported", "the path cannot be compared", input);
    }
    if (match.under) return null;
  }
  return denyOf("path_outside_root", "the path is outside every root of the grant", input);
}

function scopeDecision(
  grant: SignedGrant,
  call: ToolCall,
  input: AuthorizeCallInput,
): PolicyDecision | null {
  const scope = grant.payload.scope;
  const args = call.args;
  if (scope.kind === "exec" && typeof args["command"] !== "string") {
    return denyOf("command_not_allowed", "the call names no command", input);
  }
  switch (scope.kind) {
    case "read":
    case "write": {
      const path = args["path"];
      if (typeof path !== "string")
        return denyOf("scope_exceeded", "the call names no path", input);
      return rootsContain(scope.roots, path, input);
    }
    case "exec": {
      const envelope: unknown = args["envelope"];
      if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
        return denyOf("command_not_allowed", "the call names no exec envelope", input);
      }
      const record: Readonly<Record<string, unknown>> = Object.fromEntries(
        Object.entries(envelope),
      );
      const declared = Object.keys(record).sort();
      const field = declared.length === 1 ? declared[0] : undefined;
      if (field === "network") {
        const network = record["network"];
        if (network === "none") return null;
        if (network === "proxy" && scope.network === "proxy") return null;
        if (network === "proxy") {
          return denyOf("egress_denied", "proxy egress is not granted", input);
        }
        return denyOf("unsupported", "an unknown network envelope", input);
      }
      if (field === "writable") {
        const writable = record["writable"];
        if (typeof writable !== "boolean") {
          return denyOf("unsupported", "an unknown writable envelope", input);
        }
        if (writable && !scope.writable) {
          return denyOf("command_not_allowed", "a writable exec is not granted", input);
        }
        return null;
      }
      return denyOf("unsupported", "an exec envelope this contract does not know", input);
    }
    case "exact":
      return scope.callHash === input.callHash
        ? null
        : denyOf("scope_exceeded", "the exact grant names another call", input);
  }
}

/**
 * Decide whether one call may run under one grant.
 *
 * @param input - The grant, the call, its manifest, the machine's key and clock, and the call hash.
 * @returns `allow` with the grant id and the active policy revision, or a `deny` whose `code` is the
 * first check that failed. It throws nothing: an unusable key, a forged signature, or a value with
 * no canonical form are all denials. Without `activePolicy` there is nothing to record an allow
 * against, so the answer is `policy_denied` (fail closed); a grant that names another revision or
 * another document is `epoch_stale`.
 */
export async function authorizeCall(input: AuthorizeCallInput): Promise<PolicyDecision> {
  const parsedGrant = v.safeParse(SignedGrantSchema, input.grant);
  if (!parsedGrant.success || Number.isNaN(input.now.getTime())) {
    return denyOf("grant_invalid", "the grant is not a signed grant", input);
  }
  const grant = parsedGrant.output;
  const parsedCall = v.safeParse(ToolCallSchema, input.call);
  if (!parsedCall.success) return denyOf("manifest_mismatch", "the call is not a tool call", input);
  const call = parsedCall.output;
  const parsedManifest = v.safeParse(ToolManifestSchema, input.manifest);
  if (!parsedManifest.success) {
    return denyOf("manifest_mismatch", "the manifest is not a tool manifest", input);
  }
  const manifest = parsedManifest.output;
  let digest: { readonly argsHash: string; readonly callHash: string };
  let hashedManifest: string;
  try {
    digest = await digestCall(call);
    hashedManifest = await manifestHash(manifest);
  } catch (error) {
    if (!(error instanceof UnsupportedFormatError)) throw error;
    return denyOf("unsupported", error.message, input);
  }
  if (digest.callHash !== input.callHash) {
    return denyOf("scope_exceeded", "the call hash is not the call", input);
  }
  if (!OPERATION_FIELDS[call.toolId].every((field) => field in call.args)) {
    return denyOf("scope_exceeded", "the call lacks an operation field", input);
  }
  if (!keyMatchesAlgorithm(input.key, grant.payload.alg)) {
    return denyOf("grant_algorithm_mismatch", "the key and the grant algorithm differ", input);
  }
  if (!(await signatureVerifies(grant, input.key))) {
    return denyOf("grant_invalid", "the grant signature does not verify", input);
  }
  if (input.revokedGrants?.has(grant.payload.grantId) === true) {
    return denyOf("grant_revoked", "the grant was revoked by its issuer", input);
  }
  const now = input.now.getTime();
  if (Date.parse(grant.payload.issuedAt) > now || Date.parse(grant.payload.expiresAt) <= now) {
    return denyOf("grant_expired", "the grant is not valid at this time", input);
  }
  if (input.lastEpoch !== undefined && grant.payload.epoch < input.lastEpoch) {
    return denyOf("epoch_stale", "a newer policy epoch was already accepted", input);
  }
  if (input.lastEpoch !== undefined && grant.payload.epoch > input.lastEpoch) {
    // The caller already knows the newest epoch and this grant names a newer one: it was issued
    // under a revision the caller has not been told about, so it cannot be the active one.
    return denyOf("epoch_stale", "the grant's epoch is not the newest revision", input);
  }
  if (
    grant.payload.manifestHash !== hashedManifest ||
    grant.payload.toolId !== call.toolId ||
    grant.payload.toolId !== manifest.toolId ||
    grant.payload.toolVersion !== call.toolVersion ||
    grant.payload.toolVersion !== manifest.version
  ) {
    return denyOf("manifest_mismatch", "the grant was made for another tool or manifest", input);
  }
  const refusal = scopeDecision(grant, call, input);
  if (refusal !== null) return refusal;
  if (input.activePolicy === undefined) {
    return denyOf("policy_denied", "the active policy revision is unknown", input);
  }
  // The grant is bound to the revision **document**, not just its number: 0225's machine, which is
  // told the active revision on every request, refuses a grant whose `policyHash` is another
  // document's, so a reused or rolled-back epoch cannot keep an old scope alive.
  if (
    grant.payload.epoch !== input.activePolicy.revision ||
    grant.payload.policyHash !== input.activePolicy.hash
  ) {
    return denyOf("epoch_stale", "the grant was issued under another policy revision", input);
  }
  return {
    outcome: "allow",
    policyRevision: input.activePolicy.revision,
    policyHash: input.activePolicy.hash,
    grantId: grant.payload.grantId,
  };
}
