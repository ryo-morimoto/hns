import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Report, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { AgentEvent } from "@hns/agent";
import { openSession, type AgentLiveWatch, type AgentSession } from "@hns/agent/session";
import { migrateStore } from "@hns/store";
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
import { armWake } from "./alarm.ts";
import { modelsFor } from "./models.ts";
import { handleSessionRpc } from "./session-rpc.ts";
import type { SessionEnv, SessionState } from "./state.ts";

/** The host callbacks the Session gives the runtime. */
interface SessionHooks {
  readonly onWake: (wake: Wake) => void;
  readonly onReport: (report: Report) => void;
  readonly onEvent: (event: AgentEvent) => void;
}

/** Opens one runtime over a Durable Object state; tests substitute the storage. */
export type SessionRuntimeFactory = (
  state: SessionState,
  env: SessionEnv,
  hooks: SessionHooks,
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

/** One accepted live socket and what keeps it fed. */
interface LiveEntry {
  readonly connection: LiveConnection;
  readonly watch: AgentLiveWatch;
}

/**
 * Open the production runtime: pi-durable on the object's SQLite storage.
 *
 * @internal
 */
async function openDurableSession(
  state: SessionState,
  env: SessionEnv,
  hooks: SessionHooks,
): Promise<AgentSession> {
  const storage = await openDurableObjectSqliteStorage(state.storage, {
    prefix: "hns_session",
  });
  const { models, model } = modelsFor(env);
  return openSession({
    storage,
    models,
    registry: createRegistry(),
    model,
    context: BACKGROUND_CONTEXT,
    onWake: hooks.onWake,
    onReport: hooks.onReport,
    onEvent: hooks.onEvent,
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

  async #initialize(): Promise<void> {
    try {
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
        });
      }
      const session = await this.#open(this.#state, this.#env, {
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
      });
      this.#session = session;
      void session.closed.then((end) => {
        this.#closed = true;
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
    } else {
      response = await handleSessionRpc(request, session, {
        cost: this.#cost,
        onRequestId: (id) => {
          turnRequestId = id;
        },
      });
    }
    return this.#finished(request, response, started, turnRequestId);
  }

  /** Record one agent observation and remember its request for the turn's skip. */
  #recordAgent(event: AgentEvent): void {
    if (event.requestId !== undefined) this.#agentRequestIds.add(event.requestId);
    this.#append(agentEntry(event));
  }

  /** Record one internal RPC's hop and return the answer unchanged. */
  #finished(
    request: Request,
    response: Response,
    started: number,
    turnRequestId?: string,
  ): Response {
    const path = new URL(request.url).pathname;
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? "unattributed";
    // A successful turn's DO hop is the agent event (same request id), so the row is not
    // written twice. A refused turn wrote no agent event and still gets its `do.rpc` line,
    // so a trace can see that the request reached the object and stopped there.
    const turn = path.startsWith("/rpc/conversations/") && path.endsWith("/messages");
    if (turn && response.status >= 200 && response.status < 300) {
      if (turnRequestId !== undefined && this.#agentRequestIds.delete(turnRequestId)) {
        return response;
      }
    }
    this.#append(doEntry(requestId, path, response.status, this.#now() - started, this.#now()));
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
    } catch (error) {
      console.error("session alarm failed", error instanceof Error ? error.name : "unknown");
      this.#state.abort("session alarm failed");
    }
  }
}
