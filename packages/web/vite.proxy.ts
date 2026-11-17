/** The local Worker the dev server forwards to. */
export const DEFAULT_API_ORIGIN = "http://127.0.0.1:8787";

/** Strip a trailing slash so the proxy target is a bare origin. */
function originOf(apiOrigin: string): string {
  return apiOrigin.endsWith("/") ? apiOrigin.slice(0, -1) : apiOrigin;
}

/**
 * The dev proxy for the same-origin faces.
 *
 * @param apiOrigin - The local Worker origin; defaults to `HNS_API`'s default.
 * @returns Proxy entries for GraphQL, the REST API, and the WebSocket.
 *
 * @remarks
 * Development must exercise the same origin the Worker serves in production, so cookies and
 * passkey RP IDs do not need CORS or cross-origin exceptions (D094). The WebSocket entry
 * enables the upgrade through the proxy.
 */
export function proxyFor(apiOrigin: string = DEFAULT_API_ORIGIN) {
  const target = originOf(apiOrigin);
  return {
    "/graphql": { target, changeOrigin: false },
    "/api": { target, changeOrigin: false },
    "/ws": { target, changeOrigin: false, ws: true },
  };
}
