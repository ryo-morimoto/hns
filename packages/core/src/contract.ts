// The HTTP boundary. A request or response is parsed against the route's schema before any
// handler or client trusts it (Payload validates fields; Effect decodes `unknown`; Trigger
// validates payloads). Failures are values, not exceptions.
import * as v from "valibot";
import type { JsonValue } from "./types.ts";
import { ROUTES, type RouteKey } from "./http-schemas.ts";
import { err, ok, type Result } from "./result.ts";

type SchemaOutput<TSchema> =
  TSchema extends v.GenericSchema<unknown, infer TValue> ? TValue : never;

/** The body or query the route accepts; `undefined` for routes without one. */
export type RouteRequest<K extends RouteKey> = SchemaOutput<
  NonNullable<(typeof ROUTES)[K]["request"]>
>;

/** The success body the route returns; undefined when the route streams. */
export type RouteResponse<K extends RouteKey> = SchemaOutput<
  NonNullable<(typeof ROUTES)[K]["response"]>
>;

/** The path parameters the route accepts; undefined when the path has none. */
export type RouteParams<K extends RouteKey> = SchemaOutput<
  NonNullable<(typeof ROUTES)[K]["params"]>
>;

export interface ContractError {
  readonly route: RouteKey;
  readonly kind: "request" | "params" | "response";
  readonly issues: readonly string[];
}

export function parseRequest<K extends RouteKey>(
  route: K,
  input: JsonValue,
): Result<RouteRequest<K>, ContractError> {
  const contract = ROUTES[route];
  const schema = contract.request;
  if (schema === undefined) {
    // SAFETY: RouteRequest is `undefined` exactly when the route has no request schema.
    return ok(undefined as RouteRequest<K>);
  }
  const parsed = v.safeParse(schema, input);
  if (!parsed.success) return err({ route, kind: "request", issues: issuesOf(parsed.issues) });
  // SAFETY: the schema in ROUTES[route] is the source of RouteRequest<K>.
  return ok(parsed.output as RouteRequest<K>);
}

export function parseParams<K extends RouteKey>(
  route: K,
  input: JsonValue,
): Result<RouteParams<K>, ContractError> {
  const schema = ROUTES[route].params;
  if (schema === undefined) {
    // SAFETY: RouteParams is undefined exactly when the path has no parameters.
    return ok(undefined as RouteParams<K>);
  }
  const parsed = v.safeParse(schema, input);
  if (!parsed.success) return err({ route, kind: "params", issues: issuesOf(parsed.issues) });
  // SAFETY: the schema in ROUTES[route] is the source of RouteParams<K>.
  return ok(parsed.output as RouteParams<K>);
}

export function parseResponse<K extends RouteKey>(
  route: K,
  input: JsonValue,
): Result<RouteResponse<K>, ContractError> {
  const schema = ROUTES[route].response;
  if (schema === undefined) {
    // SAFETY: RouteResponse is undefined exactly when the route streams instead of returning a body.
    return ok(undefined as RouteResponse<K>);
  }
  const parsed = v.safeParse(schema, input);
  if (!parsed.success) return err({ route, kind: "response", issues: issuesOf(parsed.issues) });
  // SAFETY: the schema in ROUTES[route] is the source of RouteResponse<K>.
  return ok(parsed.output as RouteResponse<K>);
}

function issuesOf(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join(".");
    return path === undefined ? issue.message : path + ": " + issue.message;
  });
}
