import { OFFICE_PREVIEW_PATH, parsePreviewQuery } from "@hns/core/office";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import { SESSION_NAME_HEADER } from "../edge/env.ts";
import type { EdgeRequest } from "../edge/handler.ts";
import { problem } from "../edge/problem.ts";

/**
 * The office preview face (0237): the edge half of `GET /api/office/preview`.
 *
 * @remarks
 * The edge owns authentication (it has already proved the session cookie before this handler,
 * D059) and the workspace binding; the Session object owns the rows, whose workspace its own name
 * is, and the machine wire. So this face reads the query, refuses a malformed read and a
 * workspace that is not a project, and forwards to the object's `/rpc/office/preview` with the
 * object's name in {@link SESSION_NAME_HEADER} — the one place a public path becomes an internal
 * one.
 *
 * **The body is never read here.** The object answers with the artifact's stream; this returns
 * it unchanged, so the bytes cross the edge as the chunks the machine sent and no layer buffers
 * them (C8). A refusal is the object's problem body, and its status.
 *
 * @param request - The authenticated request.
 * @param nameFor - The Session object name a workspace id addresses, or undefined for a project
 * this deployment does not have (the caller resolves it against D1, as `/ws` resolves its own).
 * @returns The object's answer, unchanged.
 */
/** The internal route the edge forwards a preview read to (the object's own bytes route). */
const OFFICE_PREVIEW_RPC = "/rpc/office/bytes" as const;

export function createOfficePreviewFace(): (
  request: EdgeRequest,
  nameFor: (workspaceId: string) => Promise<string | undefined>,
) => Promise<Response> {
  return async function preview(request, nameFor) {
    const url = new URL(request.request.url);
    let query;
    try {
      query = parsePreviewQuery([...url.searchParams.entries()]);
    } catch {
      return problem(
        "invalid_request",
        "The preview query is not a preview read.",
        OFFICE_PREVIEW_PATH,
      );
    }
    const name = await nameFor(query.workspaceId);
    if (name === undefined) {
      // An unknown workspace is a 404: the session may ask about any project it can name, and a
      // project this deployment does not have has no preview to serve.
      return problem("not_found", "No project has this id.", OFFICE_PREVIEW_PATH);
    }
    const sessions = request.env.SESSION;
    if (sessions === undefined) {
      return problem("unavailable", "The session binding is not configured.", OFFICE_PREVIEW_PATH);
    }
    const stub = sessions.get(sessions.idFromName(name));
    // **The bytes' own route, not the public one.** The object answers its JSON routes on
    // `/rpc/office/` and the machine's bytes on `/rpc/office/bytes`; forwarding the public path
    // here would reach whichever of the two the object checked first, and the row's JSON is not a
    // PDF (0239).
    const forwarded = new Request("https://session.internal" + OFFICE_PREVIEW_RPC + url.search, {
      method: "GET",
      headers: {
        [REQUEST_ID_HEADER]: request.requestId,
        [SESSION_NAME_HEADER]: name,
      },
      signal: request.signal,
    });
    // The answer is the object's own: a stream on success, a problem body on a refusal. Reading
    // it here would be the buffering the route exists to avoid, so it is returned as it came.
    return await stub.fetch(forwarded);
  };
}
