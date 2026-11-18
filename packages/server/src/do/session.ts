import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Report, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { AgentEvent } from "@hns/agent";
import {
  openSession,
  type AgentLiveWatch,
  type AgentSession,
  type SessionOptions,
} from "@hns/agent/session";
import { isoTimestamp, obsPath, type LiveSendRejectionCode } from "@hns/core";
import { migrateStore } from "@hns/store";
import { openConversationIndex } from "@hns/store/conversation-index";
import { createCostGate, type CostGate } from "../cost/index.ts";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import { problem } from "../edge/problem.ts";
import { handleObsRpc } from "../obs/api.ts";
import { agentEntry, doEntry } from "../obs/log.ts";
import { createObsStore, type ObsStore } from "../obs/store.ts";
import {
  defaultLiveUpgradeResponse,
  defaultWebSocketPair,
  LiveConnection,
  openLiveSocket,
  readLiveAttachment,
  type LiveSocket,
  type LiveSocketHost,
  type LiveSendPort,
  type LiveSocketPairFactory,
  type LiveUpgradeResponseFactory,
} from "../ws.ts";
import { LEGACY_SESSION_NAME } from "../session-name.ts";
import { TOOL_RUN_ROUTE, TOOL_RUN_TOKEN_HEADER } from "@hns/workspace/protocol";
import type { ToolRunTransport } from "./session-tools.ts";
import {
  ToolTransportError,
  sessionGrantPath,
  type GrantSource as GrantSourcePort,
  type RuntimeGrantPath,
  type ToolTransport as ToolTransportPort,
} from "@hns/agent";
import * as v from "valibot";
import { grantSigner, type GrantSigner } from "../capability/signing.ts";
import { armWake } from "./alarm.ts";
import { auditEventIds, auditSink, createPolicyAudit, type PolicyAudit } from "./audit.ts";
import { createSqliteGrantRecorder, openGrantTables } from "./grant-store.ts";
import {
  createGrantPlane,
  toolManifests,
  type GrantPlane,
  type PolicySnapshot as GrantPolicySnapshot,
  type GrantRequest,
} from "./session-grants.ts";
import {
  createToolPath,
  type GrantedCallRequest,
  type GrantIssuer,
  type ToolPath,
  type ToolPathOptions,
  type ToolRelayOutcome,
} from "./session-tools.ts";
import { GrantedAnswerSchema } from "@hns/workspace/protocol";
import { createSignedMachineFiles, type MachineCall, type MachineFiles } from "./machine.ts";
import { SESSION_NAME_HEADER } from "../edge/env.ts";
import { createOfficeRows } from "./office-rows.ts";
import {
  OFFICE_CALL_TIMEOUT_MS,
  createOfficePreview,
  documentPreviewView,
  officeFailureOf,
  probeOfficeEngine,
} from "./office-job.ts";
import type { OfficeEngineView } from "./office-job.ts";
import { officePathOf } from "./office-path.ts";
import { artifactStream } from "./office-artifact.ts";

import type {
  DocumentPreviewView,
  OfficeEngineProbeAnswer,
  OfficeFailureView,
  OfficePreviewFace,
} from "./office-job.ts";
import {
  OFFICE_PREVIEW_PATH,
  officeArtifactContentType,
  officeAuditDetail,
  parsePreviewQuery,
} from "@hns/core/office";
import type { PreviewQuery } from "@hns/core/office";

/** The internal routes the GraphQL face reaches the office rows on (0237). */
const OFFICE_RPC_PREFIX = "/rpc/office/";

/** The office error codes, as this module names one. */
type OfficeErrorCodeValue = import("@hns/core/office").OfficeErrorCode;

/** What one office RPC answers: the preview union, the engine union, or the engine's own union. */
type OfficeRpcBody = DocumentPreviewView | OfficeEngineView | OfficeFailureView;
import { grantInternalToken } from "./grant-subject.ts";
import { modelsFor } from "./models.ts";
import { SessionIndex } from "./session-index.ts";
import { handleSessionRpc } from "./session-rpc.ts";
import { incompleteToolPathMessage, toolPathMode } from "./tool-path-mode.ts";
import type { SessionEnv, SessionState } from "./state.ts";

/**
 * The turn route's success answer, as the chat port reads it.
 *
 * @remarks
 * The route answers `{ ok: true, submissionId, status, text }`; the port needs the id, which is
 * what the client shows beside its own `clientMessageId`.
 */
const TurnAnswerSchema = v.object({
  ok: v.literal(true),
  submissionId: v.string(),
});

/** The body the chat port posts to its own turn route; `null` is the abort route's. */
type ChatRequestBody = { readonly text: string; readonly requestId: string } | null;

/** What the object's own RPC answered: the status, and the parsed body (null when none). */
interface ChatRpcAnswer {
  readonly status: number;
  readonly answer: unknown;
}

/**
 * The refusal a send or an abort was answered with.
 *
 * @param message - What the person is told.
 * @param status - The object's own status for the route.
 * @returns The refusal, in the vocabulary the client branches on: a conversation the object does
 * not hold is `unknown_conversation`, and anything else is a transient `unavailable`.
 *
 * @remarks
 * Exported because it is the one place the object's 404 becomes the client's
 * `unknown_conversation`. The socket's test builds the object's port over this function, so
 * the mapping it checks is the production one rather than a copy of it.
 *
 * @internal
 */
export function refusalOf(
  message: string,
  status: number,
): { readonly ok: false; readonly code: LiveSendRejectionCode; readonly message: string } {
  return status === 404
    ? { ok: false, code: "unknown_conversation", message }
    : { ok: false, code: "unavailable", message };
}

/** The host callbacks the Session gives the runtime. */
interface SessionHooks {
  readonly onWake: (wake: Wake) => void;
  readonly onReport: (report: Report) => void;
  readonly onEvent: (event: AgentEvent) => void;
}

/**
 * Opens one runtime over a Durable Object state; tests substitute the storage.
 *
 * @remarks
 * The policy audit is opened by the object before the runtime, so the runtime's job is to carry it to
 * the agent (`openDurableSession`); a test's runtime can record what it was given instead.
 */
export type SessionRuntimeFactory = (
  state: SessionState,
  env: SessionEnv,
  hooks: SessionHooks,
  audit: PolicyAudit,
  grantPath: RunGrantPathFactory | undefined,
) => Promise<AgentSession>;

/**
 * How a run's granted path is built, as `openSession` asks for one per run.
 *
 * @remarks
 * The factory is asked once per conversation id (the run), and answers that run's path or
 * `undefined` when the object's granted path is closed — which keeps every run on the Phase 0
 * tools. It is a factory rather than the path itself so the object still owns what a run may hold:
 * the token, the transport, and the issuer.
 */
export type RunGrantPathFactory = (runId: string) => RuntimeGrantPath | undefined;

