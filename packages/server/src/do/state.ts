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
}
