import { failureStatus, type FailureCodeOf } from "../failures/status.ts";

/** The closed set of failures the gateway returns on purpose. */
export type GatewayErrorCode = FailureCodeOf<"gateway">;

const TITLE: Record<GatewayErrorCode, string> = {
  not_found: "Not Found",
  method_not_allowed: "Method Not Allowed",
  unsupported_media_type: "Unsupported Media Type",
  payload_too_large: "Payload Too Large",
  budget_exceeded: "Too Many Requests",
  // A stopped gateway is the operator's own 503: the budget row says so, not an outage.
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
 *
 * @remarks
 * The status comes from the server's one table (`failures/status.ts`), not from the caller.
 */
export function failure(code: GatewayErrorCode, detail: string, instance: string): Response {
  const status = failureStatus("gateway", code);
  const body: FailureBody = {
    type: "about:blank",
    title: TITLE[code],
    status,
    detail,
    instance,
    code,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