/** The host seams the Session takes from the Workers runtime; tests inject these. */
export interface SessionDependencies {
  /** Builds the client/server pair for a WebSocket upgrade; defaults to Workers' WebSocketPair. */
  readonly webSocketPair?: LiveSocketPairFactory | undefined;
  /** The clock for delta batching; defaults to Date.now. */
  readonly now?: (() => number) | undefined;
  /** Builds the 101 response; Node tests inject a factory because its Response refuses 101. */
  readonly upgradeResponse?: LiveUpgradeResponseFactory | undefined;
  /**
   * The machine wire the granted path relays over; `fetch` in production.
   *
   * @remarks
   * A seam, like the socket pair: the granted path sends its signed request to the machine's
   * origin, and a test that proves the object's transport, route, and relay must stand in for the
   * machine's process without touching the Worker's network.
   */
  readonly machineFetch?: ToolPathOptions["fetch"] | undefined;
  /**
   * The machine's origin the office wire signs for; defaults to `HNS_AGENT_URL`.
   *
   * @remarks
   * A seam, like {@link machineFetch}: a test that proves the office face end to end runs a **real**
   * machine on a loopback port it does not know at construction (the port is chosen when the agent
   * starts). When it is unset — **production always leaves it unset** — the office wire signs for
   * `HNS_AGENT_URL`, and a deployment without that binding answers every preview request with
   * the failure union's `engine_unavailable` (the object has no machine to ask).
   *
   * **The production Worker passes neither this nor `machineFetch`**, so nothing is substituted
   * at the entry (`edge/worker.ts` exports its table, and `seams.test.ts` pins it).
   *
   * @internal
   */
  readonly officeAgentUrl?: string | undefined;
  /**
   * Opens the runtime the object serves from; defaults to `openDurableSession` (pi-durable on the
   * object's SQLite storage).
   *
   * @remarks
   * A seam, like {@link machineFetch}: a test that proves a route with a **real** `@hns/agent`
   * session — rather than a fake that answers whatever the test wants — needs the production object
   * around a runtime it can hold, and `openDurableSession` is bound to this object's storage and
   * env. **The production Worker passes neither this nor `machineFetch`**, so nothing is
   * substituted at the entry (`edge/worker.ts` exports its table so the test reads it).
   *
   * @internal
   */
  readonly open?: SessionRuntimeFactory | undefined;
  /**
   * The cost gate the object admits turns through.
   *
   * @remarks
   * A seam, like `open`: production reads the gate from the control database (`DB`), and a test
   * that proves **how often** a turn passes the gate needs a gate it can count. When given, it
   * replaces the one the object would build, and the database is not read for it.
   *
   * @internal
   */
  readonly cost?: CostGate | undefined;
}

/**
 * The conversation whose run an RPC ended, or undefined.
 *
 * @param path - The internal path.
 * @param method - The method the request used.
 * @param status - The answer's status.
 * @returns The conversation id of a successful `POST /rpc/conversations/<id>/abort`.
 *
 * @remarks
 * An abort is how a run is stopped, and stopping it ends the run. A refused abort (an unknown
 * conversation) ended nothing and revokes nothing.
 */
function abortedConversation(path: string, method: string, status: number): string | undefined {
  if (method !== "POST" || status < 200 || status >= 300) return undefined;
  const match = /^\/rpc\/conversations\/([^/]+)\/abort$/u.exec(path);
  return match?.[1];
}

/** Whether a Session RPC path is the turn route (one conversation's message send). */
function isTurn(path: string): boolean {
  return path.startsWith("/rpc/conversations/") && path.endsWith("/messages");
}

/** One accepted live socket and what keeps it fed. */
interface LiveEntry {
  readonly connection: LiveConnection;
  readonly watch: AgentLiveWatch;
}

/**
 * Open the production runtime: pi-durable on the object's SQLite storage.
 *
 * @internal
 * @remarks
 * The policy audit is the object's own table (`policy_audit`, beside the harness's prefixed tables),
 * and its sink is what `openSession`'s `onAudit` is given: every `tool.call` and `tool.result`
 * is appended before it settles the call, and an append that fails refuses the result rather than
 * losing the row (`docs/capability.md` §8). The audit is not optional in production: without it the
 * Session would run tools with no record of the decision, which is the fail-open this contract
 * exists to prevent.
 */
async function openDurableSession(
  state: SessionState,
  env: SessionEnv,
  hooks: SessionHooks,
  audit: PolicyAudit,
  grantPathOf: RunGrantPathFactory | undefined,
): Promise<AgentSession> {
  const storage = await openDurableObjectSqliteStorage(state.storage, {
    prefix: "hns_session",
  });
  const { models, model } = modelsFor(env);
  const ids = auditEventIds(state.id?.name ?? LEGACY_SESSION_NAME);
  // Nothing here knows a conversation yet: the identity is the wiring's, and each call's run is the
  // tool task's conversation, which the agent's hooks read from their own context (`runIdentityOf`).
  const currentConversation = (): string | undefined => undefined;
  const common: SessionOptions = {
    storage,
    models,
    registry: createRegistry(),
    model,
    context: BACKGROUND_CONTEXT,
    onWake: hooks.onWake,
    onReport: hooks.onReport,
    onEvent: hooks.onEvent,
    onAudit: auditSink(audit),
    auditIdentity: {
      workspaceId: state.id?.name ?? LEGACY_SESSION_NAME,
      // The row's session is the object (the workspace); the run is the conversation, and it is
      // what a granted call is issued and relayed as, so a revoke by the run finds its grants.
      sessionId: state.id?.name ?? LEGACY_SESSION_NAME,
      eventId: () => ids.next(),
      conversationId: currentConversation(),
    },
  };
  // The granted path is per run; the object builds each run's transport, so the agent's tool code
  // holds only the issuer and the relay, never a key or a machine's URL.
  // The factory is the object's own: it answers the run the runtime asks for, which in production is
  // the tool task's conversation (the agent's hooks read it from their own API).
  return openSession(grantPathOf === undefined ? common : { ...common, grantPath: grantPathOf });
}

/**
 * One workspace's Session Durable Object.
 *
 * @remarks
 * The object owns the Harness lifecycle and the monthly cost gate: opening on SQLite, arming
 * the recovery alarm, resuming work, refusing a new run when a monthly limit is used up, and
 * forwarding internal RPC. Conversation semantics live in `@hns/agent/session`. The class is
 * plain (not a `DurableObject` subclass) so tests and the Worker share one structural
 * `SessionState`.
 */
export class Session {
  readonly #state: SessionState;
  readonly #env: SessionEnv;
  readonly #open: SessionRuntimeFactory;
  readonly #pair: LiveSocketPairFactory;
  readonly #now: () => number;
  readonly #upgradeResponse: LiveUpgradeResponseFactory;
  readonly #ready: Promise<void>;
  readonly #live = new Map<LiveSocket, LiveEntry>();
  readonly #agentRequestIds = new Set<string>();
  #cost: CostGate | undefined;
  /** The gate a test injected; production leaves it out and the object reads `DB`. */
  readonly #givenCost: CostGate | undefined;
  #obs: ObsStore | undefined;
  #audit: PolicyAudit | undefined;
  #index: SessionIndex | undefined;
  #grants: GrantPlane | undefined;
  #tools: ToolPath | undefined;
  /** The office preview rows and the alarm's work (0237); opened with the object. */
  #office: OfficePreviewFace | undefined;
  /** The workspace the office rows belong to: the object's name. */
  #workspace = LEGACY_SESSION_NAME;
  /**
   * The machine's office wire, or undefined when this object has no machine to ask.
   *
   * @remarks
   * Built once from the same three bindings the granted path uses (`HNS_AGENT_URL`,
   * `HNS_CONTROL_PLANE_KEY`, and the machine id). A Session without them answers `disabled`
   * for every preview request: it cannot reach a machine, so it cannot offer one.
   */
  #officeMachine: { readonly machine: MachineFiles; readonly machineId: string } | undefined;
  /** The machine origin the office wire signs for; the environment's unless a test names one. */
  readonly #officeAgentUrl: string | undefined;
  /** The token each run's relay was minted with, so a test can serve the route as its agent. */
  readonly #runTokens = new Map<string, string>();
  readonly #machineFetch: ToolPathOptions["fetch"] | undefined;
  /** The runs' relays, by conversation: one token and one transport per run. */
  readonly #transports = new Map<string, ToolRunTransport>();
  /**
   * The token one run's relay was minted with, for a test that serves the route itself.
   *
   * @internal
   */
  runToken(runId: string): string | null {
    return this.#runTokens.get(runId) ?? null;
  }

