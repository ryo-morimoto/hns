/**
 * The subset of the Cloudflare bindings the edge uses.
 *
 * @remarks
 * These are structural stand-ins, not a copy of the Workers API: the edge only calls
 * `fetch`, `idFromName`, and `get`. Adding `@cloudflare/workers-types` is deferred until
 * the Durable Object and WebSocket code needs the full surface.
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
  /** HMAC key for `hns_session`; at least 32 characters. Never logged. */
  readonly HNS_SESSION_SECRET?: string | undefined;
}
