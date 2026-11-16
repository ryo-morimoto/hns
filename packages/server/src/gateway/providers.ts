/**
 * The fields a model-call route declares.
 *
 * @internal
 * @remarks
 * The table below is the whole request surface. A caller cannot choose a host or a URL: the
 * path selects one entry, and the harness holds neither the provider URL nor the key. Adding
 * a provider or an API family means adding an entry, not widening the parse of a request.
 * `credential` and `upstreamVariable` are binding names: the deploy config declares them from
 * this table, and the worker reads them from the environment.
 */
interface GatewayRouteContract {
  /** The pi-ai provider id this route serves. */
  readonly provider: string;
  /** The exact path the gateway answers; the query string is not forwarded. */
  readonly path: string;
  /** The provider endpoint used when the deployment does not override it. */
  readonly upstream: string;
  /** The binding that overrides {@link GatewayRouteContract.upstream} (staging, local, tests). */
  readonly upstreamVariable: string;
  /** The secret binding holding this provider's key. */
  readonly credential: string;
}

/**
 * The model-call routes the gateway forwards.
 *
 * @remarks
 * Both current providers speak the OpenAI completions API, so one suffix per provider is
 * enough. The URL is operator configuration (env), never request data.
 */
export const GATEWAY_ROUTES = [
  {
    provider: "ollama-cloud",
    path: "/v1/ollama-cloud/chat/completions",
    upstream: "https://ollama.com/v1/chat/completions",
    upstreamVariable: "HNS_GATEWAY_OLLAMA_CLOUD_URL",
    credential: "OLLAMA_CLOUD_API_KEY",
  },
  {
    provider: "opencode-go",
    path: "/v1/opencode-go/chat/completions",
    upstream: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    upstreamVariable: "HNS_GATEWAY_OPENCODE_GO_URL",
    credential: "OPENCODE_GO_API_KEY",
  },
] as const satisfies readonly GatewayRouteContract[];

/** One entry of {@link GATEWAY_ROUTES}; its provider is a literal, so switches can be exhaustive. */
export type GatewayRoute = (typeof GATEWAY_ROUTES)[number];

/** The providers the gateway serves; derived so the table stays the source of truth. */
export type GatewayProvider = GatewayRoute["provider"];

/**
 * Find the route for a path.
 *
 * @param path - The request path, without the query string.
 * @returns The matching route, or undefined when no model-call route has that path.
 */
export function routeFor(path: string): GatewayRoute | undefined {
  return GATEWAY_ROUTES.find((route) => route.path === path);
}
