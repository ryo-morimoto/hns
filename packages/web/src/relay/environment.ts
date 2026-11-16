import {
  Environment,
  Network,
  RecordSource,
  Store,
  type GraphQLResponse,
  type RequestParameters,
  type Variables,
} from "relay-runtime";

/** The fetch shape the network uses; tests pass a function that answers from fixtures. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** How to build the Relay environment. */
export interface EnvironmentOptions {
  /** The fetch to send through; tests inject one so no request leaves the process. */
  readonly fetch?: FetchLike | undefined;
  /** The GraphQL path; the Worker serves it. */
  readonly endpoint?: string | undefined;
}

/**
 * Create the one Relay environment the app uses.
 *
 * @param options - An optional fetch and endpoint; production uses the browser's fetch and
 * `/graphql`.
 * @returns An environment with an in-memory store and a network that posts the compiled query.
 *
 * @remarks
 * The cookie is the session: requests go same-origin with credentials, and the edge rejects an
 * anonymous caller before the face runs. A non-2xx response is a network failure, not a GraphQL
 * failure, so Relay surfaces it as an error rather than half a page.
 */
export function createEnvironment(options: EnvironmentOptions = {}): Environment {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const endpoint = options.endpoint ?? "/graphql";

  const network = Network.create(
    async (params: RequestParameters, variables: Variables): Promise<GraphQLResponse> => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ query: params.text, variables }),
      });
      if (!response.ok) {
        throw new Error("graphql request failed with " + String(response.status));
      }
      const body: unknown = await response.json();
      // SAFETY: the Worker answers with the GraphQL response envelope; relay reads `data`
      // against the compiled selection, which is the only contract either side shares.
      return body as GraphQLResponse;
    },
  );

  return new Environment({ network, store: new Store(new RecordSource()) });
}
