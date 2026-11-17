import * as v from "valibot";
import {
  EVENT_LEVELS,
  IsoTimestampSchema,
  OBS_MAX_QUERY_LIMIT,
  ObsRequestIdSchema,
  parseObsLog,
} from "@hns/core";
import { readBody } from "../edge/body.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
import { problem } from "../edge/problem.ts";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import type { ObsListQuery, ObsStore } from "./store.ts";

const LimitSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9][0-9]*$/u),
  v.transform((value) => Number(value)),
  v.integer(),
  v.minValue(1),
  v.maxValue(OBS_MAX_QUERY_LIMIT),
);

const ListQuerySchema = v.object({
  limit: v.optional(LimitSchema),
  level: v.optional(v.picklist(EVENT_LEVELS)),
  since: v.optional(IsoTimestampSchema),
  requestId: v.optional(ObsRequestIdSchema),
});

/** A JSON response with no caching. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the body is assembled from parsed domain values.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A typed failure; the instance is the internal RPC path only. */
function failure(
  request: Request,
  code: "invalid_request" | "not_found" | "method_not_allowed",
  detail: string,
): Response {
  const response = problem(code, detail, new URL(request.url).pathname);
  if (code === "method_not_allowed") response.headers.set("allow", "GET");
  return response;
}

/**
 * Read the list filters from the query string.
 *
 * @internal
 * @returns The filters, or the 400 to send.
 */
function queryOf(
  request: Request,
):
  | { readonly ok: true; readonly query: ObsListQuery }
  | { readonly ok: false; readonly response: Response } {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const key of ["limit", "level", "since", "requestId"]) {
    const value = url.searchParams.get(key);
    if (value !== null) raw[key] = value;
  }
  const parsed = v.safeParse(ListQuerySchema, raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: failure(
        request,
        "invalid_request",
        "limit, level, since, and requestId must match the observability query.",
      ),
    };
  }
  return { ok: true, query: parsed.output };
}

/** Read and parse the JSON body of an append. */
async function entryOf(
  request: Request,
): Promise<
  | { readonly ok: true; readonly entry: ReturnType<typeof parseObsLog> }
  | { readonly ok: false; readonly response: Response }
> {
  const body = await readBody(request, DEFAULT_LIMITS.maxBodyBytes);
  if (!body.ok) {
    return {
      ok: false,
      response: failure(request, "invalid_request", "The event body was refused."),
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        response: failure(request, "invalid_request", "The event body is not JSON."),
      };
    }
    throw error;
  }
  try {
    return { ok: true, entry: parseObsLog(raw) };
  } catch (error) {
    if (error instanceof v.ValiError) {
      return {
        ok: false,
        response: failure(request, "invalid_request", "The event is not the log format."),
      };
    }
    throw error;
  }
}

/**
 * Handle one internal observability request forwarded by the Worker.
 *
 * @param request - The request the edge forwarded through the SESSION binding.
 * @param store - The Session's event log.
 * @returns A JSON response; expected failures use the edge problem envelope.
 *
 * @remarks
 * Authentication happens at the edge, so these routes repeat no session check. The only
 * write is an internal HTTP event: the entry must carry the same correlation id as the
 * forwarded request, so a bug in the edge cannot file an event under another request.
 */
export async function handleObsRpc(request: Request, store: ObsStore): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/rpc/events") {
    if (request.method === "GET") {
      const parsed = queryOf(request);
      if (!parsed.ok) return parsed.response;
      return json({ ok: true, events: store.list(parsed.query) });
    }
    if (request.method === "POST") {
      const parsed = await entryOf(request);
      if (!parsed.ok) return parsed.response;
      const header = request.headers.get(REQUEST_ID_HEADER);
      if (header === null || parsed.entry.requestId !== header) {
        return failure(
          request,
          "invalid_request",
          "The event request id must match the forwarded correlation id.",
        );
      }
      store.append(parsed.entry);
      return json({ ok: true }, 201);
    }
    return failure(request, "method_not_allowed", "Only GET and POST are allowed here.");
  }
  if (path === "/rpc/metrics") {
    if (request.method !== "GET") {
      return failure(request, "method_not_allowed", "Only GET is allowed here.");
    }
    return json({ ok: true, metrics: store.metrics() });
  }
  return failure(request, "not_found", "No observability route matches this path.");
}
