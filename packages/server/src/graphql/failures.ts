/** The closed set of expected GraphQL failures. */
export const QUERY_FAILURE_CODES = ["invalid_argument", "limit_exceeded", "unavailable"] as const;

/** One expected failure; the client branches on it instead of reading a message. */
export type QueryFailureCode = (typeof QUERY_FAILURE_CODES)[number];

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
