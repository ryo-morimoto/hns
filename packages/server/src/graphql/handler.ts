import * as v from "valibot";
import {
  execute,
  GraphQLError,
  Kind,
  parse,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type OperationDefinitionNode,
} from "graphql";
import type { JsonValue } from "@hns/core";
import type { GraphQLRequest } from "../edge/handler.ts";
import { DEFAULT_LIMITS, type EdgeLimits } from "../edge/limits.ts";
import { createContext, type GraphQLReads, type GraphQLWrites } from "./context.ts";
import type { PolicyFace } from "./policy/face.ts";
import {
  assertWithinBytes,
  assertWithinLimits,
  DEFAULT_GRAPHQL_LIMITS,
  GraphQLRequestLimitError,
  type GraphQLRequestLimits,
} from "./queries.ts";
import { buildGraphQLSchema } from "./schema.ts";
import type { MutationModule } from "./mutations/index.ts";

/** A request the face refused before execution. */
const REQUEST_INVALID = "GRAPHQL_REQUEST_INVALID";
/** A failure the face did not expect. */
const INTERNAL = "GRAPHQL_INTERNAL";

const RequestSchema = v.object({
  query: v.pipe(v.string(), v.minLength(1)),
  variables: v.optional(v.record(v.string(), v.unknown()), {}),
  operationName: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** A GraphQL variable value: the JSON data model, since the body is JSON. */
type Variables = { readonly [name: string]: JsonValue };

interface ParsedRequest {
  readonly query: string;
  readonly variables: Variables;
  readonly operationName?: string | undefined;
}

/** How many rows a request may read or write, and how many a list may return. */
type RowLimits = Pick<EdgeLimits, "maxRowsPerRequest" | "maxRowsPerList">;

/** What a test replaces: the reads, the mutation modules, the query limits, and the row budget. */
export interface GraphQLFaceDependencies {
  /** Replace one or more reads; production reads D1 and the Session DO. */
  readonly reads?: Partial<GraphQLReads> | undefined;
  /** Replace one or more writes; production writes D1. */
  readonly writes?: Partial<GraphQLWrites> | undefined;
  /** Replace the policy face; production builds it over the control database. */
  readonly policy?: PolicyFace | undefined;
  /** Replace the feature mutation modules; production uses the registered collection. */
  readonly mutations?: readonly MutationModule[] | undefined;
  /** The query limits; production uses {@link DEFAULT_GRAPHQL_LIMITS}. */
  readonly queryLimits?: GraphQLRequestLimits | undefined;
  /** The row budget; production uses the edge limits. */
  readonly rows?: RowLimits | undefined;
}

/** A GraphQL-shaped error envelope; no stack, no internal message. */
interface ErrorEnvelope {
  readonly errors: readonly {
    readonly message: string;
    readonly extensions: { readonly code: string };
  }[];
}

/** A JSON response; the GraphQL envelope is the body for every outcome. */
function jsonResponse(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Refuse the request with a GraphQL error envelope. */
function failure(message: string, code: string, status: number): Response {
  const envelope: ErrorEnvelope = { errors: [{ message, extensions: { code } }] };
  return jsonResponse(JSON.stringify(envelope), status);
}

/**
 * Read the JSON request.
 *
 * @internal
 * @returns The parsed request or the message to refuse it with.
 */
function parseRequest(
  body: string,
):
  | { readonly ok: true; readonly value: ParsedRequest }
  | { readonly ok: false; readonly message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, message: "The request body is not JSON." };
    }
    throw error;
  }
  const parsed = v.safeParse(RequestSchema, raw);
  if (!parsed.success) {
    return { ok: false, message: "The request must be a JSON object with a query string." };
  }
  return {
    ok: true,
    value: {
      query: parsed.output.query,
      // SAFETY: the body came from JSON.parse, so every variable is a JSON value.
      variables: parsed.output.variables as Variables,
      operationName: parsed.output.operationName,
    },
  };
}

/**
 * True when the engine refused the request itself (variable coercion, unknown operation name)
 * rather than a resolver failing.
 *
 * @internal
 * @remarks
 * `path` is the only reliable discriminator: the executor gives every field failure a path,
 * while variable coercion wraps its inner error in `originalError`, so that field is not.
 */
function isRequestError(error: GraphQLError): boolean {
  return error.path === undefined;
}

