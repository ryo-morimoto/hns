import { createHash } from "node:crypto";
import {
  MACHINE_RPC_PATH,
  SIGNED_HEADER_BY_FIELD,
  isoTimestamp,
  signatureMessage,
} from "@hns/core";
import type { JsonValue, RequestSignature } from "@hns/core";
import {
  ToolCallSchema,
  ToolManifestSchema,
  deny,
  digestCall,
  manifestHash,
  policyHash,
} from "@hns/core/capability";
import type {
  AuditEvent,
  PolicyDecision,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "@hns/core/capability";
import { GrantedAnswerSchema, TOOL_RUN_TOKEN_TTL_MS } from "@hns/workspace/protocol";
import type { GrantedAnswer, GrantedCall } from "@hns/workspace/protocol";
import * as v from "valibot";
import { failureStatus, type FailureCodeOf } from "../failures/status.ts";
import type { PolicyAudit } from "./audit.ts";
import type { MachineFiles } from "./machine.ts";
import type { GrantRecord } from "./grant-ledger.ts";
import type { PolicySnapshot } from "./session-grants.ts";
import { PolicySnapshotSchema } from "./session-grants.ts";

/**
 * The Session object's granted tool path (0226, `docs/capability.md` §5, §8, §10).
 *
 * @remarks
 * A run of the agent does not reach a machine directly. Its tool code asks its Session object for a
 * grant and relays the call back through the object, on the run's own token; the object is what
 * **issues** the grant (through 0224's issuer and ledger, from the policy snapshot the Worker sent
 * with the turn), **relays** the call to the machine over the control-plane signature (0148), and
 * **records** the decision in `policy_audit` before the answer returns (0222). The agent holds no
 * key, no machine URL, and no policy; no signed grant ever crosses to it.
 *
 * **The snapshot must move forward.** The Worker sends the active policy revision with each turn;
 * the object keeps the newest revision it has admitted a run under and refuses a turn whose snapshot
 * names an older one. The **same** revision arriving again is fine (a retried send), and the hash is
 * recomputed and compared with the document before anything is kept. The document never leaves this
 * object: the agent's answers name the revision and the hash, not the rules.
 *
 * **A revoked grant does not reach a machine.** The object refuses a call whose grant its ledger
 * records as revoked (`grant_revoked`) before relaying it, so a run's grants stop working when the
 * run ends, not when they expire. The machine keeps no revocation list of its own: its second line
 * of defence is the grant's 60-second maximum life and its own counter.
 *
 * **The counter is the machine's.** `session_grants` holds issuance and revocation; the calls and
 * bytes a grant spent are counted on the machine (0225), and this object's record of them is the
 * audit's rows, one per call.
 */

/** A typed failure of the granted routes, in the Session RPC's vocabulary. */
export function failure(code: FailureCodeOf<"session-rpc">, message: string): Response {
  const body = { ok: false, code, message };
  return new Response(JSON.stringify(body), {
    status: failureStatus("session-rpc", code),
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A JSON answer.
 *
 * @param body - The answer.
 * @param status - The status; 200 unless a failure is written.
 */
export function json(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** What a run's token is checked against. */
interface RunToken {
  readonly value: string;
  readonly expiresAt: number;
}

/** What admitting one turn's snapshot came to. */
export type ToolSnapshotAdmission =
  | { readonly ok: true; readonly snapshot: PolicySnapshot }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "epoch_stale";
      readonly message: string;
    };

/** The object's issuer: 0224's plane, as this path asks it for one grant. */
export interface GrantIssuer {
  /**
   * Issue and record the grant for one call of one run.
   *
   * @param input - The policy snapshot the turn was admitted under, the request the issuer parses
   * (workspace, session, machine, tool, version, manifest hash, byte bound), who asks, and the
   * manifests the issuer checks the request's hash against.
   * @returns The grant, or the issuance refusal.
   */
  readonly issue: (input: {
    readonly snapshot: PolicySnapshot;
    readonly request: {
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly machineId: string;
      readonly toolId: ToolCall["toolId"];
      readonly toolVersion: string;
      readonly manifestHash: string;
      readonly maxBytes: number;
    };
    readonly runId: string;
    readonly agentId: string;
    readonly manifests: readonly ToolManifest[];
  }) => Promise<GrantIssuance>;
}

/** What one issuance came to. */
export type GrantIssuance =
  | { readonly ok: true; readonly grant: SignedGrant }
  | { readonly ok: false; readonly decision: PolicyDecision };

/**
 * The state the object keeps between turns: the newest snapshot, and the admitted runs' tokens.
 *
 * @remarks
 * Both are per object, not per conversation: the object is the workspace's Session, and the policy it
 * was told is the workspace's. A run's token lives until its run ends or {@link TOOL_RUN_TOKEN_TTL_MS}
 * passes, whichever is first.
 */
export interface ToolPathState {
  /** The newest snapshot the object admitted a turn under, for a reader of the current policy. */
  readonly snapshot: () => PolicySnapshot | undefined;
  /**
   * Record the snapshot a send was admitted under.
   *
   * @param raw - The Worker's snapshot, untrusted.
   * @returns `ok` with the parsed snapshot, or the failure to answer the send with.
   *
   * @remarks
   * The snapshot is parsed strictly and its hash recomputed; a lower revision than the newest one
   * already admitted is `epoch_stale`, and the same revision is idempotent.
   */
  readonly admitTurn: (snapshot: PolicySnapshotPayload) => Promise<ToolSnapshotAdmission>;
  /** Mint a run's relay token; the run's id is what it is checked against. */
  readonly mint: (runId: string) => string;
  /** Check one run's relay token; false refuses the relay. */
  readonly check: (runId: string, token: string | null) => boolean;
  /** Forget a run's token, as the run's end does. */
  readonly forget: (runId: string) => void;
}

/**
 * The Worker's policy snapshot, as the internal RPC delivers it: untrusted JSON until
 * `admitTurn` parses it, which is why its type says nothing more about it.
 *
 * @remarks
 * The object cannot parse it at a lower boundary: it is the Session RPC's body, and the shape is
 * `PolicySnapshotSchema` (the issuer's own, 0224). A value that is not one is the send's refusal.
 */
export type PolicySnapshotPayload = Readonly<Record<string, JsonValue>>;

/**
 * What the agent asks its object for on one call.
 *
 * @remarks
 * The agent names what it is about to run and the contract it runs; it cannot name a grant, a scope,
 * or a policy, so there is nothing in the request it could widen. The object asks the issuer for the
 * grant, keeps it for the run, and relays it.
 */
export interface GrantedCallRequest {
  readonly call: unknown;
  readonly manifest: unknown;
  /** The model-facing bytes this call may return, counted against the grant's `maxBytes`. */
  readonly bytes: number;
}

/** The body the agent's relay route carries, parsed at the boundary. */
export const GrantedCallRequestSchema: v.GenericSchema<unknown, GrantedCallRequest> =
  v.strictObject({
    call: v.unknown(),
    manifest: v.unknown(),
    bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  });

/** What one relay came to: the machine's answer, or the failure the route answers with. */
export type ToolRelayOutcome =
  | { readonly ok: true; readonly answer: GrantedAnswer }
  | {
      readonly ok: false;
      readonly code: FailureCodeOf<"session-rpc">;
      readonly message: string;
    };

/**
 * The agent's relay for one run: what the object hands its own tool code.
 *
 * @remarks
 * The transport carries the run's token and the run's id; every call it makes is the object's
 * `/rpc/conversations/<runId>/tool` route, which checks the token against that run. `closeRun`
 * forgets the token, so a call after the run ended cannot be relayed even before the grants are
 * revoked.
 */
export interface ToolRunTransport {
  /**
   * Relay one granted call; the answer is the machine's, as JSON.
   *
   * @param input - The call, its manifest, and the bytes, in the **route's** shape
   * ({@link GrantedCallRequest}); the route parses exactly this body.
   * @returns The machine's answer, which the route serializes: a decision and, for an allow, the
   * operation's result. It stays unparsed here because the object's own route parses it.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the wire answer, parsed by the route.
  call(input: GrantedCallRequest): Promise<GrantedAnswer | JsonValue>;
  /** End the run: no further call relays. */
  closeRun(): Promise<void>;
}

/** What the granted path is built with. */
export interface ToolPathOptions {
  /** The object's ids, for the audit's rows and the grants'. */
  readonly workspaceId: string;
  readonly sessionId: string;
  /** The object's issuer (0224); undefined means no grant is issued (fail closed). */
  readonly issuer: GrantIssuer | undefined;
  readonly audit: PolicyAudit;
  /** The machine the calls go to; undefined means nothing is relayed (fail closed). */
  readonly machine: MachineFiles | undefined;
  /** The control-plane seed (0148), for the relay's signed request. */
  readonly controlPlaneKey: string | undefined;
  /** This machine's id; a grant is issued for it and the relay names it. */
  readonly machineId: string | undefined;
  /** The machine agent's origin (`HNS_AGENT_URL`); the relay's requests go there. */
  readonly agentUrl: string | undefined;
  /** The manifests the issuer checks a request's hash against: the object's own tool contracts. */
  readonly manifests: () => Promise<readonly ToolManifest[]>;
  /**
   * The ledger questions about one grant: was it revoked, and how many calls is it covering?
   *
   * @remarks
   * The object's path issues a **run's** grant for a **call**, and it must not issue a replacement
   * after the row it was given was revoked: the revocation is the run's end, and an issuance after
   * it would hand the same run a working capability again. `revoked` answers from the ledger.
   */
  readonly revoked: (grantId: string) => Promise<boolean>;
  /** The grant a run's relay was last given, so a replacement is refused once it is revoked. */
  readonly grantOf: (runId: string) => Promise<GrantRecord | undefined>;
  readonly now: () => number;
  /** The event id for one audit row. */
  readonly eventId: () => string;
  /** The machine call; `fetch` in production, a fake in a test. */
  readonly fetch?:
    | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
    | undefined;
}

/** The granted path one object runs. */
export interface ToolPath {
  readonly state: ToolPathState;
  /**
   * Relay one granted call for one run: issue its grant, send it to the machine, and record the
   * decision.
   *
   * @param runId - The conversation whose run asks; the grant is bound to it.
   * @param request - The agent's request: the call and its manifest, never a grant.
   * @returns The machine's answer, or the failure of the relay.
   */
  readonly relay: (runId: string, request: GrantedCallRequest) => Promise<ToolRelayOutcome>;
}

/** The connection the object presents for its machine calls (0147's gate). */
const OBJECT_CONNECTION = "hns-session";

/** The connection sequence: one instance, so one seq. */
const OBJECT_SEQ = "1";

/** The prefix of an Ed25519 PKCS#8 encoding, up to the 32-byte seed. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Unpadded base64url of some bytes. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/**
 * The URL of the one route a machine answers.
 *
 * @param agentUrl - The machine's origin (`HNS_AGENT_URL`).
 * @returns The origin and {@link MACHINE_RPC_PATH}, with one separator between them.
 * @throws Error when the origin is empty: a relay with nowhere to go is a wiring defect, and the
 * call is recorded as refused rather than sent to the object itself.
 */
function machineUrl(agentUrl: string): string {
  if (agentUrl.length === 0) throw new Error("the machine's origin is not configured");
  return agentUrl.replace(/\/+$/u, "") + MACHINE_RPC_PATH;
}

/** The headers of one signed machine request (0148's control-plane signature). */
async function signedHeaders(
  seed: string,
  machineId: string,
  body: Uint8Array,
  requestId: string,
  now: number,
  path: string,
): Promise<Headers> {
  const padded = seed.replace(/-/gu, "+").replace(/_/gu, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  if (bytes.byteLength !== 32) throw new Error("the control-plane key is not a 32-byte seed");
  const der = new Uint8Array(PKCS8_PREFIX.byteLength + bytes.byteLength);
  der.set(PKCS8_PREFIX);
  der.set(bytes, PKCS8_PREFIX.byteLength);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  const signature: RequestSignature = {
    machineId,
    connection: OBJECT_CONNECTION,
    seq: OBJECT_SEQ,
    timestamp: String(now),
    nonce: crypto.randomUUID(),
    method: "POST",
    path,
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
  const signed = await crypto.subtle.sign({ name: "Ed25519" }, key, signatureMessage(signature));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-request-id", requestId);
  headers.set(SIGNED_HEADER_BY_FIELD.machineId, signature.machineId);
  headers.set(SIGNED_HEADER_BY_FIELD.connection, signature.connection);
  headers.set(SIGNED_HEADER_BY_FIELD.seq, signature.seq);
  headers.set(SIGNED_HEADER_BY_FIELD.timestamp, signature.timestamp);
  headers.set(SIGNED_HEADER_BY_FIELD.nonce, signature.nonce);
  headers.set(SIGNED_HEADER_BY_FIELD.signature, toBase64Url(new Uint8Array(signed)));
  return headers;
}

/**
 * Build the granted path over one object.
 *
 * @param options - The issuer, the audit, the machine, the key, the manifests, the clock.
 * @returns The path: the state the RPC keeps between turns, and the relay a call goes through.
 */
export function createToolPath(options: ToolPathOptions): ToolPath {
  let newest: PolicySnapshot | undefined;
  const tokens = new Map<string, RunToken>();
  const state: ToolPathState = {
    snapshot: () => newest,
    async admitTurn(raw) {
      const parsed = v.safeParse(PolicySnapshotSchema, raw);
      if (!parsed.success) {
        return { ok: false, code: "invalid_request", message: "the policy snapshot is not one" };
      }
      const snapshot = parsed.output;
      if ((await policyHash(snapshot.document)) !== snapshot.hash) {
        return {
          ok: false,
          code: "invalid_request",
          message: "the policy snapshot is not the revision it names",
        };
      }
      if (newest !== undefined && snapshot.revision < newest.revision) {
        // The Worker read the policy before a revision this object already admitted a turn under:
        // issuing under that snapshot would grant rules that are no longer active.
        return {
          ok: false,
          code: "epoch_stale",
          message: "the policy snapshot is older than revision " + String(newest.revision),
        };
      }
      newest = snapshot;
      return { ok: true, snapshot };
    },
    mint(runId) {
      const token = crypto.randomUUID();
      tokens.set(runId, { value: token, expiresAt: options.now() + TOOL_RUN_TOKEN_TTL_MS });
      return token;
    },
    check(runId, token) {
      const known = tokens.get(runId);
      if (known === undefined || token === null || token.length === 0) return false;
      if (options.now() >= known.expiresAt) {
        tokens.delete(runId);
        return false;
      }
      return token === known.value;
    },
    forget(runId) {
      tokens.delete(runId);
    },
  };
  return {
    state,
    async relay(runId, request) {
      return await relayOne({ runId, request, options, snapshot: newest });
    },
  };
}

/** What one relay is given. */
interface RelayInput {
  readonly runId: string;
  readonly request: GrantedCallRequest;
  readonly options: ToolPathOptions;
  readonly snapshot: PolicySnapshot | undefined;
}

/** What a relayed call's audit rows name: its identity, its grant, and when it started. */
interface AuditedCall {
  readonly call: ToolCall;
  readonly manifest: ToolManifest;
  readonly callHash: string;
  readonly argsHash: string;
  readonly manifestHash: string;
  readonly grantId: string | undefined;
  readonly startedAt: number;
}

/**
 * Issue, relay, and record one granted call.
 *
 * @remarks
 * Each step's failure is the call's decision, and every decision is recorded:
 *
 * 1. the call and its manifest are parsed against the contract;
 * 2. the grant is issued for this run under the snapshot the turn was admitted under;
 * 3. a grant this object's ledger says is revoked is refused here (`grant_revoked`), so a revoked
 *    grant never reaches a machine;
 * 4. the granted call is relayed to the machine, signed with the control-plane key;
 * 5. `tool.call` is appended before the relay and `tool.result` after it, so a row that cannot be
 *    written withholds the answer (fail closed, §8).
 *
 * The signed grant is never in the audit: the rows carry the `grantId` and the decision.
 */
async function relayOne(input: RelayInput): Promise<ToolRelayOutcome> {
  const { options, snapshot } = input;
  const call = v.safeParse(ToolCallSchema, input.request.call);
  const manifest = v.safeParse(ToolManifestSchema, input.request.manifest);
  const machine = options.machine;
  const machineId = options.machineId;
  const seed = options.controlPlaneKey;
  const agentUrl = options.agentUrl;
  const issuer = options.issuer;
  if (
    issuer === undefined ||
    machine === undefined ||
    machineId === undefined ||
    seed === undefined ||
    agentUrl === undefined
  ) {
    // Fail closed: an object that cannot issue or cannot relay runs no granted call.
    return {
      ok: false,
      code: "unavailable",
      message: "this Session cannot issue or relay a granted call",
    };
  }
  if (snapshot === undefined) {
    // The control channel presented no revision: an allow could not be recorded against one.
    return {
      ok: false,
      code: "invalid_request",
      message: "no policy snapshot was admitted for this turn",
    };
  }
  if (!call.success || !manifest.success) {
    return { ok: false, code: "invalid_request", message: "the call is not a tool call" };
  }
  const toolCall = call.output;
  const toolManifest = manifest.output;
  const digest = await digestCall(toolCall);
  const audited: AuditedCall = {
    call: toolCall,
    manifest: toolManifest,
    callHash: digest.callHash,
    argsHash: digest.argsHash,
    manifestHash: await manifestHash(toolManifest),
    grantId: undefined,
    startedAt: options.now(),
  };
  const manifests = await options.manifests();
  // A run whose grant was revoked is over: it gets no replacement and relays nothing. Relaying here
  // is what keeps the run's end immediate — the window between a revocation and the grant's own
  // expiry (at most 60 seconds) is closed by this check, not by the clock.
  const bound = await options.grantOf(input.runId);
  if (bound !== undefined && (await options.revoked(bound.grantId))) {
    const decision = deny("grant_revoked", "the grant was revoked by its issuer");
    await appendAudit(options, audited, "tool.call", undefined);
    await appendAudit(options, audited, "tool.result", decision);
    return { ok: true, answer: denialAnswer(decision) };
  }
  const issued = await issuer.issue({
    snapshot,
    request: {
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      machineId,
      toolId: toolCall.toolId,
      toolVersion: toolCall.toolVersion,
      manifestHash: audited.manifestHash,
      maxBytes: input.request.bytes,
    },
    runId: input.runId,
    agentId: options.sessionId,
    manifests,
  });
  if (!issued.ok) {
    // The policy refused the grant: the answer is the denial, and the audit records the call's
    // refusal (one `tool.call`, one `tool.result`, no grant).
    await appendAudit(options, audited, "tool.call", undefined);
    await appendAudit(options, audited, "tool.result", issued.decision);
    return { ok: true, answer: denialAnswer(issued.decision) };
  }
  const grant = issued.grant;
  const withGrant: AuditedCall = { ...audited, grantId: grant.payload.grantId };
  // Only this object's own grants can be in its ledger: a grant of another object is not one it may
  // spend, and its ledger cannot vouch for it.
  if (grant.payload.sessionId !== options.sessionId) {
    const decision = deny("grant_invalid", "the grant was issued by another Session");
    await appendAudit(options, withGrant, "tool.call", undefined);
    await appendAudit(options, withGrant, "tool.result", decision);
    return { ok: true, answer: denialAnswer(decision) };
  }
  if (await options.revoked(grant.payload.grantId)) {
    const decision = deny("grant_revoked", "the grant was revoked by its issuer");
    await appendAudit(options, withGrant, "tool.call", undefined);
    await appendAudit(options, withGrant, "tool.result", decision);
    return { ok: true, answer: denialAnswer(decision) };
  }
  await appendAudit(options, withGrant, "tool.call", undefined);
  const body: GrantedCall = {
    op: "tool",
    authorization: grant,
    call: toolCall,
    manifest: toolManifest,
    activePolicy: { revision: snapshot.revision, hash: snapshot.hash },
    bytes: input.request.bytes,
  };
  let answer: GrantedAnswer;
  try {
    answer = await relayToMachine(seed, machineId, agentUrl, body, options);
  } catch (error) {
    // The relay itself failed: the call is recorded as refused, never as run.
    const decision = deny(
      "grant_invalid",
      "the machine did not answer a granted call: " +
        (error instanceof Error ? error.name : "unknown"),
    );
    await appendAudit(options, withGrant, "tool.result", decision);
    return {
      ok: false,
      code: "unavailable",
      message: "The machine did not answer a granted call.",
    };
  }
  await appendAudit(options, withGrant, "tool.result", answer.decision);
  return { ok: true, answer };
}

/**
 * Send one granted call to the machine and parse its answer.
 *
 * @param seed - The control-plane seed the request is signed with.
 * @param machineId - The machine the request names.
 * @param body - The granted call.
 * @param options - The object's clock and its fetch.
 * @returns The machine's answer.
 * @throws Error when nothing usable came back: a body that is not a decision is never read as one.
 */
async function relayToMachine(
  seed: string,
  machineId: string,
  agentUrl: string,
  body: GrantedCall,
  options: ToolPathOptions,
): Promise<GrantedAnswer> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const path = MACHINE_RPC_PATH;
  const headers = await signedHeaders(
    seed,
    machineId,
    bytes,
    "tool:" + body.call.callId,
    options.now(),
    path,
  );
  const url = machineUrl(agentUrl);
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers,
    body: bytes,
  });
  const text = await response.text();
  const envelope = v.safeParse(
    v.union([
      v.object({ ok: v.literal(true), op: v.literal("tool"), result: v.unknown() }),
      v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
    ]),
    JSON.parse(text),
  );
  if (!envelope.success) throw new Error("the machine answered something else");
  if (!envelope.output.ok) throw new Error("the machine refused: " + envelope.output.code);
  const answer = v.safeParse(GrantedAnswerSchema, envelope.output.result);
  if (!answer.success) throw new Error("the machine answered no decision");
  return answer.output;
}

/**
 * A denial as the machine's answer carries it.
 *
 * @param decision - A deny decision.
 * @returns The answer with that denial and no result: nothing ran.
 */
function denialAnswer(decision: PolicyDecision): GrantedAnswer {
  if (decision.outcome === "allow") {
    // An allow with no machine answer is not a denial; the callers of this only pass denials.
    throw new Error("a denial answer was built from an allow");
  }
  return { decision };
}

/**
 * Append one audit row for a relayed call.
 *
 * @param options - The audit and the ids.
 * @param audited - The call's identity and the grant.
 * @param event - `tool.call` or `tool.result`.
 * @param decision - The decision, for a result.
 * @throws Whatever the audit rejects with: the answer is withheld (fail closed, §8).
 */
async function appendAudit(
  options: ToolPathOptions,
  audited: AuditedCall,
  event: "tool.call" | "tool.result",
  decision: PolicyDecision | undefined,
): Promise<void> {
  // The row is built field by field: a grant is named only when the call had one, and the JSON
  // members are the contract's own, so nothing else can reach the chain.
  const base = {
    v: 1 as const,
    eventId: options.eventId(),
    at: isoTimestamp(new Date(audited.startedAt).toISOString()),
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    callId: audited.call.callId,
    callHash: audited.callHash,
    argsHash: audited.argsHash,
    toolId: audited.call.toolId,
    toolVersion: audited.call.toolVersion,
    manifestHash: audited.manifestHash,
    prevHash: null,
    hash: "",
  };
  const decisionOf = decision ?? deny("unsupported", "the call was not decided");
  const row: AuditEvent | (AuditEvent & { readonly grantId: string }) =
    event === "tool.call"
      ? audited.grantId === undefined
        ? { ...base, event: "tool.call" }
        : { ...base, event: "tool.call", grantId: audited.grantId }
      : audited.grantId === undefined
        ? {
            ...base,
            event: "tool.result",
            decision: decisionOf,
            durationMs: options.now() - audited.startedAt,
          }
        : {
            ...base,
            event: "tool.result",
            decision: decisionOf,
            durationMs: options.now() - audited.startedAt,
            grantId: audited.grantId,
          };
  await options.audit.append(row);
}
