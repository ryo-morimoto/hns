import { isoTimestamp, type IsoTimestamp } from "@hns/core";
import {
  HashSchema,
  PolicyDocumentSchema,
  ToolManifestSchema,
  deny,
  manifestHash,
  policyHash,
} from "@hns/core/capability";
import type {
  CapabilityScope,
  DenialCode,
  DenyDecision,
  GrantAlgorithm,
  GrantPayload,
  PolicyDocument,
  SignedGrant,
  ToolId,
  ToolManifest,
  ToolPolicy,
} from "@hns/core/capability";
import { WORKSPACE_TOOLS, manifestFor } from "@hns/agent";
import * as v from "valibot";
import type { GrantSigner } from "../capability/signing.ts";
import {
  GrantLedgerUnavailableError,
  type GrantRecord,
  type GrantRequester,
} from "./grant-ledger.ts";

/**
 * Issuing capability grants in the Session object (0224, `docs/capability.md` §5, §10, D091).
 *
 * @remarks
 * The Session object runs tools, so it is where a grant is issued: the Worker hands it the
 * workspace's active policy revision as a **snapshot** with the request, and the object never reads
 * D1 (D049). Two pieces live here.
 *
 * - {@link issueGrant} is a **pure function** (`now`, the signer, and the ledger are arguments): a
 *   request and a snapshot become a signed `SignedGrant` or a `PolicyDecision` that denies. What it
 *   derives from the policy is derived in one place: the scope is the tool's `ToolPolicy.scope`
 *   unchanged, `expiresAt` is `issuedAt + grantTtlSeconds`, `maxCalls` is `maxCallsPerGrant`, and
 *   `epoch` is the snapshot's revision.
 *
 * - {@link createGrantPlane} is the object's **state**: the current snapshot, the ledger, and the
 *   run bindings. It records every grant it issues before it answers (a grant with no record is
 *   withheld), and it revokes a run's grants when that run ends, so a grant an agent holds for one
 *   run does not outlive it.
 *
 * **A grant cannot be widened.** It cannot name a scope the policy does not carry, a tool the
 * policy turned off, a manifest or machine the request did not name, or an `exact` call (Phase 1
 * has no approval flow for one): each of those is a denial, and a denied request is recorded as a
 * refusal. **A grant is not a secret channel.** The signed grant is the only value an answer carries
 * that a caller must keep; the ledger, the audit row, and every event name the `grantId` only.
 *
 * **Who may ask, and what ends a grant.** A signed-in person's session asks for a grant for one
 * machine's tool (`{kind: "human"}`); an agent's run asks through the same route with
 * `{kind: "agent", runId}`, and such a grant is **revoked when that run ends** (its conversation is
 * aborted, or the Session closes). A person's grant ends with its TTL. A revoked grant is refused by
 * `authorizeCall` as `grant_revoked`, never as an expired one.
 */

/**
 * The algorithm Phase 1 issues.
 *
 * @remarks
 * `Ed25519`, the control-plane key's own algorithm (D091). An `ECDSA-P256` request is refused
 * (`grant_algorithm_mismatch`) rather than signed with a second key: Phase 2 adds the key
 * distribution that algorithm needs.
 */
const PHASE_ONE_ALGORITHM: GrantAlgorithm = "Ed25519";

/** The shortest a grant lives, in seconds; the policy's schema already bounds this (0220). */
export const MIN_GRANT_TTL_SECONDS = 30;

/** The longest a grant lives, in seconds. */
export const MAX_GRANT_TTL_SECONDS = 60;

/**
 * The active policy revision a grant is issued under, as the Worker sends it.
 *
 * @remarks
 * `hash` is `policyHash(document)`: the issuer recomputes it, so the `epoch` a grant carries is the
 * revision **of the document actually used** rather than a number beside a document that may have
 * been swapped. The snapshot is parsed strictly: an unknown key, a missing one, or a document the
 * contract would not accept is refused, never defaulted.
 */
export interface PolicySnapshot {
  readonly revision: number;
  readonly hash: string;
  readonly document: PolicyDocument;
}

/** The schema of a snapshot, for the RPC boundary and the issuer. */
export const PolicySnapshotSchema: v.GenericSchema<unknown, PolicySnapshot> = v.strictObject({
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  hash: HashSchema,
  document: PolicyDocumentSchema,
});

