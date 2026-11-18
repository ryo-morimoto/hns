import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { D1Binding } from "@hns/store";
import type { LiveSocket } from "../ws.ts";

/** The alarm methods the Session uses; a subset of `DurableObjectStorage`. */
export interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/**
 * The slice of `DurableObjectState` the Session uses.
 *
 * @remarks
 * Structural on purpose: the class does not extend `DurableObject`, so the runtime and the
 * tests provide this shape without a Workers type dependency.
 */
export interface SessionState {
  /**
   * The object's identity; `name` is the Session object's name (the project id).
   *
   * @remarks
   * Optional so a Node test can provide a fake state. The index records its backlog under this
   * name, one row per workspace; without it the legacy name is used.
   */
  readonly id?: { readonly name?: string | undefined } | undefined;
  readonly storage: DurableObjectSqliteStorage & AlarmStorage;
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
  abort(reason?: string): void;
  /**
   * Accept a hibernatable WebSocket and tag it with its conversation.
   *
   * @remarks
   * Optional so Node tests provide a fake without the Workers surface; the live face fails
   * closed when it is absent.
   */
  acceptWebSocket?(socket: LiveSocket, tags?: readonly string[]): void;
  /** The sockets this object accepted, including ones that outlived an eviction. */
  getWebSockets?(tag?: string): readonly LiveSocket[];
}

/**
 * The bindings the Session reads. It never reads a secret.
 *
 * @remarks
 * `DB` is the control database: the cost limit row and the per-turn ledger live there
 * (migration 3). It is optional so a Node test can open a Session without one; a deployment
 * always binds it, and then the monthly cost gate is on.
 */
export interface SessionEnv {
  readonly HNS_ENV?: string | undefined;
  readonly HNS_MODEL?: string | undefined;
  readonly DB?: D1Binding | undefined;
  /**
   * The session cookie's HMAC key, which the object derives the grant route's caller token from
   * (0224, NB7).
   *
   * @remarks
   * The Worker presents `sha256("hns.grant-rpc.v1:" + secret)` on `POST /rpc/grants`; the object
   * derives the same value, so a request that is not the Worker's is refused even if it reached the
   * object. Absent means the route refuses every request. Never logged.
   */
  readonly HNS_SESSION_SECRET?: string | undefined;
  /**
   * The control-plane Ed25519 seed (base64url, 32 bytes) grants are signed with (0224).
   *
   * @remarks
   * The **same** key the Worker signs machine requests with (0148): a grant is verified by the machine
   * with the public half it enrolled with, so there is no second key to distribute. The Session reads
   * it only to sign a grant; a missing or malformed value means no grant is issued (fail closed), not
   * a crash. Never logged.
   */
  readonly HNS_CONTROL_PLANE_KEY?: string | undefined;
  /**
   * The machine agent's origin a granted call is relayed to (0226).
   *
   * @remarks
   * The object relays a run's granted call to the machine over the control-plane signature, so it
   * needs the machine's own URL. Absent, the granted path stays closed (the agent keeps the Phase 0
   * tools): a Session that cannot relay must not pretend a machine decided a call.
   */
  readonly HNS_AGENT_URL?: string | undefined;
  /**
   * The machine's id, which every grant the object issues and every relayed call names (0226).
   *
   * @remarks
   * The machine verifies that a grant is addressed to it. Absent, the granted path stays closed.
   */
  readonly HNS_MACHINE_ID?: string | undefined;
}
