import type { D1Binding } from "@hns/store";
import { readBody } from "../edge/body.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
import { createBudget, type Budget, type BudgetReservation } from "./budget.ts";
import { credentialFor, priceFor, upstreamFor, type GatewayEnv } from "./env.ts";
import { failure } from "./failure.ts";
import { routeFor } from "./providers.ts";

/** One HTTP call to a provider; the seam tests replace so no provider is called. */
export type GatewayFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The injection points; production leaves all of them out. */
export interface GatewayDependencies {
  /** The clock the budget periods use. */
  readonly now?: (() => Date) | undefined;
  /** The HTTP client; tests replace it so no provider is called. */
  readonly fetch?: GatewayFetch | undefined;
  /** Binds the budget to a database; tests pass a fake to observe the reservation. */
  readonly budgetFor?: ((db: D1Binding) => Budget) | undefined;
}

/**
 * Build the provider gateway's fetch handler.
 *
 * @param dependencies - The clock, HTTP client, and budget seam; production passes none.
 * @returns A fetch handler with the Worker signature.
 *
 * @remarks
 * Only a fixed set of model-call routes is served (see `GATEWAY_ROUTES`); the request cannot
 * choose an upstream. The handler spends one price from the D1 budget before it calls the
 * provider and gives it back when the call fails, so a failed call costs nothing and a
 * compromised caller can only burn the budget, not read the key. Every predictable failure
 * is a closed `code` in `application/problem+json`; the provider's own error response is
 * relayed with its status so the caller sees rate limits and quotas. A stream that breaks
 * after its headers were relayed keeps its charge: the gateway no longer owns it, and the
 * provider's own hard limit is the fence for that case.
 */
export function createGateway(
  dependencies: GatewayDependencies = {},
): (request: Request, env: GatewayEnv) => Promise<Response> {
  const now = dependencies.now ?? (() => new Date());
  const fetchImpl = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const budgetFor = dependencies.budgetFor ?? createBudget;

  return async function gateway(request: Request, env: GatewayEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const route = routeFor(path);
    if (route === undefined) {
      return failure("not_found", "No model route matches this path.", path);
    }
    if (request.method !== "POST") {
      const response = failure(
        "method_not_allowed",
        "Only POST is allowed on a model route.",
        path,
      );
      response.headers.set("allow", "POST");
      return response;
    }
    const db = env.DB;
    if (db === undefined) {
      return failure("unavailable", "The budget database is not configured.", path);
    }
    const price = priceFor(env);
    if (price === undefined) {
      return failure("unavailable", "The call price is not configured.", path);
    }
    const credential = credentialFor(env, route.provider);
    if (credential === undefined) {
      return failure("unavailable", "The provider credential is not configured.", path);
    }
    let upstream: string;
    try {
      upstream = upstreamFor(env, route);
    } catch (error) {
      logName("upstream-config", error instanceof Error ? error.name : "unknown");
      return failure("unavailable", "The upstream URL is not allowed.", path);
    }
    const body = await readBody(request, DEFAULT_LIMITS.maxBodyBytes);
    if (!body.ok) {
      return body.code === "payload_too_large"
        ? failure("payload_too_large", "The request body exceeds the limit.", path)
        : failure("unsupported_media_type", "The request body must be application/json.", path);
    }
    const budget = budgetFor(db);
    let reservation: BudgetReservation;
    try {
      reservation = await budget.reserve(price, now());
    } catch (error) {
      logName("reserve", error instanceof Error ? error.name : "unknown");
      return failure("unavailable", "The budget could not be read.", path);
    }
    if (reservation !== "reserved") {
      return reservation === "stopped"
        ? failure("stopped", "The provider gateway is stopped.", path)
        : failure("budget_exceeded", "The provider budget is used up.", path);
    }
    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: "POST",
        headers: upstreamHeaders(request, credential),
        body: body.text,
        signal: request.signal,
      });
    } catch (error) {
      logName("upstream", error instanceof Error ? error.name : "unknown");
      return await refundOrUnavailable(budget, price, now(), path);
    }
    if (!response.ok) {
      return await refundOrUnavailable(budget, price, now(), path, response);
    }
    return relay(response);
  };
}

/**
 * Build the headers the provider sees.
 *
 * @internal
 * @remarks
 * An allowlist, not a copy: the caller's `authorization` and any other header stay home, so a
 * compromised harness cannot swap the key or smuggle routing headers. Only the two headers
 * the provider APIs read are relayed.
 */
function upstreamHeaders(request: Request, credential: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  const accept = request.headers.get("accept");
  if (accept !== null) headers.set("accept", accept);
  const session = request.headers.get("x-opencode-session");
  if (session !== null) headers.set("x-opencode-session", session);
  headers.set("authorization", "Bearer " + credential);
  return headers;
}

/** Relay a provider response without its headers; the body streams through unchanged. */
function relay(response: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const contentType = response.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Release a charge for a call that did not succeed.
 *
 * @internal
 * @returns The provider response relayed, or a 502 when the call threw, or a 503 when the
 * charge could not be released (the money state is unknown, so the caller must not retry
 * blindly).
 */
async function refundOrUnavailable(
  budget: Budget,
  price: number,
  at: Date,
  path: string,
  response?: Response,
): Promise<Response> {
  try {
    await budget.refund(price, at);
  } catch (error) {
    logName("refund", error instanceof Error ? error.name : "unknown");
    return failure("unavailable", "The call failed and its charge could not be released.", path);
  }
  if (response !== undefined) return relay(response);
  return failure("upstream", "The provider call failed.", path);
}

/**
 * Record the stage of a failure without its payload.
 *
 * @internal
 * @remarks
 * The name only: messages, bodies, headers, and keys never reach the log.
 */
function logName(stage: string, failureName: string): void {
  console.error("gateway: " + stage, failureName);
}