/** Every operation in the document, in declaration order. */
function operationsOf(document: DocumentNode): readonly OperationDefinitionNode[] {
  return document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
}

/** Log a failure by name only: a message may carry row data. */
function logUnexpected(requestId: string, error: Error | undefined): void {
  console.error("graphql: request failed", requestId, error?.name ?? "unknown");
}

/**
 * Build the `/graphql` handler the edge calls after authentication.
 *
 * @param dependencies - Optional replacements for tests; production uses D1, the Session DO, the
 * registered mutation modules, and the default limits.
 * @returns A handler that parses, validates, bounds, executes, and answers.
 *
 * @remarks
 * Expected read and write failures travel inside the result unions at HTTP 200. A request that
 * cannot be executed (not JSON, not GraphQL, over a limit, not a query or mutation operation) is
 * 400; a mutation document with no registered module fails validation the same way. Anything else
 * is 500 with a message that carries no row data; the correlation id is logged, never returned.
 */
export function createGraphQLFace(
  dependencies: GraphQLFaceDependencies = {},
): (request: GraphQLRequest) => Promise<Response> {
  const queryLimits = dependencies.queryLimits ?? DEFAULT_GRAPHQL_LIMITS;
  const rows = dependencies.rows ?? DEFAULT_LIMITS;
  // Built once per face; the schema is immutable after construction. The face is created once
  // per isolate in production, so this is the same cost as a module-level constant.
  const schema = buildGraphQLSchema(dependencies.mutations);

  return async function graphqlFace(request: GraphQLRequest): Promise<Response> {
    const parsed = parseRequest(request.body);
    if (!parsed.ok) return failure(parsed.message, REQUEST_INVALID, 400);

    // Bytes are bounded before parsing: a 1 MiB body would otherwise cost a 40 ms parse.
    try {
      assertWithinBytes(parsed.value.query, queryLimits);
    } catch (error) {
      if (!(error instanceof GraphQLRequestLimitError)) throw error;
      return failure(error.message, REQUEST_INVALID, 400);
    }

    let document: DocumentNode;
    try {
      document = parse(parsed.value.query);
    } catch (error) {
      const message = error instanceof GraphQLError ? error.message : "The query is not GraphQL.";
      return failure(message, REQUEST_INVALID, 400);
    }

    try {
      assertWithinLimits(parsed.value.query, document, queryLimits);
    } catch (error) {
      if (!(error instanceof GraphQLRequestLimitError)) throw error;
      return failure(error.message, REQUEST_INVALID, 400);
    }

    const operations = operationsOf(document);
    if (
      operations.length === 0 ||
      operations.some(
        (operation) => operation.operation !== "query" && operation.operation !== "mutation",
      )
    ) {
      return failure("Only query and mutation operations are supported.", REQUEST_INVALID, 400);
    }
    if (operations.length > 1 && parsed.value.operationName === undefined) {
      return failure(
        "operationName is required when the document has several operations.",
        REQUEST_INVALID,
        400,
      );
    }

    const problems = validate(schema, document);
    if (problems.length > 0) {
      return failure(problems.map((problem) => problem.message).join("; "), REQUEST_INVALID, 400);
    }

    const context = createContext({
      env: request.env,
      requestId: request.requestId,
      session: request.session,
      reads: dependencies.reads,
      writes: dependencies.writes,
      policy: dependencies.policy,
      maxRows: rows.maxRowsPerRequest,
      maxRowsPerList: rows.maxRowsPerList,
      signal: request.signal,
    });

    let result: ExecutionResult;
    try {
      result = await execute({
        schema,
        document,
        contextValue: context,
        variableValues: parsed.value.variables,
        operationName: parsed.value.operationName,
      });
    } catch (error) {
      logUnexpected(request.requestId, error instanceof Error ? error : undefined);
      return failure("Unexpected failure.", INTERNAL, 500);
    }

    if (result.data === undefined || result.data === null) {
      const failures = result.errors ?? [];
      const requestErrors = failures.filter(isRequestError);
      if (failures.length > 0 && requestErrors.length === failures.length) {
        return failure(
          requestErrors.map((error) => error.message).join("; "),
          REQUEST_INVALID,
          400,
        );
      }
      for (const error of failures) {
        if (!isRequestError(error)) logUnexpected(request.requestId, error.originalError ?? error);
      }
      return failure("Unexpected failure.", INTERNAL, 500);
    }
    return jsonResponse(JSON.stringify(result), 200);
  };
}
