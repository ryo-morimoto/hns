import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type Report, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { openSession, type AgentSession } from "@hns/agent/session";
import { problem } from "../edge/problem.ts";
import { armWake } from "./alarm.ts";
import { modelsFor } from "./models.ts";
import { handleSessionRpc } from "./session-rpc.ts";
import type { SessionEnv, SessionState } from "./state.ts";

/** The host callbacks the Session gives the runtime. */
interface SessionHooks {
  readonly onWake: (wake: Wake) => void;
  readonly onReport: (report: Report) => void;
}

/** Opens one runtime over a Durable Object state; tests substitute the storage. */
export type SessionRuntimeFactory = (
  state: SessionState,
  env: SessionEnv,
  hooks: SessionHooks,
) => Promise<AgentSession>;

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
  });
}

/**
 * One workspace's Session Durable Object.
 *
 * @remarks
 * The object owns the Harness lifecycle only: opening on SQLite, arming the recovery alarm,
 * resuming work, and forwarding internal RPC. Conversation semantics live in
 * `@hns/agent/session`. The class is plain (not a `DurableObject` subclass) so tests and
 * the Worker share one structural `SessionState`.
 */
export class Session {
  readonly #state: SessionState;
  readonly #env: SessionEnv;
  readonly #open: SessionRuntimeFactory;
  readonly #ready: Promise<void>;
  #session: AgentSession | undefined;
  #closed = false;

  constructor(
    state: SessionState,
    env: SessionEnv,
    open: SessionRuntimeFactory = openDurableSession,
  ) {
    this.#state = state;
    this.#env = env;
    this.#open = open;
    this.#ready = state.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    try {
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
      });
      this.#session = session;
      void session.closed.then((end) => {
        this.#closed = true;
        if (end.kind === "failed") this.#state.abort("harness failed");
      });
      await armWake(this.#state.storage, session.wake(), Date.now());
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
   * @returns The RPC response, 501 for `/ws`, or a problem response when the Session is not open.
   *
   * @remarks
   * The edge owns authentication. These routes are unreachable from the public Worker, so
   * they do not repeat the session check; they still parse every body before using it.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      await this.#ready;
    } catch {
      return problem(
        "unavailable",
        "The Session could not be opened.",
        new URL(request.url).pathname,
      );
    }
    const session = this.#session;
    if (session === undefined) {
      return problem("unavailable", "The Session is not open.", new URL(request.url).pathname);
    }
    const path = new URL(request.url).pathname;
    if (path === "/ws") {
      return problem("not_implemented", "The WebSocket face is not implemented yet.", path);
    }
    return handleSessionRpc(request, session);
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