/**
 * What one grant is asked for.
 *
 * @remarks
 * The request names **everything the grant will say** that the policy and the manifest do not: the
 * machine the grant is used on, the tool, its version, the manifest hash of the contract the model
 * is running, and the output bound the caller wants. The issuer checks each against the policy or
 * the manifest, so a request cannot widen a grant; a request that names another tool's manifest is
 * refused rather than corrected.
 */
export interface GrantRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  /** `manifestHash` of the tool the agent will run. */
  readonly manifestHash: string;
  /**
   * The most output the caller wants a grant to cover, or absent for the manifest's own bound.
   *
   * @remarks
   * This is the unit the issue left open; the contract decides it as **the model-facing JSON**, and
   * the grant takes the smaller of this and the manifest's `outputLimits.maxBytes`: a request
   * cannot raise the bound above what the tool's contract promises. **Absent means the manifest's
   * own limit** (a caller that does not care about the byte bound does not have to know it);
   * `0` is refused, because a grant that may return no byte is not a capability.
   */
  readonly maxBytes?: number | undefined;
}

const NonEmpty = v.pipe(v.string(), v.minLength(1));

/** The schema of a grant request. */
export const GrantRequestSchema: v.GenericSchema<unknown, GrantRequest> = v.strictObject({
  workspaceId: NonEmpty,
  sessionId: NonEmpty,
  machineId: NonEmpty,
  toolId: v.picklist(["read_file", "write_file", "bash"]),
  // Empty means "ask me": the Worker carries no tool table, so the object answers the version its
  // contracts declare (`tool_version`) instead of the request being refused as malformed.
  toolVersion: v.string(),
  manifestHash: HashSchema,
  maxBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

/**
 * What the issuer is given.
 *
 * @remarks
 * `request` and `snapshot` are `unknown` because the issuer **is** the boundary and parses them
 * (C7: a malformed body is refused before any grant exists). `signer.alg` must be the algorithm the
 * caller wanted; it is taken from the signer, so a request cannot choose it.
 */
export interface GrantInput {
  readonly request: unknown;
  readonly snapshot: unknown;
  /** The clock; `issuedAt` / `expiresAt` come from it, never from the request. */
  readonly now: () => number;
  readonly signer: GrantSigner;
  /** The algorithm the caller wanted signed; a signer of another algorithm is refused. */
  readonly algorithm?: GrantAlgorithm | undefined;
}

/** What issuing one grant produced. */
export type GrantIssue =
  | { readonly ok: true; readonly grant: SignedGrant }
  | {
      readonly ok: false;
      readonly decision: DenyDecision;
      /** The request as parsed, when it parsed: a refusal names what it refused when it can. */
      readonly request: GrantRequest | undefined;
      /**
       * The tool version the deployment's contracts declare, when the request named none (or an
       * unknown one).
       *
       * @remarks
       * A caller that does not carry the tool table — the Worker — learns the version here and sends
       * the request again with it (`tool_version` on the route). The version is the tool contract's
       * fact, not a guess.
       */
      readonly toolVersion?: string | undefined;
    };

/** The policy fields of the snapshot a denial names. */
interface PolicyRef {
  readonly revision: number;
  readonly hash: string;
}

/** The refusal that names the version the deployment's contracts declare. */
function toolVersionHint(
  request: GrantRequest,
  toolVersion: string,
  policy: PolicyRef,
): GrantIssue {
  return {
    ok: false,
    decision: deny(
      "grant_invalid",
      "the request names no version of this tool; send it again with toolVersion " + toolVersion,
      policy,
    ),
    request,
    toolVersion,
  };
}

/** A refusal with the request when it parsed. */
function refused(
  code: DenialCode,
  message: string,
  request: GrantRequest | undefined,
  policy?: PolicyRef | undefined,
): GrantIssue {
  return { ok: false, decision: deny(code, message, policy), request };
}

/** The tool policy one tool has in a snapshot, or undefined when the revision does not govern it. */
function toolPolicyOf(document: PolicyDocument, toolId: ToolId): ToolPolicy | undefined {
  switch (toolId) {
    case "read_file":
      return document.tools.read_file;
    case "write_file":
      return document.tools.write_file;
    case "bash":
      return document.tools.bash;
    default: {
      const unhandled: never = toolId;
      throw new Error("a tool the policy does not know: " + String(unhandled));
    }
  }
}

/** A parsed snapshot or the refusal. */
type SnapshotParse =
  | { readonly ok: true; readonly snapshot: PolicySnapshot }
  | { readonly ok: false; readonly issue: GrantIssue };

/**
 * Parse the snapshot and refuse one whose document is not the revision it names.
 *
 * @param snapshot - The untrusted snapshot.
 * @returns The snapshot, or the refusal (`grant_invalid`).
 *
 * @remarks
 * `policyHash(document)` is recomputed and compared with the snapshot's `hash`, so a document
 * swapped beside its revision number cannot be issued under: the grant's `epoch` is bound to the
 * bytes the hash names.
 */
/* oxlint-disable anti-slop/no-unknown-parameters --
   The snapshot arrives over the internal RPC; `PolicySnapshotSchema` in this function is the
   boundary it is parsed at, and a refusal is a value rather than a throw. */
async function snapshotOf(snapshot: unknown): Promise<SnapshotParse> {
  const parsed = v.safeParse(PolicySnapshotSchema, snapshot);
  if (!parsed.success) {
    return {
      ok: false,
      issue: refused("grant_invalid", "the policy snapshot is not one", undefined),
    };
  }
  if ((await policyHash(parsed.output.document)) !== parsed.output.hash) {
    return {
      ok: false,
      issue: refused(
        "grant_invalid",
        "the policy snapshot is not the revision it names",
        undefined,
      ),
    };
  }
  return { ok: true, snapshot: parsed.output };
}
/* oxlint-enable anti-slop/no-unknown-parameters */

/**
 * Match a request's manifest hash against a manifest of the right tool and version.
 *
 * @param request - The request.
 * @param document - The snapshot's document.
 * @returns The tool policy and the manifest, or undefined when they do not fit.
 *
 * @remarks
 * The issuer holds the hash, not the manifest, so the manifest a request means is **passed in** as
 * `candidates` by the caller that has it (the Worker's face reads it from the agent's tool table),
 * and this picks the one whose hash is the request's. What the issuer insists on, whichever is
 * picked, is that the manifest's tool and version are the request's: a hash of another tool's
 * contract (or another version of the same tool) is `manifest_mismatch`, and so is a hash no
 * candidate has.
 */
function pickManifest(
  request: GrantRequest,
  candidates: readonly ToolManifest[],
): ToolManifest | undefined {
  return candidates.find(
    (candidate) => candidate.toolId === request.toolId && candidate.version === request.toolVersion,
  );
}

/**
 * Issue one grant from a request and the active policy snapshot.
 *
 * @param input - The request, the snapshot, the clock, and the signer.
 * @param candidates - The manifests the caller knows; the one whose hash is the request's is used.
 * @returns The signed grant, or the denial that refused it. A signer that fails is a refusal
 * (`grant_invalid`), never a throw.
 *
 * @remarks
 * The checks, in order, each refusing without looking at the next:
 *
 * 1. **form** — the snapshot parses and its hash recomputes, the request parses, and a manifest of
 *    the request's tool and version hashes to the request's hash (`grant_invalid`,
 *    `manifest_mismatch`; the snapshot's own failure is `grant_invalid`).
 * 2. **policy** — the tool is in the revision and enabled (`tool_disabled`); an `exact` scope is
 *    refused (`unsupported`: Phase 1 issues no exact grant); the scope must be the shape the tool
 *    runs in (a `bash` grant with a read scope would sign a lie, so it is `unsupported`).
 * 3. **bounds** — the TTL is 30..60 seconds, `maxCalls` is positive, `maxBytes` is positive, and
 *    the expiry is after now (`grant_invalid`: a policy that would issue a dead grant is a policy
 *    defect, not a grant).
 * 4. **algorithm** — the signer signs the grant's `alg` (`grant_algorithm_mismatch`).
 * 5. **sign, then verify** — the signature is checked with the key that made it before the grant is
 *    returned; a signature that does not verify is `grant_invalid` and no grant exists.
 */
export async function issueGrant(
  input: GrantInput,
  candidates: readonly ToolManifest[],
): Promise<GrantIssue> {
  // The snapshot is parsed and hashed first, and the hash is awaited before anything else touches
  // the value: `snapshotOf` is async, and a caller must not be able to read the document before its
  // hash was checked against it.
  const parsedSnapshot = await snapshotOf(input.snapshot);
  if (!parsedSnapshot.ok) return parsedSnapshot.issue;
  const policy: PolicyRef = {
    revision: parsedSnapshot.snapshot.revision,
    hash: parsedSnapshot.snapshot.hash,
  };
  const parsedRequest = v.safeParse(GrantRequestSchema, input.request);
  if (!parsedRequest.success) {
    return refused("grant_invalid", "the grant request is not one", undefined, policy);
  }
  const request = parsedRequest.output;
  const toolPolicy = toolPolicyOf(parsedSnapshot.snapshot.document, request.toolId);
  if (toolPolicy === undefined || !toolPolicy.enabled) {
    return refused("tool_disabled", "the policy does not enable this tool", request, policy);
  }
  if (toolPolicy.scope.kind === "exact") {
    return refused(
      "unsupported",
      "an exact scope needs an approval this phase does not have",
      request,
      policy,
    );
  }
  // A request that names **no** version is answered with the version this deployment's contracts
  // declare, so its caller (the Worker, which carries no tool table) can send it again with one
  // instead of guessing. A request that names a version this deployment does not have is a plain
  // mismatch: there is nothing to send again.
  if (request.toolVersion === "") {
    const versionHint = candidates.find((candidate) => candidate.toolId === request.toolId);
    if (versionHint !== undefined) return toolVersionHint(request, versionHint.version, policy);
  }
  const manifest = pickManifest(request, candidates);
  if (manifest === undefined || (await manifestHashOf(manifest)) !== request.manifestHash) {
    return refused(
      "manifest_mismatch",
      "the manifest is not the one the request names",
      request,
      policy,
    );
  }
  if (!scopeFitsTool(toolPolicy.scope, request.toolId)) {
    return refused(
      "unsupported",
      "the policy's scope is not one this tool runs in",
      request,
      policy,
    );
  }
  const issuedAtMs = input.now();
  const ttl = toolPolicy.grantTtlSeconds;
  const maxCalls = toolPolicy.maxCallsPerGrant;
  // Absent means the manifest's own bound; a request can only lower it, never raise it (NB2).
  const maxBytes =
    request.maxBytes === undefined
      ? manifest.outputLimits.maxBytes
      : Math.min(request.maxBytes, manifest.outputLimits.maxBytes);
  if (!Number.isSafeInteger(issuedAtMs)) {
    return refused("grant_invalid", "the clock is not a time", request, policy);
  }
  if (!Number.isInteger(ttl) || ttl < MIN_GRANT_TTL_SECONDS || ttl > MAX_GRANT_TTL_SECONDS) {
    return refused(
      "grant_invalid",
      "the policy's grant lifetime is out of bounds",
      request,
      policy,
    );
  }
  if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
    return refused("grant_invalid", "the policy's call bound is not positive", request, policy);
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    return refused("grant_invalid", "the grant would allow no output", request, policy);
  }
  if (
    input.signer.alg !== PHASE_ONE_ALGORITHM ||
    (input.algorithm ?? PHASE_ONE_ALGORITHM) !== input.signer.alg
  ) {
    return refused(
      "grant_algorithm_mismatch",
      "the signer and the grant's algorithm differ",
      request,
      policy,
    );
  }
  const payload: GrantPayload = {
    v: 1,
    grantId: crypto.randomUUID(),
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    machineId: request.machineId,
    toolId: request.toolId,
    toolVersion: manifest.version,
    manifestHash: request.manifestHash,
    scope: toolPolicy.scope,
    issuedAt: isoTimestamp(new Date(issuedAtMs).toISOString()),
    expiresAt: isoTimestamp(new Date(issuedAtMs + ttl * 1000).toISOString()),
    epoch: parsedSnapshot.snapshot.revision,
    maxCalls,
    maxBytes,
    nonce: crypto.randomUUID(),
    alg: input.signer.alg,
    keyId: input.signer.keyId,
  };
  let signature: string;
  try {
    signature = await input.signer.sign(payload);
  } catch {
    return refused("grant_invalid", "the grant could not be signed", request, policy);
  }
  const grant: SignedGrant = { payload, signature };
  if (!(await input.signer.verify(payload, signature))) {
    return refused("grant_invalid", "the grant does not verify with its own key", request, policy);
  }
  return { ok: true, grant };
}

/** `manifestHash` of a manifest (the contract's `sha256Hex(JCS(manifest))`). */
async function manifestHashOf(manifest: ToolManifest): Promise<string> {
  // Parsed first, so an ill-typed candidate hashes to nothing the request could name.
  const parsed = v.safeParse(ToolManifestSchema, manifest);
  if (!parsed.success) return "";
  return await manifestHash(parsed.output);
}

/**
 * Whether a scope is one the tool runs in.
 *
 * @param scope - The policy's scope.
 * @param toolId - The tool the grant is for.
 * @returns `false` for a pairing the machine's `authorizeCall` would refuse for every call, so a
 * grant that could never allow anything is never issued.
 *
 * @remarks
 * `read_file` reads and `write_file` writes; `bash` runs in an exec envelope. A policy that pairs
 * a tool with another kind of scope (a file tool with an exec scope) is a policy the atom algebra
 * does not produce, and issuing its grant would hand the machine a scope it refuses forever: the
 * refusal is `unsupported`, which is the code for "this shape cannot be decided".
 */
function scopeFitsTool(scope: CapabilityScope, toolId: ToolId): boolean {
  if (toolId === "bash") return scope.kind === "exec";
  return toolId === "read_file" ? scope.kind === "read" : scope.kind === "write";
}

/**
 * What the plane records about one issuance: who asked, the decision, and the grant when there is one.
 *
 * @remarks
 * A refusal is recorded too: "who asked for a capability and did not get it" is what a detector reads
 * after an incident, and it costs one row. The audit's members come from the payload when a grant was
 * issued and from the parsed request when it was not; a request that never parsed contributes only
 * its refusal.
 */
export interface GrantAttempt {
  /** The workspace and session the issuance happened in (the Session object's own ids). */
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly requestedBy: GrantRequester;
  readonly at: IsoTimestamp;
  readonly issue: GrantIssue;
}

/**
 * Where the plane writes what it decided: the ledger and the issuance audit.
 *
 * @remarks
 * Two writes on purpose. The ledger is the grant's **lifecycle** (what stands, and what was revoked);
 * the audit is the append-only, hash-chained record of every **attempt** (issued or refused) an
 * auditor reads in order. Both are the Session object's own SQLite (`session_grants`, `grant_audit`),
 * never D1. `record` is atomic: a grant is in both tables or in neither.
 */
export interface GrantRecorder {
  /**
   * Record one issuance.
   *
   * @returns The stored grant, or `undefined` for a refusal.
   * @throws GrantLedgerUnavailableError when the record cannot be written: the grant is withheld.
   */
  record(attempt: GrantAttempt): Promise<GrantRecord | undefined>;
  /** Revoke one grant; idempotent, and `false` when it was already revoked or unknown. */
  revoke(grantId: string, at: IsoTimestamp): Promise<boolean>;
  /** The live grants bound to one run. */
  boundTo(runId: string): Promise<readonly GrantRecord[]>;
  /**
   * Record that a revocation could not be made.
   *
   * @param attempt - The revocation that failed: the grant, the run, and who asked.
   * @remarks
   * A revocation that throws is not silent: the grant lives until its own expiry (`expiresAt`, at
   * most 60 seconds) and the machine accepts it until then, so the record is what lets an operator
   * see that window. The write itself must not throw a second time into a path that is already
   * failing: a failure to record is logged by the caller.
   */
  recordRevokeFailure(attempt: GrantAttempt): Promise<void>;
}

/** What the plane is built with. */
export interface GrantPlaneOptions {
  /** The control-plane signer; absent means the Session has no usable key and issues nothing. */
  readonly signer: GrantSigner | undefined;
  readonly recorder: GrantRecorder;
  /** The workspace and session the object's grants belong to. */
  readonly workspaceId: string;
  readonly sessionId: string;
  /** The clock; `Date.now` in production. */
  readonly now: () => number;
  /** The event id for one issuance row; the object's own counter (`auditEventIds`). */
  readonly eventId: () => string;
}

/** One request the plane was given, and who asked. */
export interface PlaneRequest {
  readonly request: unknown;
  readonly snapshot: unknown;
  readonly requestedBy: GrantRequester;
  /**
   * The manifests a grant may name.
   *
   * @remarks
   * Absent means "this object's own tool contracts": the Session runs the workspace tools, so their
   * contracts are the ones a grant can be for, and the Worker need not carry them. A caller that
   * passes them (a test, a face that knows a different set) is held to what it passed.
   */
  readonly manifests?: readonly ToolManifest[] | undefined;
}

/**
 * The Session object's grant state.
 *
 * @remarks
 * The snapshot is not kept between requests: the Worker sends the active revision with each request,
 * so the object decides under the policy that is current **when it is asked**, which is the only
 * policy it can know without reading D1 (D049). A request that arrives with no snapshot is refused
 * rather than issued under a remembered one.
 */
export interface GrantPlane {
  /** Issue a grant (and record it), or the denial. */
  request(input: PlaneRequest): Promise<GrantIssue>;
  /** The grants bound to a run that are still live. */
  boundTo(runId: string): Promise<readonly GrantRecord[]>;
  /**
   * Revoke every live grant bound to one run.
   *
   * @param runId - The run (its conversation id) that ended.
   * @returns The ids this call revoked and the grants whose revocation could not be made.
   *
   * @remarks
   * The reason a run ended (an abort, or the Session closing) is not a member of the grant: the grant
   * says when it was revoked, and the run's own history says why it ended. A revoked grant is refused
   * by the machine as `grant_revoked`, never as `grant_expired`, which is the fact an auditor needs.
   *
   * A revocation that fails is **not swallowed**: the grant is named in `failed` and the attempt is
   * recorded in the issuance audit as `grant.revoke_failed`, because the grant then lives until its
   * own expiry (at most 60 seconds) and that window is a fact an operator has to see.
   */
  revokeRun(runId: string): Promise<GrantRevocation>;
}

/** What revoking one run's grants came to. */
export interface GrantRevocation {
  /** The grants this call revoked, in the order they were bound. */
  readonly revoked: readonly string[];
  /** The grants whose revocation threw; each is also recorded as `grant.revoke_failed`. */
  readonly failed: readonly string[];
}

/** The workspace tools' manifests, built once per object. */
let toolManifestsCache: Promise<readonly ToolManifest[]> | undefined;

/**
 * The manifests of the tools this object runs.
 *
 * @returns The three workspace tools' contracts, as `@hns/agent` builds them.
 *
 * @remarks
 * The object already loads the harness (it opens the agent's session), so the tool table costs it
 * nothing new; that is why the Worker can stay free of it. Built once per isolate.
 */
function toolManifests(): Promise<readonly ToolManifest[]> {
  toolManifestsCache ??= Promise.all(
    WORKSPACE_TOOLS.map(async (tool) => (await manifestFor(tool)).manifest),
  );
  return toolManifestsCache;
}

/**
 * Build the plane.
 *
 * @param options - The signer, the recorder, the object's ids, the clock, and the event ids.
 * @returns The plane.
 *
 * @throws Never at construction; every failure is a refusal or a ledger error.
 */
export function createGrantPlane(options: GrantPlaneOptions): GrantPlane {
  const { recorder, signer, now } = options;
  return {
    async request(input) {
      const issue =
        signer === undefined
          ? refused("grant_invalid", "the Session has no grant signer", undefined)
          : await issueGrant({ ...input, now, signer }, input.manifests ?? (await toolManifests()));
      try {
        await recorder.record({
          workspaceId: options.workspaceId,
          sessionId: options.sessionId,
          requestedBy: input.requestedBy,
          at: isoTimestamp(new Date(now()).toISOString()),
          issue,
        });
      } catch (error) {
        if (error instanceof GrantLedgerUnavailableError) {
          return refused(
            "grant_invalid",
            "the grant could not be recorded, so it is not issued",
            issue.ok ? undefined : issue.request,
          );
        }
        throw error;
      }
      return issue;
    },
    async boundTo(runId) {
      return await recorder.boundTo(runId);
    },
    async revokeRun(runId) {
      const at = isoTimestamp(new Date(now()).toISOString());
      const bound = await recorder.boundTo(runId);
      const revoked: string[] = [];
      const failed: string[] = [];
      for (const record of bound) {
        try {
          if (await recorder.revoke(record.grantId, at)) revoked.push(record.grantId);
        } catch (error) {
          failed.push(record.grantId);
          // The row is the observation. If even that cannot be written, the caller logs it: this
          // plane has no logger of its own and the Session's is the one a deployment reads.
          await recorder.recordRevokeFailure({
            workspaceId: options.workspaceId,
            sessionId: options.sessionId,
            requestedBy: record.requestedBy,
            at,
            issue: {
              ok: false,
              decision: deny(
                "grant_invalid",
                "the revocation failed: " + (error instanceof Error ? error.name : "unknown"),
              ),
              request: {
                workspaceId: record.workspaceId,
                sessionId: record.sessionId,
                machineId: record.machineId,
                toolId: record.toolId,
                toolVersion: record.toolVersion,
                manifestHash: record.manifestHash,
                maxBytes: record.maxBytes,
              },
            },
          });
        }
      }
      return { revoked, failed };
    },
  };
}
