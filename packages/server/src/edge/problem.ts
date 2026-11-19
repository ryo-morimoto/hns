import { failureStatus, type FailureCodeOf } from "../failures/status.ts";

/** The closed set of HTTP failures the edge can return on purpose. */
export type EdgeErrorCode = FailureCodeOf<"edge">;

const TITLE: Record<EdgeErrorCode, string> = {
  unauthorized: "Unauthorized",
  invalid_request: "Bad Request",
  not_found: "Not Found",
  // The row exists and is still moving (0239): the bytes are not there *yet*.
  too_early: "Too Early",
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
 * The status comes from the server's one table (`failures/status.ts`), not from the caller. The
 * response does not include the correlation id; the edge adds `x-request-id` to every response
 * after the handler returns.
 */
export function problem(code: EdgeErrorCode, detail: string, instance: string): Response {
  const status = failureStatus("edge", code);
  const body: ProblemBody = {
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