  /**
   * Relay one granted call through the object's own path, as its route does after the token check.
   *
   * @param runId - The run (a conversation) that asks.
   * @param request - The call, its manifest, and the bytes.
   * @returns The machine's answer, or the relay's failure.
   *
   * @internal
   * @remarks
   * The route forgets a run's relay token when the run ends, so a test that asks what the object
   * decides *after* a run's abort cannot use the token route; it asks the same path method here.
   */
  async relayForTest(runId: string, request: GrantedCallRequest): Promise<ToolRelayOutcome> {
    const tools = this.#tools;
    if (tools === undefined) return { ok: false, code: "unavailable", message: "no granted path" };
    return await tools.relay(runId, request);
  }
  /**
   * The runs' granted paths: one per run, so its grant cache covers the whole run's tool calls.
   *
   * @remarks
   * The agent's hooks ask for a path at every call; answering a new object (and so a new cache)
   * each time would issue a grant per call, which is the round trip the cache exists to remove.
   * A path is dropped with its run's transport (`closeRun`).
   */
  readonly #grantPaths = new Map<string, RuntimeGrantPath>();
  /**
   * The grants this object revoked: the object's revocation statement, as the ledger wrote it.
   *
   * @remarks
   * Written when a run's grants are revoked (its abort, or the object closing), so the granted path
   * can refuse a grant before a machine sees it without reading the ledger per call.
   */
  readonly #revokedGrants = new Set<string>();
  /**
   * The runs whose turn ended, and which therefore refuse further relays until their next turn.
   *
   * @remarks
   * A revocation is the run's end. The ledger keeps the revoked grant (the audit's fact), and this
   * set makes the ended turn's relays `grant_revoked`; the next turn clears it, so a conversation is
   * not left without tools after an abort.
   */
  readonly #endedTurns = new Set<string>();
  #session: AgentSession | undefined;
  #closed = false;

  /**
   * @param state - The object's state (storage, name, the alarm methods).
   * @param env - The object's bindings.
   * @param open - The runtime factory; `openDurableSession` unless a test names another.
   * @param dependencies - Host seams (`webSocketPair`, `machineFetch`, …); production passes none.
   */
  constructor(
    state: SessionState,
    env: SessionEnv,
    open: SessionRuntimeFactory = openDurableSession,
    dependencies: SessionDependencies = {},
  ) {
    this.#state = state;
    this.#env = env;
    this.#open = dependencies.open ?? open;
    this.#pair = dependencies.webSocketPair ?? defaultWebSocketPair;
    this.#now = dependencies.now ?? Date.now;
    this.#upgradeResponse = dependencies.upgradeResponse ?? defaultLiveUpgradeResponse;
    this.#machineFetch = dependencies.machineFetch;
    this.#officeAgentUrl = dependencies.officeAgentUrl;
    this.#givenCost = dependencies.cost;
    this.#ready = state.blockConcurrencyWhile(() => this.#initialize());
  }

  /**
   * Open the grant plane: the ledger, the issuance audit, and the control-plane signer.
   *
   * @returns The plane; a Session with no usable signer still has one that refuses every request.
   *
   * @remarks
   * The signer is the control-plane key (0148's, the same the Worker signs machine requests with).
   * A missing, malformed, or unusable key does **not** stop the object — conversations do not need a
   * grant — but the plane it builds issues nothing: every request is refused, which is the fail-closed
   * answer the issue asks for when WebCrypto cannot sign (`grant_algorithm_mismatch` /
   * `unavailable` at the key, a deny at the request). The tables are the object's own SQLite.
   *
   * @throws Whatever opening the tables throws: a grant surface with no table would be a grant with no
   * record, so the object stops here instead.
   */
  async #openGrantPlane(): Promise<GrantPlane> {
    // The tables' transaction serializes the audit's chain and the ledger's write with each other.
    const tables = openGrantTables(this.#state.storage);
    const name = this.#state.id?.name ?? LEGACY_SESSION_NAME;
    const ids = auditEventIds(name);
    let signer: GrantSigner | undefined;
    const seed = this.#env.HNS_CONTROL_PLANE_KEY;
    if (seed !== undefined && seed.length > 0) {
      const imported = await grantSigner({ seed });
      signer = imported.ok ? imported.signer : undefined;
      if (!imported.ok) console.error("session grant signer unavailable", imported.code);
    }
    const recorder = createSqliteGrantRecorder({
      ledger: tables.ledger,
      audit: tables.audit,
      transaction: (run) => this.#state.storage.transaction(run),
      eventId: () => "grant:" + ids.next(),
    });
    return createGrantPlane({
      signer,
      recorder,
      workspaceId: name,
      sessionId: name,
      now: this.#now,
      eventId: () => ids.next(),
    });
  }

