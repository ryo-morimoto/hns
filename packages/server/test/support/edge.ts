import type { D1Binding } from "@hns/store";
import type {
  AssetFetcher,
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectStub,
  WorkerEnv,
} from "../../src/edge/env.ts";
import { signSession } from "../../src/edge/session.ts";

/** A secret long enough for the edge; never a real key. */
export const TEST_SECRET = "test-secret-0123456789abcdef0123456789";

/** Sign a session and return a full Cookie header value. */
export async function sessionCookie(
  subject = "owner",
  expiresAt: number = Date.now() + 60_000,
  secret: string = TEST_SECRET,
): Promise<string> {
  return "hns_session=" + (await signSession(secret, { subject, expiresAt }));
}

/**
 * Sign an arbitrary payload.
 *
 * @remarks
 * Used only to prove that a correctly signed but invalid payload is still rejected. The
 * production signer cannot produce these.
 */
export async function signRawPayload(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const payloadPart = base64Url(encoder.encode(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart));
  return payloadPart + "." + base64Url(new Uint8Array(signature));
}

/** Base64url without padding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** A static asset fetcher and the requests it saw. */
export interface AssetRecorder {
  readonly fetcher: AssetFetcher;
  readonly requests: Request[];
}

/** A Session namespace fake and the requests it saw. */
export interface SessionRecorder {
  readonly namespace: DurableObjectNamespace;
  readonly ids: string[];
  readonly requests: Request[];
}

/** A static asset fetcher that records requests and returns one response. */
export function assetsWith(
  response: Response = new Response("ok", { status: 200 }),
): AssetRecorder {
  const requests: Request[] = [];
  return {
    requests,
    fetcher: {
      fetch(request: Request): Promise<Response> {
        requests.push(request);
        return Promise.resolve(response);
      },
    },
  };
}

/** A Session namespace fake that records the id and the forwarded request. */
export function sessionWith(
  response: Response = new Response("not wired", { status: 501 }),
): SessionRecorder {
  const ids: string[] = [];
  const requests: Request[] = [];
  const stub: DurableObjectStub = {
    fetch(request: Request): Promise<Response> {
      requests.push(request);
      return Promise.resolve(response);
    },
  };
  const namespace: DurableObjectNamespace = {
    idFromName(name: string): DurableObjectId {
      ids.push(name);
      return { name };
    },
    get(): DurableObjectStub {
      return stub;
    },
  };
  return { namespace, ids, requests };
}

/** The statement shape the store reads; the binding below keeps it deliberately empty. */
interface FakeStatement {
  bind(...values: readonly (string | number | null)[]): FakeStatement;
  all(): Promise<{ readonly results: readonly string[] }>;
  first(): Promise<null>;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
}

/** A D1 binding that answers every statement with no rows and no changes. */
export function d1With(): D1Binding {
  const statement: FakeStatement = {
    bind: () => statement,
    all: () => Promise.resolve({ results: [] }),
    first: () => Promise.resolve(null),
    run: () => Promise.resolve({ meta: { changes: 0 } }),
  };
  return {
    prepare: () => statement,
    batch: () => Promise.resolve([]),
  };
}

/** Build an env; pass an empty secret to exercise the fail-closed branch. */
export function envWith(
  options: {
    readonly assets?: AssetFetcher;
    readonly session?: DurableObjectNamespace;
    readonly db?: D1Binding;
    readonly secret?: string;
  } = {},
): WorkerEnv {
  return {
    ASSETS: options.assets,
    SESSION: options.session,
    DB: options.db,
    HNS_SESSION_SECRET: options.secret ?? TEST_SECRET,
  };
}
