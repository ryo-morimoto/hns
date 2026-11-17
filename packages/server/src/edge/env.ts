import type { D1Binding } from "@hns/store";

/**
 * The subset of the Cloudflare bindings the edge uses.
 *
 * @remarks
 * These are structural stand-ins, not a copy of the Workers API: the edge only calls
 * `fetch`, `idFromName`, `get`, and the R2 methods the object store uses. Adding
 * `@cloudflare/workers-types` is deferred until the Durable Object and WebSocket code needs
 * the full surface.
 */
export interface AssetFetcher {
  /** Serve a static asset or a 404 from the asset layer. */
  fetch(request: Request): Promise<Response>;
}

/** The edge only receives this value and hands it back to `get`. */
export interface DurableObjectId {
  readonly name: string;
}

/** A Durable Object stub, narrowed to the one method the edge calls. */
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/** A Durable Object namespace, narrowed to the methods the edge calls. */
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** An R2 object's metadata, narrowed to the fields the object store reads. */
interface R2Object {
  readonly key: string;
  readonly size: number;
}

/** An R2 object's body, narrowed to the one method the object store calls. */
interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** How far a listing page goes; the same fields the object store passes through. */
interface R2ListOptions {
  readonly prefix?: string | undefined;
  readonly cursor?: string | undefined;
}

/** One page of an R2 listing. `cursor` is present exactly when `truncated` is true. */
interface R2Objects {
  readonly objects: readonly R2Object[];
  readonly truncated: boolean;
  readonly cursor?: string | undefined;
}

/** An R2 bucket, narrowed to the object store's put / get / head / list. */
interface R2Bucket {
  put(key: string, value: Uint8Array): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
}

/**
 * The bindings a request may read.
 *
 * @remarks
 * Every binding is optional so a missing binding can fail closed instead of crashing at
 * startup: static assets 404, `/ws` returns 503, and the session check returns 401.
 */
export interface WorkerEnv {
  readonly ASSETS?: AssetFetcher | undefined;
  readonly SESSION?: DurableObjectNamespace | undefined;
  /**
   * The per-workspace Workspace Durable Object namespace.
   *
   * @remarks
   * Address it with `idFromName(workspaceId)`, so one object owns each workspace's lease and
   * version table. Optional, like every binding, so a missing binding fails closed instead of
   * crashing the isolate.
   */
  readonly WORKSPACE?: DurableObjectNamespace | undefined;
  /**
   * The bucket that holds the workspace's git objects and checkpoint packs.
   *
   * @remarks
   * Keys are git object ids under `objects/`, and each checkpoint is one pack under
   * `checkpoints/`. Optional, like every binding, so a missing bucket fails closed at the
   * face that needs it instead of crashing the isolate. The structural shape matches
   * `@hns/workspace`'s `ObjectBucket`.
   */
  readonly OBJECTS?: R2Bucket | undefined;
  /**
   * The control database: projects, tasks, and the conversation index.
   *
   * @remarks
   * Optional so a missing binding fails closed at the face (503) instead of crashing the
   * isolate at startup. Faces open it through `openStore`; they never query D1 directly.
   */
  readonly DB?: D1Binding | undefined;
  /** HMAC key for `hns_session`; at least 32 characters. Never logged. */
  readonly HNS_SESSION_SECRET?: string | undefined;
  /**
   * The machine agent's origin; the Workspace object calls it through the tunnel.
   *
   * @remarks
   * Declared here because it is the same environment the Durable Objects are constructed with.
   * The edge itself does not call the machine; `Workspace` reads this through its own bindings
   * type. Absent means the file faces fail closed (503).
   */
  readonly HNS_AGENT_URL?: string | undefined;
  /**
   * The control-plane Ed25519 seed (base64url) the Workspace signs machine requests with.
   *
   * @remarks
   * A Worker secret (D100). The machine verifies with the enrolled public half; never log it.
   * 0148 supplies the enrollment and rotation.
   */
  readonly HNS_CONTROL_PLANE_KEY?: string | undefined;
}
