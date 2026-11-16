/** The closed set of failures the gateway returns on purpose. */
export type GatewayErrorCode =
  | "not_found"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "payload_too_large"
  | "budget_exceeded"
  | "stopped"
  | "unavailable"
  | "upstream";

const STATUS: Record<GatewayErrorCode, number> = {
  not_found: 404,
  method_not_allowed: 405,
  unsupported_media_type: 415,
  payload_too_large: 413,
  budget_exceeded: 429,
  stopped: 503,
  unavailable: 503,
  upstream: 502,
};

const TITLE: Record<GatewayErrorCode, string> = {
  not_found: "Not Found",
  method_not_allowed: "Method Not Allowed",
  unsupported_media_type: "Unsupported Media Type",
  payload_too_large: "Payload Too Large",
  budget_exceeded: "Too Many Requests",
  stopped: "Service Unavailable",
  unavailable: "Service Unavailable",
  upstream: "Bad Gateway",
};

/** The RFC 9457 body; `code` is the field callers branch on. */
interface FailureBody {
  readonly type: "about:blank";
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: GatewayErrorCode;
}

/**
 * Build the gateway's failure response.
 *
 * @param code - The closed failure code; it also selects the status and title.
 * @param detail - A short explanation that never contains a key, a token, or a request body.
 * @param instance - The request path only.
 * @returns An `application/problem+json` response with `cache-control: no-store`.
 */
export function failure(code: GatewayErrorCode, detail: string, instance: string): Response {
  const body: FailureBody = {
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