  /**
   * Revoke the grants a run held, because the run ended.
   *
   * @param runId - The conversation whose run ended.
   * @returns The grants revoked, and the ones whose revocation failed.
   *
   * @remarks
   * The abort path is the one the agent's own `abort` reaches: the run it ended held grants bound to
   * its conversation id, and they are revoked **before the abort answers**, so a machine refuses them
   * as `grant_revoked` from the moment the caller sees the abort succeed. A revocation that fails is
   * recorded as `grant.revoke_failed` (the plane) and logged here with its name; the grant then lives
   * until its own expiry, at most 60 seconds, which is the window the record exists for.
   */
  async #revokeRun(runId: string): Promise<{
    readonly revoked: readonly string[];
    readonly failed: readonly string[];
  }> {
    const grants = this.#grants;
    if (grants === undefined) return { revoked: [], failed: [] };
    try {
      const outcome = await grants.revokeRun(runId);
      for (const grantId of outcome.revoked) this.#revokedGrants.add(grantId);
      // The run's turn is over: its ledger rows stay (and stay revoked), and the run refuses relays
      // until its next turn begins. The next turn clears the mark (`beginTurn`).
      if (outcome.revoked.length > 0) this.#endedTurns.add(runId);
      return outcome;
    } catch (error) {
      console.error("session grant revoke failed", error instanceof Error ? error.name : "unknown");
      return { revoked: [], failed: [] };
    }
  }

  /**
   * Revoke every run's grants when the object closes; the conversations it knows are the runs.
   *
   * @param session - The runtime, for the conversations.
   * @returns The ids revoked across every run.
   *
   * @remarks
   * The close path is awaited by the caller that closes the object, so a test can wait for it and a
   * deployment's close does not answer before the revocations were attempted. A conversation list
   * that cannot be read revokes nothing and is logged: the grants then end at their own expiry.
   */
  async #revokeRuns(session: AgentSession): Promise<readonly string[]> {
    const revoked: string[] = [];
    try {
      const conversations = await session.listConversations();
      for (const conversation of conversations) {
        const outcome = await this.#revokeRun(String(conversation.id));
        revoked.push(...outcome.revoked);
      }
    } catch (error) {
      console.error("session grant revoke failed", error instanceof Error ? error.name : "unknown");
    }
    return revoked;
  }

  /**
   * Open the object's granted tool path, or leave it closed.
   *
   * @returns The path, or undefined when the deployment cannot do every step of a granted call.
   *
   * @remarks
   * A granted call needs all of: an issuer (the plane and its signer), a machine to relay to, the
   * control-plane key the relay is signed with, and the machine's id the grant names. Missing any of
   * them the path is **off**: no run is given a granted path, every send is answered without one, and
   * the relay route answers `unavailable` — the kill switch of this feature is the deployment's
   * bindings, not a flag that a half-configured object could turn on.
   *
   * The machine is addressed by `HNS_AGENT_URL` (the machine this object serves) and its id by
   * `HNS_MACHINE_ID`; the same control-plane key signs the relay as signs a grant (0148).
   */
  #openToolPath(): ToolPath | undefined {
    const audit = this.#audit;
    const grants = this.#grants;
    if (audit === undefined || grants === undefined) return undefined;
    const agentUrl = this.#env.HNS_AGENT_URL;
    const machineId = this.#env.HNS_MACHINE_ID;
    const seed = this.#env.HNS_CONTROL_PLANE_KEY;
    if (agentUrl === undefined || machineId === undefined || seed === undefined) return undefined;
    if (seed.length === 0) return undefined;
    const name = this.#state.id?.name ?? LEGACY_SESSION_NAME;
    const ids = auditEventIds(name);
    const machine: MachineFiles = createSignedMachineFiles(
      { agentUrl, controlPlaneKey: seed },
      { now: this.#now },
    );
    const options: ToolPathOptions = {
      workspaceId: name,
      sessionId: name,
      issuer: this.#grantIssuer,
      audit,
      machine,
      controlPlaneKey: seed,
      machineId,
      agentUrl,
      manifests: toolManifests,
      revoked: async (grantId) => {
        return this.#revokedGrants.has(grantId);
      },
      // The run's current turn's grant, live or revoked. A revocation ends that turn; `#revokeRun`
      // marks it in #endedTurns, and the next turn clears the mark so the run is issued afresh.
      turnBegan: (runId) => {
        this.#endedTurns.delete(runId);
      },
      grantOf: async (runId) =>
        this.#endedTurns.has(runId) ? await grants.lastFor(runId) : undefined,
      now: this.#now,
      eventId: () => ids.next(),
    };
    if (this.#machineFetch !== undefined) {
      return createToolPath({ ...options, fetch: this.#machineFetch });
    }
    return createToolPath(options);
  }

  /**
   * The machine's office wire, from the bindings the granted path also reads (0237).
   *
   * @returns The port and the machine id, or undefined when this object has no machine.
   *
   * @remarks
   * The same three bindings as {@link #openToolPath}: the machine's origin, its id, and the
   * control-plane seed that signs every request to it. They are read together deliberately — an
   * object that can sign a grant but not read an artifact would offer a preview it cannot deliver
   * — and an absent one keeps office off, as it keeps the granted path off.
   */
  #machineForOffice(): { readonly machine: MachineFiles; readonly machineId: string } | undefined {
    const agentUrl = this.#officeAgentUrl ?? this.#env.HNS_AGENT_URL;
    const machineId = this.#env.HNS_MACHINE_ID;
    const seed = this.#env.HNS_CONTROL_PLANE_KEY;
    if (agentUrl === undefined || machineId === undefined) return undefined;
    if (seed === undefined || seed.length === 0) return undefined;
    return {
      machine: createSignedMachineFiles({ agentUrl, controlPlaneKey: seed }, { now: this.#now }),
      machineId,
    };
  }

  /**
   * Open the office preview rows and the alarm's work for them (0237).
   *
   * @remarks
   * Always open: the rows are an ordinary table in this object's SQLite, and an object with no
   * machine still answers `documentPreview` (with whatever rows it has) and `requestDocumentPreview`
   * (with `disabled`). A table that cannot be opened leaves office closed and is logged by name;
   * conversations do not depend on it.
   */
  #openOffice(): void {
    const name = this.#state.id?.name ?? LEGACY_SESSION_NAME;
    this.#workspace = name;
    this.#officeMachine = this.#machineForOffice();
    const machine = this.#officeMachine;
    try {
      const rows = createOfficeRows(this.#state.storage);
      this.#office = createOfficePreview({
        rows,
        now: this.#now,
        machine:
          machine === undefined
            ? undefined
            : {
                probe: async (): Promise<OfficeEngineProbeAnswer> => {
                  const answer = await machine.machine.officeEngine?.(this.#officeCall(machine));
                  if (answer === undefined) return { kind: "unavailable" };
                  if (!answer.ok) return { kind: "unavailable" };
                  return { kind: "report", report: answer.result };
                },
                job: async (job) => {
                  const answer = await machine.machine.office?.(job, this.#officeCall(machine));
                  if (answer === undefined) {
                    return { kind: "unavailable", detail: "the machine has no office" };
                  }
                  if (!answer.ok) return { kind: "unavailable", detail: answer.detail };
                  return { kind: "result", result: answer.result };
                },
              },
        record: async (record) => {
          // The file's name is the line's `path`, the column an operator already reads: the
          // detail keeps the attempt's facts and nothing of the document (C7).
          this.#obs?.append({
            v: 1,
            at: isoTimestamp(new Date(this.#now()).toISOString()),
            level: record.outcome === "ready" ? "info" : "warn",
            event: "office.job",
            hop: "do",
            path: obsPath(record.path),
            requestId: null,
            detail: officeAuditDetail({
              jobId: record.jobId,
              operation: "preview",
              path: record.path,
              version: record.version,
              inputHash: record.inputHash,
              engineVersion: record.engineVersion,
              ms: record.ms,
              outcome: record.outcome,
            }),
          });
        },
      });
    } catch (error) {
      console.error("session office open failed", error instanceof Error ? error.name : "unknown");
      this.#office = undefined;
    }
  }

  /** One machine call's identity and deadline, for the office wire. */
  #officeCall(machine: { readonly machineId: string }): MachineCall {
    return {
      machineId: machine.machineId,
      requestId: crypto.randomUUID(),
      signal: AbortSignal.timeout(OFFICE_CALL_TIMEOUT_MS),
    };
  }

  /**
   * The object's issuer for one granted call: 0224's plane, with who asks and what runs supplied.
   *
   * @remarks
   * The plane issues, records into the ledger and the issuance audit, and signs with the
   * control-plane key. The request's facts (workspace, session, machine, tool, version, manifest
   * hash, byte bound) are the object's own, built from the call the agent relayed and the snapshot
   * the turn was admitted under; the requester is the run, so the grant is revoked when the run ends.
   */
  readonly #grantIssuer: GrantIssuer = {
    issue: async (input) => {
      const plane = this.#grants;
      if (plane === undefined) {
        return {
          ok: false,
          decision: { outcome: "deny", code: "grant_invalid", message: "no grant surface" },
        };
      }
      const asked: GrantRequest = {
        workspaceId: input.request.workspaceId,
        sessionId: input.request.sessionId,
        machineId: input.request.machineId,
        toolId: input.request.toolId,
        toolVersion: input.request.toolVersion,
        manifestHash: input.request.manifestHash,
      };
      // Absent means the manifest's own bound, which the issuer applies.
      const request: GrantRequest =
        input.request.maxBytes > 0 ? { ...asked, maxBytes: input.request.maxBytes } : asked;
      const issue = await plane.one({
        request,
        snapshot: input.snapshot,
        requestedBy: { kind: "agent", id: input.agentId, runId: input.runId },
        manifests: input.manifests,
      });
      return issue.ok ? { ok: true, grant: issue.grant } : { ok: false, decision: issue.decision };
    },
  };

  /**
   * The relay the agent's granted calls go through, bound to one run.
   *
   * @param runId - The conversation whose run asks.
   * @returns The run's transport, or undefined when the granted path is closed.
   *
   * @remarks
   * The transport the agent is given is **not** the object: it holds the run's token and the run id,
   * and every call it makes is the object's `/rpc/conversations/<runId>/tool` route. The token is
   * minted here, so a run's transport is the only holder of it; the object checks it on every relay
   * and forgets it when the run ends.
   */
  #runTransport(runId: string): ToolRunTransport | undefined {
    const tools = this.#tools;
    if (tools === undefined) return undefined;
    const known = this.#transports.get(runId);
    if (known !== undefined) return known;
    const token = tools.state.mint(runId);
    this.#runTokens.set(runId, token);
    const origin = this.#objectUrl();
    const transports = this.#transports;
    const grantPaths = this.#grantPaths;
    const runTokens = this.#runTokens;
    // The object's own route, reached in this isolate: the granted path never goes through the
    // deployment's network for it.
    const objectFetch = (request: Request): Promise<Response> => this.fetch(request);
    const transport: ToolRunTransport = {
      async call(input: GrantedCallRequest) {
        const url = origin + "/rpc/conversations/" + encodeURIComponent(runId) + TOOL_RUN_ROUTE;
        // The object's own route: the run's token is what the route checks.
        const response = await objectFetch(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json", [TOOL_RUN_TOKEN_HEADER]: token },
            body: JSON.stringify(input),
          }),
        );
        return await response.json();
      },
      async closeRun() {
        tools.state.forget(runId);
        transports.delete(runId);
        grantPaths.delete(runId);
        runTokens.delete(runId);
      },
    };
    transports.set(runId, transport);
    return transport;
  }

  /**
   * The newest policy snapshot, for issuing a grant from the agent's own source.
   *
   * @throws Error when the object's granted path is closed or no turn was admitted: a grant cannot
   * be issued without the revision it is for.
   */
  #snapshotOrThrow(): GrantPolicySnapshot {
    const snapshot = this.#tools?.state.snapshot();
    if (snapshot === undefined) throw new Error("no policy snapshot was admitted");
    return snapshot;
  }

  /**
   * One run's granted path, as the agent's runtime takes it: the issuer, and the run's relay.
   *
   * @param runId - The conversation the hooks are running in.
   * @param transport - The relay the runtime factory built; the session's own, once per session.
   * @returns The path, or undefined when the object's granted path is closed.
   *
   * @remarks
   * The source is this object's issuer, asked with the call's contract and relayed back here. The
   * agent never holds the object: the source calls the object's own `#issueForAgent` through the
   * route the transport uses, which is why the transport carries the run's token.
   */
  #grantPathFor(runId: string): RuntimeGrantPath | undefined {
    if (this.#tools === undefined) return undefined;
    // The check is the **object's** snapshot, not this run's: once any send of this object carried
    // one, every run here gets a granted path — including a run whose own send carried none. Before
    // that (an object that has never seen a policy) there is no revision to issue a grant under, so
    // no run gets one.
    if (this.#tools.state.snapshot() === undefined) return undefined;
    const known = this.#grantPaths.get(runId);
    if (known !== undefined) return known;
    const run = this.#runTransport(runId);
    if (run === undefined) return undefined;
    // One path (and so one grant cache) per run: a turn's tool calls share it, which is what makes
    // a grant cover a turn rather than a call.
    const path = sessionGrantPath({
      source: this.#agentGrantSource(runId),
      transport: this.#agentTransport(run),
    });
    this.#grantPaths.set(runId, path);
    return path;
  }

  /**
   * The object's issuer, as the agent's `GrantSource` takes it: one contract, one grant.
   *
   * @param runId - The run the grant is bound to.
   */
  #agentGrantSource(runId: string): GrantSourcePort {
    return {
      issue: async (request) => {
        const issued = await this.#grantIssuer.issue({
          snapshot: this.#snapshotOrThrow(),
          request: {
            workspaceId: this.#state.id?.name ?? LEGACY_SESSION_NAME,
            sessionId: this.#state.id?.name ?? LEGACY_SESSION_NAME,
            machineId: this.#env.HNS_MACHINE_ID ?? "",
            toolId: request.toolId,
            toolVersion: request.toolVersion,
            manifestHash: request.manifestHash,
            maxBytes: request.maxBytes ?? 0,
          },
          runId,
          agentId: this.#state.id?.name ?? LEGACY_SESSION_NAME,
          manifests: await toolManifests(),
        });
        return issued.ok
          ? { ok: true, grant: issued.grant }
          : { ok: false, decision: issued.decision };
      },
    };
  }

  /**
   * The run's relay, as the agent's `ToolTransport` takes it: the object's route, with its token.
   *
   * @param run - The run's transport (the token and the route).
   */
  #agentTransport(run: ToolRunTransport): ToolTransportPort {
    return {
      call: async (input) => {
        // The route's own body: the call, its manifest, and the bytes, at the top level.
        const answer = await run.call({
          call: input.call,
          manifest: input.contract.manifest,
          bytes: input.bytes,
        });
        const parsed = v.safeParse(GrantedAnswerSchema, answer);
        if (!parsed.success) {
          throw new ToolTransportError("the Session answered no decision");
        }
        return parsed.output;
      },
      closeRun: async () => {
        await run.closeRun();
      },
    };
  }

  /**
   * The object's own origin, for the run transports it hands the agent.
   *
   * @remarks
   * In Workers a Durable Object reaches itself through its stub; the agent's transport is created
   * by the object and called from the agent inside the same isolate, so the object's own `fetch`
   * is the destination. A deployment that moves the agent out of the isolate reaches it through the
   * binding instead (the `SESSION` binding's stub), which is the same route.
   */
  #objectUrl(): string {
    // The object's own origin: a Durable Object reaches itself through its stub, and the stub's
    // host is the internal session URL every other internal route is written against.
    return "https://session.internal";
  }

  /**
   * The token the Worker must present on the grant route.
   *
   * @returns The token, or undefined when the deployment has no session secret (the route then
   * refuses every request: an object that cannot tell the Worker from anyone else issues nothing).
   */
  async #grantToken(): Promise<string | undefined> {
    return await grantInternalToken(this.#env.HNS_SESSION_SECRET);
  }

  async #initialize(): Promise<void> {
    try {
      // Fail closed first: without the control database there is no cost gauge and no index, so
      // a deployment missing the binding must not serve work it cannot bound. Development is
      // the only exception (local unit tests; docs/limits.md). The error names no binding value.
      if (this.#env.HNS_ENV !== "dev" && this.#env.DB === undefined) {
        throw new Error("the control database binding is missing outside development");
      }
      // Then the same check for the granted tool path: its three bindings are a set. All three
      // present grants tools, none of them keeps the Phase 0 tools, and a **mixture** is a
      // deployment error: it would otherwise leave a send that carries a policy snapshot with no
      // granted path, which is a granted turn that silently runs with the model's own tools
      // (0270n). The object answers `unavailable` from then on and the error names the bindings,
      // never a value.
      const mode = toolPathMode(this.#env);
      if (mode.kind === "incomplete") throw new Error(incompleteToolPathMessage(mode));
      // Fail closed: a tool call may not run with no way to record its decision, so a table that
      // cannot be opened stops the object here (docs/capability.md §8). It is the object's own SQLite,
      // beside the harness's prefixed tables, and not D1 (D049).
      this.#audit = createPolicyAudit(this.#state.storage);
      // Fail closed as well: a grant is a capability, and one handed out with no record of it must
      // not exist (docs/capability.md §5, §9). The tables share this object's SQLite, not D1.
      this.#grants = await this.#openGrantPlane();
      // The granted tool path is on only when this object can do its whole job: issue (the plane),
      // relay (the machine and the control-plane key), and record (the audit). Otherwise it stays
      // closed: no run gets a granted path, and a send is answered without one.
      this.#tools = this.#openToolPath();
      this.#openOffice();
      try {
        // The event table shares the Session's SQLite but not the harness prefix. A failed
        // open must not stop conversations: observation is a side effect, not a precondition.
        this.#obs = createObsStore(this.#state.storage, { now: this.#now });
      } catch (error) {
        console.error("session obs open failed", error instanceof Error ? error.name : "unknown");
      }
      // A deployment migrates the control database here as well as at the edge, so the first
      // send after a deploy cannot fail closed on a missing limit row. A failed migration is
      // not a failed open: conversation reads do not need D1, and the gate still refuses a new
      // run while the limits are unreadable.
      if (this.#givenCost !== undefined) {
        this.#cost = this.#givenCost;
      } else if (this.#env.DB !== undefined) {
        try {
          await migrateStore(this.#env.DB);
        } catch (error) {
          console.error(
            "session cost migration failed",
            error instanceof Error ? error.name : "unknown",
          );
        }
        this.#cost = createCostGate({
          db: this.#env.DB,
          storage: this.#state.storage,
          now: () => new Date(this.#now()),
          // After the turn's rows are measured: a drain or an observation written here is not
          // billed to the turn.
          turnEnded: () => this.#drain("turn"),
        });
      }
      // The audit is opened above, so it cannot be absent here; the check keeps the runtime's
      // signature honest for a test that builds the object a different way.
      const audit = this.#audit;
      if (audit === undefined) throw new Error("the policy audit is not open");
      const session = await this.#open(
        this.#state,
        this.#env,
        {
          onWake: (wake) => {
            void armWake(this.#state.storage, wake, Date.now()).catch((error) => {
              console.error(
                "session wake arm failed",
                error instanceof Error ? error.name : "unknown",
              );
            });
          },
          onReport: (report) => {
            console.error(
              "session report",
              report.kind,
              report.error instanceof Error ? report.error.name : "unknown",
            );
          },
          onEvent: (event) => {
            this.#recordAgent(event);
          },
        },
        audit,
        this.#tools === undefined ? undefined : (runId) => this.#grantPathFor(runId),
      );
      this.#session = session;
      // The index is a copy: without the control database the object still runs, and the dirty
      // rows wait for a deployment that has one (D078).
      if (this.#env.DB !== undefined) {
        this.#index = new SessionIndex({
          session,
          index: openConversationIndex(this.#env.DB),
          workspaceId: this.#state.id?.name ?? LEGACY_SESSION_NAME,
          now: this.#now,
          // The index's observations are event-log rows: one shape with the worker and the
          // agent. A sink that cannot write loses the line; it never fails the turn.
          log: (entry) => {
            this.#append(entry);
          },
        });
      }
      void session.closed.then((end) => {
        this.#closed = true;
        // The close is the end of every run in the object, so no grant bound to one may outlive it.
        // The close path is awaited (a failure is recorded, not swallowed); the close itself does not
        // wait for it, because the harness has already stopped and the grant ends at its expiry.
        void this.#revokeRuns(session).then(async () => {
          for (const transport of this.#transports.values()) await transport.closeRun();
        });
        if (end.kind === "failed") this.#state.abort("harness failed");
      });
      await armWake(this.#state.storage, session.wake(), Date.now());
      // Reattach accepted sockets before resume() so a run that starts after hibernation
      // cannot advance a view that no listener observes.
      await this.#attachSockets();
      session.resume();
    } catch (error) {
      // A partly configured tool path is the one start failure whose message says **which binding**
      // is missing (0270n); an operator reads it here. Every other failure keeps the generic line:
      // the log names an error class, never a binding's name or value.
      const detail =
        toolPathMode(this.#env).kind === "incomplete" && error instanceof Error
          ? error.message
          : "";
      console.error("session open failed", error instanceof Error ? error.name : "unknown", detail);
      this.#state.abort("session open failed");
      throw error;
    }
  }

  /**
   * Handle an internal RPC request.
   *
   * @param request - A request forwarded by the Worker through the `SESSION` binding.
   * @returns The RPC response, the 101 upgrade for `/ws`, or a problem response when the Session is not open.
   *
   * @remarks
   * The edge owns authentication. These routes are unreachable from the public Worker, so
   * they do not repeat the session check; they still parse every body before using it.
   */
  async fetch(request: Request): Promise<Response> {
    const started = this.#now();
    try {
      await this.#ready;
    } catch {
      return this.#finished(
        request,
        problem("unavailable", "The Session could not be opened.", new URL(request.url).pathname),
        started,
      );
    }
    const session = this.#session;
    const path = new URL(request.url).pathname;
    if (session === undefined) {
      return this.#finished(
        request,
        problem("unavailable", "The Session is not open.", path),
        started,
      );
    }
    let response: Response;
    let turnRequestId: string | undefined;
    if (path.startsWith(OFFICE_RPC_PREFIX)) {
      response = await this.#officeRpc(path, request);
    } else if (path === OFFICE_PREVIEW_PATH) {
      // The preview's bytes (0237): the edge proved a session and forwarded the request; this
      // object authorises the file against its own workspace and streams the artifact (C1, C8).
      response = await this.previewStream(request);
    } else if (path === "/ws") {
      response = await this.#openLive(request, session);
    } else if (path === "/rpc/events" || path === "/rpc/metrics") {
      const obs = this.#obs;
      response =
        obs === undefined
          ? problem("unavailable", "The event log is not open.", path)
          : await handleObsRpc(request, obs);
    } else if (path === "/rpc/reindex") {
      response = await this.#reindex(request);
    } else {
      response = await handleSessionRpc(request, session, {
        cost: this.#cost,
        audit: this.#audit,
        grants: this.#grants,
        tools: this.#tools,
        grantToken: await this.#grantToken(),
        onRequestId: (id) => {
          turnRequestId = id;
        },
      });
      // A turn's drain runs in the cost gate's post-turn hook, outside the measurement; this is
      // the non-turn RPC path, whose write also follows the commit. A D1 failure leaves the
      // dirty mark and the next RPC or alarm retries (D078).
      if (response.ok && path.startsWith("/rpc/conversations") && !isTurn(path)) {
        await this.#drain(request.headers.get(REQUEST_ID_HEADER) ?? "unattributed");
      }
    }
    return this.#finished(request, response, started, turnRequestId);
  }

  /**
   * Write the conversations whose D1 index row is behind, once.
   *
   * @param requestId - The correlation id of the request that triggered the drain.
   *
   * @remarks
   * Never throws: the index records its own failure and the chat response is unaffected.
   */
  async #drain(requestId: string): Promise<void> {
    const index = this.#index;
    if (index === undefined) return;
    try {
      await index.drain(requestId);
    } catch (error) {
      console.error("session index drain failed", error instanceof Error ? error.name : "unknown");
    }
  }

  /**
   * Rebuild the index from the object's metadata.
   *
   * @remarks
   * Internal only: the public trigger (ops / a GraphQL mutation) comes after the observability
   * face (D078 decision 5). The object answers a count, and a failure is a 500, never a
   * successful-looking empty rebuild.
   */
  async #reindex(request: Request): Promise<Response> {
    const path = "/rpc/reindex";
    if (request.method !== "POST") {
      return problem("method_not_allowed", "Only POST is allowed here.", path);
    }
    const index = this.#index;
    if (index === undefined) {
      return problem("unavailable", "The conversation index is not configured.", path);
    }
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? "unattributed";
    try {
      const result = await index.reindex(requestId);
      return new Response(JSON.stringify({ ok: true, ...result }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      console.error("session reindex failed", error instanceof Error ? error.name : "unknown");
      return problem("internal", "The conversation index could not be rebuilt.", path);
    }
  }

  /** Record one agent observation and remember its request for the turn's skip. */
  #recordAgent(event: AgentEvent): void {
    if (event.requestId !== undefined) this.#agentRequestIds.add(event.requestId);
    this.#append(agentEntry(event));
  }

  /**
   * Record one internal RPC's hop and return the answer unchanged.
   *
   * @remarks
   * Answers asynchronously: an abort's grants are revoked **before** the answer is handed back, so a
   * caller that reads a successful abort knows the run's capabilities are gone.
   */
  async #finished(
    request: Request,
    response: Response,
    started: number,
    turnRequestId?: string,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? "unattributed";
    // A successful turn's DO hop is the agent event (same request id), so the row is not
    // written twice. A refused turn wrote no agent event and still gets its `do.rpc` line,
    // so a trace can see that the request reached the object and stopped there.
    // A run that ended revokes the grants it held: the abort route is the one a run's end reaches
    // the object through, so a grant bound to that conversation ends as the abort returns.
    // The revocation is awaited, not fired and forgotten: the abort's answer is what tells the
    // caller the run ended, so the grants it held are gone by the time that answer is read.
    const aborted = abortedConversation(path, request.method, response.status);
    const revoked = aborted === undefined ? undefined : await this.#revokeRun(aborted);
    if (aborted !== undefined) {
      // The run ended: its relay token goes too, so a late call has nothing to relay with even
      // before the ledger's revocation is read.
      await this.#transports.get(aborted)?.closeRun();
    }
    const turn = isTurn(path);
    if (turn && response.status >= 200 && response.status < 300) {
      if (turnRequestId !== undefined && this.#agentRequestIds.delete(turnRequestId)) {
        return response;
      }
    }
    this.#append(doEntry(requestId, path, response.status, this.#now() - started, this.#now()));
    if (revoked !== undefined && revoked.failed.length > 0) {
      // The observation line names the count, not the ids: the audit row names the grant.
      this.#append({
        v: 1,
        at: isoTimestamp(new Date(this.#now()).toISOString()),
        level: "error",
        event: "http.error",
        hop: "do",
        requestId,
        path,
        detail: { code: "grant_revoke_failed", rows: revoked.failed.length },
      });
    }
    return response;
  }

  /** Append one entry; a broken log must not break the request that produced it. */
  #append(entry: Parameters<ObsStore["append"]>[0]): void {
    const obs = this.#obs;
    if (obs === undefined) return;
    try {
      obs.append(entry);
    } catch (error) {
      console.error("session obs append failed", error instanceof Error ? error.name : "unknown");
    }
  }

  /** Accept a live socket for one conversation, or return the typed refusal. */
  async #openLive(request: Request, session: AgentSession): Promise<Response> {
    const host = this.#socketHost();
    if (host === undefined) {
      return problem("unavailable", "The live face is unavailable.", new URL(request.url).pathname);
    }
    const opened = await openLiveSocket({
      request,
      host,
      pair: this.#pair,
      session,
      chat: this.#chatPort(),
      now: this.#now,
      upgradeResponse: this.#upgradeResponse,
    });
    if (!opened.ok) return opened.error;
    this.#live.set(opened.value.socket, {
      connection: opened.value.connection,
      watch: opened.value.watch,
    });
    return opened.value.response;
  }

  /**
   * The chat commands a live connection answers with.
   *
   * @returns The port over this object's own RPC, so a socket send is the same path a Worker
   * `sendMessage` takes (the turn route) and the same abort the object's abort route runs.
   *
   * @remarks
   * The port re-enters {@link Session.fetch} instead of calling the runtime directly: the turn
   * route is the one place that admits a turn through the cost gate, the policy, and the grant
   * path, and a socket send that skipped it would be a second, quietly different way to start a
   * run. The request is the object's own internal one, with a correlation id, so the hop is
   * recorded in the event log like any other.
   *
   * `clientMessageId` becomes the turn's request id. That is the whole of the deduplication on
   * this object: the conversation refuses a second input with an id it already holds, so a resend
   * after a dropped connection cannot run the turn twice.
   */
  #chatPort(): LiveSendPort {
    const rpc = async (path: string, body: ChatRequestBody): Promise<ChatRpcAnswer> => {
      const response = await this.fetch(
        new Request("https://session.internal" + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [REQUEST_ID_HEADER]: crypto.randomUUID(),
          },
          body: body === null ? null : JSON.stringify(body),
        }),
      );
      // The body is the route's own, and it is unparsed here on purpose: the caller hands it to
      // the schema of the answer it should be (`TurnAnswerSchema`), so nothing reads a shape
      // before the schema has accepted one. A body that is not JSON is no answer at all.
      return {
        status: response.status,
        answer: await response.json().catch(() => null),
      };
    };

    return {
      send: async (conversationId, text, clientMessageId) => {
        const sent = await rpc(
          "/rpc/conversations/" + encodeURIComponent(conversationId) + "/messages",
          { text, requestId: clientMessageId },
        );
        const parsed = v.safeParse(TurnAnswerSchema, sent.answer);
        if (sent.status === 200 && parsed.success) {
          return { ok: true, messageId: parsed.output.submissionId };
        }
        return refusalOf("The turn could not be started.", sent.status);
      },
      abort: async (conversationId) => {
        const sent = await rpc(
          "/rpc/conversations/" + encodeURIComponent(conversationId) + "/abort",
          null,
        );
        if (sent.status === 200) return { ok: true };
        return refusalOf("The run could not be stopped.", sent.status);
      },
    };
  }

  /** The DO socket methods, bound to the state they came from. */
  #socketHost(): LiveSocketHost | undefined {
    const accept = this.#state.acceptWebSocket;
    if (accept === undefined) return undefined;
    return {
      acceptWebSocket: (socket, tags) => {
        accept.call(this.#state, socket, tags);
      },
      getWebSockets: (tag) => this.#state.getWebSockets?.call(this.#state, tag) ?? [],
    };
  }

  /** Reattach every socket that outlived an eviction; each gets a fresh snapshot. */
  async #attachSockets(): Promise<void> {
    const sockets = this.#state.getWebSockets?.() ?? [];
    for (const socket of sockets) await this.#attachSocket(socket);
  }

  /**
   * Attach one socket from its serialized subscription, or close it when it is unusable.
   *
   * @remarks
   * A socket that outlived an eviction is the **same** socket the client opened: it is reattached
   * with the same chat port as a fresh upgrade, so a send or a stop it carries still reaches the
   * object after the wake. A connection attached without one answers every send `unavailable`,
   * which is exactly the moment a client is most likely to resend.
   */
  async #attachSocket(socket: LiveSocket): Promise<LiveEntry | undefined> {
    const existing = this.#live.get(socket);
    if (existing !== undefined) return existing;
    const session = this.#session;
    if (session === undefined) return undefined;
    const attachment = readLiveAttachment(socket);
    if (attachment === undefined) {
      socket.close?.(1008, "missing live attachment");
      return undefined;
    }
    try {
      const watch = await session.watchConversation(attachment.conversationId);
      const connection = new LiveConnection(socket, attachment.conversationId, {
        now: this.#now,
        chat: this.#chatPort(),
      });
      const entry: LiveEntry = { connection, watch };
      connection.start(watch.initial);
      watch.start((view) => {
        connection.advance(view);
      });
      this.#live.set(socket, entry);
      return entry;
    } catch {
      socket.close?.(1011, "live watch failed");
      return undefined;
    }
  }

  /**
   * Handle a message on a hibernated or live socket.
   *
   * @remarks
   * This handler is what wakes the object; after the wake it reattaches the socket from its
   * attachment before dispatching, so ping/resync work across eviction.
   */
  async webSocketMessage(socket: LiveSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.#ready;
    } catch {
      return;
    }
    const entry = await this.#attachSocket(socket);
    entry?.connection.handleMessage(message);
  }

  /** Drop the subscription when the client closes the socket. */
  async webSocketClose(socket: LiveSocket): Promise<void> {
    const entry = this.#live.get(socket);
    this.#live.delete(socket);
    if (entry === undefined) return;
    entry.connection.close();
    await entry.watch.stop();
  }

  /** Drop the subscription on a socket error. */
  async webSocketError(socket: LiveSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  /**
   * The preview row for one file, if this object may answer for it (0237, C1).
   *
   * @param path - The workspace-relative path the caller names.
   * @param workspaceVersion - The version the file has now, or undefined when the caller has none.
   * @returns The preview, or the failure that says why there is none.
   *
   * @remarks
   * **The authorisation is this object's, and it is checked before any row is read.** A path that
   * leaves the workspace is `not_authorized` and reads no row (C1); a path with no row for this
   * version is `not_found`, because it means the preview was never asked for rather than that it
   * is still running. A row is only answered for this object's own workspace: the row's key
   * carries it and the caller cannot name another.
   */
  async documentPreview(
    path: string,
    workspaceVersion: string | undefined,
  ): Promise<DocumentPreviewView | OfficeFailureView> {
    const office = this.#office;
    const authorized = officePathOf(this.#workspace, path);
    if (!authorized.ok) return authorized.failure;
    if (office === undefined) {
      return officeFailureOf("engine_unavailable", "This session has no office previews.");
    }
    const row = await office.rowOf(this.#workspace, authorized.path, workspaceVersion);
    if (row === undefined) {
      // There is no row: the preview was never asked for. The contract has no code for "nothing
      // has been asked" (its failures are failures of a job), so the read answers the state that
      // means "no preview exists yet", which a person acts on by requesting one.
      return officeFailureOf("engine_unavailable", "No preview has been requested for this file.");
    }
    return documentPreviewView(row);
  }

  /**
   * Ask for one file's preview, and answer at once (0237, C3).
   *
   * @param path - The workspace-relative path the caller names.
   * @param workspaceVersion - The version the file has now, or undefined when the caller has none.
   * @returns The row the request wrote (or reused), or the failure that says why none was written.
   *
   * @remarks
   * **The mutation does not run the job.** It asks the machine one short question and writes the
   * row; the alarm runs the conversion. The edge answers a request in ten seconds and a
   * conversion takes up to sixty, so running it here would be answered by the edge's deadline
   * instead of this face. A path outside the workspace writes nothing (C1).
   */
  async requestDocumentPreview(
    path: string,
    workspaceVersion: string | undefined,
  ): Promise<DocumentPreviewView | OfficeFailureView> {
    const office = this.#office;
    const authorized = officePathOf(this.#workspace, path);
    if (!authorized.ok) return authorized.failure;
    if (office === undefined) {
      return officeFailureOf("engine_unavailable", "This session has no office previews.");
    }
    if (workspaceVersion === undefined) {
      // Without the file's version there is no job to queue: a job names the bytes it reads, and
      // `source_changed` would be the machine's answer to a version nobody stated (INV-O2).
      return officeFailureOf("source_changed", "The file has no version to preview.");
    }
    const answer = await office.request({
      workspaceId: this.#workspace,
      path: authorized.path,
      version: workspaceVersion,
    });
    await this.#armOffice(answer.nextAlarmAt);
    return documentPreviewView(answer.row);
  }

  /**
   * The office engine this session's machine reports (0237, C5).
   *
   * @returns What the machine said, or the failure when it could not be asked.
   *
   * @remarks
   * A probe, not a job: it does not take the machine's office slot and does not change a row. Its
   * deadline is the office face's short one, so the GraphQL answer stays inside the edge's budget.
   */
  async officeEngine(): Promise<OfficeEngineView | OfficeFailureView> {
    const machine = this.#officeMachine;
    if (machine === undefined) {
      return {
        __typename: "OfficeEngineUnavailable",
        reason: "This session has no machine to ask.",
      };
    }
    const report = await probeOfficeEngine(async () => {
      const answer = await machine.machine.officeEngine?.(this.#officeCall(machine));
      if (answer?.ok !== true) return undefined;
      return answer.result;
    });
    if (report === undefined) {
      return officeFailureOf("engine_unavailable", "The machine could not be asked.");
    }
    return report.available
      ? { __typename: "OfficeEngineAvailable", id: report.id, version: report.version }
      : { __typename: "OfficeEngineUnavailable", reason: report.reason };
  }

  /**
   * Serve one office RPC the GraphQL face forwarded (0237).
   *
   * @param path - `/rpc/office/preview`, `/rpc/office/request`, or `/rpc/office/engine`.
   * @param request - The forwarded request: its query for a read, its body for a request.
   * @returns The answer the port parses, or a `not_found` problem for another path.
   *
   * @remarks
   * The edge proved a session before the port called; this object still checks the workspace it is
   * asked about against its own (the one its rows are keyed by), so a port that addressed the
   * wrong object cannot read another workspace's row. Every route answers JSON that parses as the
   * office unions; a refusal is the failure union's member, never a 500.
   */
  async #officeRpc(path: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const reply = (body: OfficeRpcBody, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    const fail = (code: OfficeErrorCodeValue, message: string, status = 200) =>
      reply(officeFailureOf(code, message), status);
    // The workspace is checked twice and both must agree with the object's own: the query names
    // it (the port and the route both send it), and the edge's header names the object the read
    // was addressed to. A request that named one workspace in one place and another in the other
    // is refused, so nothing here can be tricked into reading another object's rows.
    const workspace = url.searchParams.get("workspaceId") ?? "";
    const addressed = request.headers.get(SESSION_NAME_HEADER) ?? workspace;
    if (workspace !== this.#workspace || addressed !== this.#workspace) {
      return fail("not_authorized", "Another workspace.", 404);
    }
    if (path === "/rpc/office/preview") {
      const pathValue = url.searchParams.get("path") ?? "";
      const version = url.searchParams.get("v") ?? undefined;
      const answer = await this.documentPreview(pathValue, version);
      return reply(answer);
    }
    if (path === "/rpc/office/request") {
      const body = v.safeParse(
        v.object({ path: v.string(), version: v.optional(v.string()) }),
        await request.json().catch(() => undefined),
      );
      if (!body.success) return fail("source_changed", "The request names no file.", 400);
      return reply(await this.requestDocumentPreview(body.output.path, body.output.version));
    }
    if (path === "/rpc/office/engine") {
      return reply(await this.officeEngine());
    }
    return problem("not_found", "No office route matches this path.", path);
  }

  /**
   * Arm the alarm for one office row's next due moment (0237, C9).
   *
   * @param at - The moment the office row needs it, or undefined for none.
   *
   * @remarks
   * The alarm is the session's, so it is armed through the same storage a wake is: `min(wake,
   * office)` means an idle session with a queued preview still wakes, and an active one keeps its
   * heartbeat. Arming here never pushes the alarm later, and never clears one the session needs.
   */
  async #armOffice(at: number | undefined): Promise<void> {
    if (at === undefined) return;
    const current = await this.#state.storage.getAlarm();
    if (current !== null && current <= at) return;
    await this.#state.storage.setAlarm(at);
  }

  /**
   * Serve one preview's bytes to a session (0237, C8).
   *
   * @param request - The `GET /api/office/preview` the edge forwarded.
   * @returns The bytes streamed from the machine, or the refusal.
   *
   * @remarks
   * **Session authorisation, then the row, then the machine.** The caller is already a session (the
   * edge proved the cookie); this checks that the workspace is this object's, that the path stays
   * inside it (C1), and that the version is one this object has a `ready` row for, and only then
   * asks the machine for the artifact the row names.
   *
   * **The bytes are never collected here.** The machine's `GET /artifact` is read in ranges and
   * each range is handed on as the stream's next chunk, so a 31 MB preview crosses the Worker in
   * 8 MiB pieces and no signed URL is ever made (C8).
   */
  async previewStream(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let query: PreviewQuery;
    try {
      query = parsePreviewQuery([...url.searchParams.entries()]);
    } catch {
      return problem(
        "invalid_request",
        "The preview query is not a preview read.",
        OFFICE_PREVIEW_PATH,
      );
    }
    if (query.workspaceId !== this.#workspace) {
      return problem("not_found", "No preview exists.", OFFICE_PREVIEW_PATH);
    }
    const authorized = officePathOf(this.#workspace, query.path);
    if (!authorized.ok) {
      return problem("not_found", authorized.failure.message, OFFICE_PREVIEW_PATH);
    }
    const office = this.#office;
    const machine = this.#officeMachine;
    if (office === undefined || machine === undefined) {
      return problem("unavailable", "This session has no office previews.", OFFICE_PREVIEW_PATH);
    }
    const row = await office.rowOf(this.#workspace, authorized.path, query.version);
    if (row === undefined || row.status !== "ready" || row.bytes === null) {
      return problem("not_found", "No preview exists for this version.", OFFICE_PREVIEW_PATH);
    }
    const stream = artifactStream({
      machine: machine.machine,
      call: this.#officeCall(machine),
      key: {
        workspaceId: row.workspaceId,
        pathHash: row.pathHash,
        version: row.version,
        operation: "preview",
        paramsHash: row.paramsHash,
      },
      path: row.path,
      total: row.bytes,
      signal: request.signal,
    });
    // The length is the row's, and the stream is the machine's: a read that fails part way ends
    // the body with an error, which a client reads as a truncated transfer. The headers are
    // written before the first range is read, so a later failure can never turn into a 200 that
    // silently stopped (C8).
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": officeArtifactContentType("preview"),
        "content-length": String(row.bytes),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  /**
   * Wake the Session and re-arm the next alarm.
   *
   * @remarks
   * A heartbeat is armed before resuming, so a process that dies mid-run is woken again.
   * `resume()` is idempotent, and the post-resume arm replaces the heartbeat with the
   * scheduler's actual next wakeup (or clears it when idle).
   */
  async alarm(): Promise<void> {
    try {
      await this.#ready;
    } catch {
      return;
    }
    const session = this.#session;
    if (session === undefined || this.#closed) return;
    try {
      await armWake(this.#state.storage, { ...session.wake(), active: true }, Date.now());
      session.resume();
      // The office rows are due on the same alarm (0237, C3): one attempt each, which is what
      // turns a queued row into ready / failed / stale. It runs after the resume, so a
      // conversation's wake is never delayed by a conversion.
      const office = await this.#office?.run(this.#workspace);
      await armWake(this.#state.storage, session.wake(), Date.now(), office?.nextAlarmAt);
      // A wake is the retry point for a drain that could not reach D1 during its turn.
      await this.#drain("alarm");
    } catch (error) {
      console.error("session alarm failed", error instanceof Error ? error.name : "unknown");
      this.#state.abort("session alarm failed");
    }
  }
}
