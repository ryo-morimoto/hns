import * as v from "valibot";
import type { JsonValue } from "@hns/core";
import type { Environment } from "relay-runtime";
import { createEnvironment } from "../../src/relay/environment.ts";

/** A GraphQL variable value as the request carries it. */
type VariableValue = string | number | boolean | null;

/** One request the app made, as the fixture responder sees it. */
export interface GraphQLCall {
  readonly operation: string;
  readonly variables: { readonly [name: string]: VariableValue };
}

/** Answers one request with GraphQL `data`, or undefined to fail the request. */
export type Responder = (call: GraphQLCall) => JsonValue | undefined;

const VariablesSchema = v.record(
  v.string(),
  v.union([v.string(), v.number(), v.boolean(), v.null()]),
);

const BodySchema = v.object({
  query: v.string(),
  variables: v.optional(VariablesSchema, {}),
});

const OPERATION = /\bquery\s+([A-Za-z0-9_]+)/u;

/** The operation name from a compiled query text; the compiler emits exactly one per request. */
function operationOf(query: string): string | undefined {
  return OPERATION.exec(query)?.[1];
}

/** The environment a test renders with, and the requests it saw. */
export interface TestEnvironment {
  readonly environment: Environment;
  readonly calls: GraphQLCall[];
}

/**
 * Build the environment the render tests use.
 *
 * @param respond - Returns the `data` payload for a call, or undefined to answer 500.
 * @returns The environment plus the calls it saw, so a test can count requests.
 *
 * @remarks
 * The real network and store are used; only fetch is replaced, so a test exercises the same
 * path the browser does without leaving the process.
 */
export function createTestEnvironment(respond: Responder): TestEnvironment {
  const calls: GraphQLCall[] = [];
  const environment = createEnvironment({
    fetch: (_input, init) => {
      const sent: unknown = JSON.parse(String(init?.body ?? "{}"));
      const parsed = v.safeParse(BodySchema, sent);
      if (!parsed.success) return Promise.resolve(new Response("bad body", { status: 400 }));
      const operation = operationOf(parsed.output.query);
      if (operation === undefined) {
        return Promise.resolve(new Response("no operation", { status: 400 }));
      }
      const call: GraphQLCall = { operation, variables: parsed.output.variables };
      calls.push(call);
      const payload = respond(call);
      if (payload === undefined) {
        return Promise.resolve(new Response("no fixture", { status: 500 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: payload }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
  return { environment, calls };
}
