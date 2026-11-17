import type { FailureCodeOf } from "../failures/status.ts";

/**
 * The closed set of expected GraphQL failures.
 *
 * @remarks
 * The codes are the server-wide spellings (`failures/status.ts`): `invalid_request` is the same
 * word REST and the machine use, and `docs/observability.md` says once what each face emits. A
 * GraphQL failure travels inside a result union of a 200 response, so no status is involved.
 */
export type QueryFailureCode = FailureCodeOf<"graphql">;

/** The type name every union member carries; the union resolves on it. */
const QUERY_FAILURE_TYPE = "QueryFailure";

/** The union member a result carries when the read could not be served. */
export interface QueryFailureView {
  readonly __typename: typeof QUERY_FAILURE_TYPE;
  readonly code: QueryFailureCode;
  readonly message: string;
}

/** Build a failure member. */
export function queryFailure(code: QueryFailureCode, message: string): QueryFailureView {
  return { __typename: QUERY_FAILURE_TYPE, code, message };
}

/**
 * An expected read failure, turned into a union member next to the resolver.
 *
 * @remarks
 * Only failures the caller can act on are raised this way. A defect in the resolver is not a
 * `QueryReadError`, so it reaches the handler and becomes a 500 instead of a quiet union.
 */
export class QueryReadError extends Error {
  readonly code: QueryFailureCode;

  constructor(code: QueryFailureCode, message: string) {
    super(message);
    this.name = "QueryReadError";
    this.code = code;
  }
}