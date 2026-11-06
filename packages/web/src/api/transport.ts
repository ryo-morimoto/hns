// HTTP mechanics: URL building and one fetch call. Paths and methods come from @hns/core's ROUTES;
// nothing here invents a URL. The typed surface (parseResponse, ApiError) lives in client.ts.
import {
  ROUTES,
  type HttpMethod,
  type JsonValue,
  type RouteKey,
  type RouteParams,
  type RouteRequest,
  type RouteResponse,
} from "@hns/core";

/** Routes that answer JSON. The SSE route belongs to 0118; the typed client must not read its body. */
export type JsonRouteKey = {
  [K in RouteKey]: RouteResponse<K> extends undefined ? never : K;
}[RouteKey];

export interface TransportResponse {
  readonly status: number;
  readonly text: string;
}

export interface HttpTransport {
  send(url: string, init: RequestInit): Promise<TransportResponse>;
}

export function createFetchTransport(fetchImpl: typeof fetch): HttpTransport {
  return {
    async send(url, init) {
      const response = await fetchImpl(url, init);
      return { status: response.status, text: await response.text() };
    },
  };
}

const PATH_PARAM = /:([A-Za-z0-9_]+)/gu;

export function buildUrl<K extends JsonRouteKey>(
  route: K,
  baseUrl: string,
  params: RouteParams<K> | undefined,
  input: RouteRequest<K> | undefined,
): string {
  const contract = ROUTES[route];
  const path = contract.path.replace(PATH_PARAM, (_match: string, name: string) => {
    return encodeURIComponent(readPathParam(route, params, name));
  });
  const query = contract.method === "GET" && input !== undefined ? toQuery(input) : "";
  return baseUrl + path + (query === "" ? "" : "?" + query);
}

export function requestInit<K extends JsonRouteKey>(
  method: HttpMethod,
  input: RouteRequest<K> | undefined,
  signal: AbortSignal | undefined,
): RequestInit {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json" },
  };
  if (signal !== undefined) init.signal = signal;
  if (method !== "GET" && input !== undefined) {
    init.headers = { accept: "application/json", "content-type": "application/json" };
    init.body = JSON.stringify(input);
  }
  return init;
}

function readPathParam<K extends JsonRouteKey>(
  route: K,
  params: RouteParams<K> | undefined,
  name: string,
): string {
  if (params === undefined) throw new Error(route + ' requires the path parameter "' + name + '"');
  // SAFETY: every params schema in ROUTES is a flat object of string ids (http-schemas.ts).
  const value = (params as Record<string, string>)[name];
  if (value === undefined) {
    throw new Error(route + ' is missing the path parameter "' + name + '"');
  }
  return value;
}

function toQuery<K extends JsonRouteKey>(input: RouteRequest<K>): string {
  const params = new URLSearchParams();
  // SAFETY: every GET request schema is a flat object of scalars (http-schemas.ts).
  const values = input as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(values)) {
    appendQuery(params, key, value);
  }
  return params.toString();
}

function appendQuery(params: URLSearchParams, key: string, value: JsonValue | undefined): void {
  // Optional route inputs may still carry an explicit undefined key at runtime.
  if (value === undefined) return;
  if (value === null) {
    params.append(key, "");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item);
    return;
  }
  // Object(value) === value is true only for objects; the query schemas hold scalars.
  if (Object(value) === value) throw new Error('query value for "' + key + '" is not a scalar');
  params.append(key, String(value));
}
