/** The closed set of HTTP failures the edge can return on purpose. */
export type EdgeErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "not_found"
  | "upgrade_required"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "not_implemented"
  | "unavailable"
  | "timeout"
  | "internal";

const STATUS: Record<EdgeErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  not_found: 404,
  upgrade_required: 426,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  not_implemented: 501,
  unavailable: 503,
  timeout: 504,
  internal: 500,
};

const TITLE: Record<EdgeErrorCode, string> = {
  unauthorized: "Unauthorized",
  invalid_request: "Bad Request",
  not_found: "Not Found",
  upgrade_required: "Upgrade Required",
  method_not_allowed: "Method Not Allowed",
  payload_too_large: "Payload Too Large",
  unsupported_media_type: "Unsupported Media Type",
  not_implemented: "Not Implemented",
  unavailable: "Service Unavailable",
  timeout: "Gateway Timeout",
  internal: "Internal Server Error",
};

/** The RFC 9457 body; `code` is the field callers branch on. */
interface ProblemBody {
  readonly type: "about:blank";
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: EdgeErrorCode;
}

/**
 * Build a problem response for an expected failure.
 *
 * @param code - The closed failure code; it also selects the status and title.
 * @param detail - A short, non-secret explanation for a human.
 * @param instance - The request path only; never include the query string.
 * @returns A `application/problem+json` response with `cache-control: no-store`.
 *
 * @remarks
 * The response does not include the correlation id; the edge adds `x-request-id` to every
 * response after the handler returns.
 */
export function problem(code: EdgeErrorCode, detail: string, instance: string): Response {
  const body: ProblemBody = {
    type: "about:blank",
    title: TITLE[code],
    status: STATUS[code],
    detail,
    instance,
    code,
  };
  return new Response(JSON.stringify(body), {
    status: STATUS[code],
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
