import {
  ErrorResponseSchema,
  ROUTES,
  parseResponse,
  type HttpMethod,
  type JsonValue,
  type RouteKey,
  type RouteParams,
  type RouteRequest,
  type RouteResponse,
} from "@hns/core";
import * as v from "valibot";
import { ApiError } from "./errors.ts";
import {
  buildUrl,
  createFetchTransport,
  requestInit,
  type HttpTransport,
  type JsonRouteKey,
  type TransportResponse,
} from "./transport.ts";

export interface WebClientConfig {
  /** Prefix for API paths; "" means same origin (the Vite proxy in development). */
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
}

interface RequestOptions<K extends JsonRouteKey> {
  readonly params?: RouteParams<K> | undefined;
  /** The route's body, or its query parameters for GET routes. */
  readonly input?: RouteRequest<K> | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The typed HTTP surface. Each request parses its success body with the route's schema. */
export interface WebClient {
  request<K extends JsonRouteKey>(route: K, options?: RequestOptions<K>): Promise<RouteResponse<K>>;
}

export function createWebClient(config: WebClientConfig): WebClient {
  const transport = createFetchTransport(config.fetch);
  const baseUrl = config.baseUrl.replace(/\/$/u, "");
  return {
    async request(route, options) {
      const url = buildUrl(route, baseUrl, options?.params, options?.input);
      const method = ROUTES[route].method;
      const response = await send(transport, route, url, method, options?.input, options?.signal);
      const body = readBody(response.text);

      if (response.status < 200 || response.status >= 300) {
        throw httpError(route, response.status, body);
      }
      if (!body.ok) {
        throw new ApiError({
          route,
          kind: "contract",
          status: response.status,
          message: "response body is not JSON: " + route,
          issues: ["response body is not JSON"],
        });
      }
      // An empty body fails the schema below; no route returns one on success.
      const parsed = parseResponse(route, body.value ?? null);
      if (!parsed.ok) {
        throw new ApiError({
          route,
          kind: "contract",
          status: response.status,
          message: "response does not match the contract: " + route,
          issues: parsed.error.issues,
        });
      }
      return parsed.value;
    },
  };
}

async function send<K extends JsonRouteKey>(
  transport: HttpTransport,
  route: K,
  url: string,
  method: HttpMethod,
  input: RouteRequest<K> | undefined,
  signal: AbortSignal | undefined,
): Promise<TransportResponse> {
  try {
    return await transport.send(url, requestInit(method, input, signal));
  } catch (cause) {
    // An aborted fetch rejects with a DOMException, which is not an Error in every engine.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new ApiError({
      route,
      kind: "network",
      status: null,
      message: "network request failed: " + route,
      issues: [],
      cause,
    });
  }
}

type BodyRead =
  | { readonly ok: true; readonly value: JsonValue | undefined }
  | { readonly ok: false };

function readBody(text: string): BodyRead {
  if (text === "") return { ok: true, value: undefined };
  try {
    const value: unknown = JSON.parse(text);
    // SAFETY: JSON.parse either throws or returns a JSON value; the route schema validates the shape.
    return { ok: true, value: value as JsonValue };
  } catch {
    return { ok: false };
  }
}

function httpError(route: RouteKey, status: number, body: BodyRead): ApiError {
  if (body.ok && body.value !== undefined) {
    const parsed = v.safeParse(ErrorResponseSchema, body.value);
    if (parsed.success) {
      return new ApiError({
        route,
        kind: "http",
        status,
        message: parsed.output.message,
        issues: [],
        code: parsed.output.code,
        retryAfterMs: parsed.output.retryAfterMs,
      });
    }
    return new ApiError({
      route,
      kind: "http",
      status,
      message: "HTTP " + String(status),
      issues: issueMessages(parsed.issues),
    });
  }
  return new ApiError({
    route,
    kind: "http",
    status,
    message: "HTTP " + String(status),
    issues: ["error response has no JSON body"],
  });
}

function issueMessages(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => issue.message);
}
