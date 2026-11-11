/** The correlation header used on every request and forwarded to downstream hops. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Printable characters only, bounded so a client cannot inject log lines or huge values. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * Use the inbound id when it is safe, otherwise generate a new one.
 *
 * @param header - The inbound `x-request-id`, or null.
 * @returns The correlation id for this request.
 *
 * @remarks
 * A valid id is reused so a caller or an upstream hop can correlate a retry. The value is
 * only for logs and tracing; it never carries authorization and is not trusted beyond the
 * character and length check.
 */
export function resolveRequestId(header: string | null): string {
  if (header !== null && REQUEST_ID.test(header)) return header;
  return crypto.randomUUID();
}

/**
 * Copy headers and add the correlation id.
 *
 * @internal
 */
export function withRequestIdHeader(headers: Headers, requestId: string): Headers {
  const next = new Headers(headers);
  next.set(REQUEST_ID_HEADER, requestId);
  return next;
}

/**
 * Add the correlation id to a response.
 *
 * @param response - The response to decorate.
 * @param requestId - The id for this request.
 * @returns A response with a mutable copy of the headers.
 *
 * @remarks
 * A 101 (WebSocket upgrade) response cannot carry extra headers; its request id travels on
 * the forwarded request instead.
 */
export function withResponseRequestId(response: Response, requestId: string): Response {
  if (response.status === 101) return response;
  const headers = withRequestIdHeader(response.headers, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
