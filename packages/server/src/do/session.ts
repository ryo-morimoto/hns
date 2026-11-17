import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Report, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { AgentEvent } from "@hns/agent";
import { openSession, type AgentLiveWatch, type AgentSession } from "@hns/agent/session";
import { isoTimestamp } from "@hns/core";
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
  type LiveSocketPairFactory,
  type LiveUpgradeResponseFactory,
} from "../ws.ts";
import { LEGACY_SESSION_NAME } from "../session-name.ts";
import { grantSigner, type GrantSigner } from "../capability/signing.ts";
import { armWake } from "./alarm.ts";
import { auditEventIds, auditSink, createPolicyAudit, type PolicyAudit } from "./audit.ts";
import { createSqliteGrantRecorder, openGrantTables } from "./grant-store.ts";
import { createGrantPlane, type GrantPlane } from "./session-grants.ts";
import { grantInternalToken } from "./grant-subject.ts";
import { modelsFor } from "./models.ts";
import { SessionIndex } from "./session-index.ts";
import { handleSessionRpc } from "./session-rpc.ts";
import type { SessionEnv, SessionState } from "./state.ts";

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
) => Promise<AgentSession>;

/** The host seams the Session takes from the Workers runtime; tests inject these. */
export interface SessionDependencies {
  /** Builds the client/server pair for a WebSocket upgrade; defaults to Workers' WebSocketPair. */
  readonly webSocketPair?: LiveSocketPairFactory | undefined;
  /** The clock for delta batching; defaults to Date.now. */
  readonly now?: (() => number) | undefined;
  /** Builds the 101 response; Node tests inject a factory because its Response refuses 101. */
  readonly upgradeResponse?: LiveUpgradeResponseFactory | undefined;
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
): Promise<AgentSession> {
  const storage = await openDurableObjectSqliteStorage(state.storage, {
    prefix: "hns_session",
  });
  const { models, model } = modelsFor(env);
  const ids = auditEventIds(state.id?.name ?? LEGACY_SESSION_NAME);
  return openSession({
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
      sessionId: state.id?.name ?? LEGACY_SESSION_NAME,
      eventId: () => ids.next(),
    },
  });
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
  #obs: ObsStore | undefined;
  #audit: PolicyAudit | undefined;
  #index: SessionIndex | undefined;
  #grants: GrantPlane | undefined;
  #session: AgentSession | undefined;
  #closed = false;

  constructor(
    state: SessionState,
    env: SessionEnv,
    open: SessionRuntimeFactory = openDurableSession,
    dependencies: SessionDependencies = {},
  ) {
    this.#state = state;
    this.#env = env;
    this.#open = open;
    this.#pair = dependencies.webSocketPair ?? defaultWebSocketPair;
    this.#now = dependencies.now ?? Date.now;
    this.#upgradeResponse = dependencies.upgradeResponse ?? defaultLiveUpgradeResponse;
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
      return await grants.revokeRun(runId);
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
      // Fail closed: a tool call may not run with no way to record its decision, so a table that
      // cannot be opened stops the object here (docs/capability.md §8). It is the object's own SQLite,
      // beside the harness's prefixed tables, and not D1 (D049).
      this.#audit = createPolicyAudit(this.#state.storage);
      // Fail closed as well: a grant is a capability, and one handed out with no record of it must
      // not exist (docs/capability.md §5, §9). The tables share this object's SQLite, not D1.
      this.#grants = await this.#openGrantPlane();
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
      if (this.#env.DB !== undefined) {
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
        void this.#revokeRuns(session);
        if (end.kind === "failed") this.#state.abort("harness failed");
      });
      await armWake(this.#state.storage, session.wake(), Date.now());
      // Reattach accepted sockets before resume() so a run that starts after hibernation
      // cannot advance a view that no listener observes.
      await this.#attachSockets();
      session.resume();
    } catch (error) {
      console.error("session open failed", error instanceof Error ? error.name : "unknown");
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
    if (path === "/ws") {
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

  /** Attach one socket from its serialized subscription, or close it when it is unusable. */
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
      await armWake(this.#state.storage, session.wake(), Date.now());
      // A wake is the retry point for a drain that could not reach D1 during its turn.
      await this.#drain("alarm");
    } catch (error) {
      console.error("session alarm failed", error instanceof Error ? error.name : "unknown");
      this.#state.abort("session alarm failed");
    }
  }
}
