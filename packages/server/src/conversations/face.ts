import { ConversationIdSchema, type Conversation, type JsonValue } from "@hns/core";
import * as v from "valibot";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import { SESSION_NAME_HEADER } from "../edge/env.ts";
import type { EdgeRequest } from "../edge/handler.ts";
import { failureStatus } from "../failures/status.ts";
import { StoreUnavailableError, storeFor } from "../edge/store.ts";

/**
 * The closed failure codes the conversations face answers with.
 *
 * @remarks
 * `not_found` is one answer for two situations: no row, and a soft-deleted row (`0029`). The
 * caller must not be able to tell them apart, so the face never spells the difference out.
 */
const CONVERSATIONS_FAILURES = ["invalid_request", "not_found", "unavailable"] as const;

/** One failure code of the conversations face. */
type ConversationsFailure = (typeof CONVERSATIONS_FAILURES)[number];

/** `/api/conversations/<id>` and `/api/conversations/<id>/state` (0119). */
const CONVERSATION_PATH = /^\/api\/conversations\/([^/]+)(\/state)?$/u;

/** A JSON value, for the object's body: every member stays what the object said. */
const JsonValueSchema: v.GenericSchema<unknown, JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(JsonValueSchema),
    v.record(v.string(), JsonValueSchema),
  ]),
);

/**
 * A conversation id the URL may name.
 *
 * @remarks
 * The same narrow alphabet as a project id: a conversation id is a Session object's name, so a
 * URL part must not carry a separator, a space, or a NUL into it. An id outside the alphabet is
 * `400`, not `404`: it never named a conversation, and answering "not found" would hide a
 * malformed request behind an absence.
 */
const ConversationParamSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(/^[\w-]+$/u),
);

/** Where a conversation row comes from; production reads the D1 index. */
export type ConversationLookup = (
  env: EdgeRequest["env"],
  id: string,
) => Promise<Conversation | undefined>;

/**
 * The production lookup: the control database's conversation index.
 *
 * @param env - The Worker environment carrying the `DB` binding.
 * @param id - A conversation id, already parsed.
 * @returns The row, or undefined when no row has that id.
 * @throws StoreUnavailableError when the database is missing or cannot be opened.
 * @throws ValiError when a stored row is corrupt; that is a defect (500), not an outage.
 *
 * @remarks
 * The same `findById` a send uses before it addresses an object (0270n), so the two faces cannot
 * disagree about which conversation exists. A read that failed is an outage; the caller may retry.
 * The row answers whether a conversation was **created**; whether an object still holds it is a
 * different question, and only the object can answer that (the state route asks it).
 */
export async function lookupConversation(
  env: EdgeRequest["env"],
  id: string,
): Promise<Conversation | undefined> {
  const store = await storeFor(env);
  try {
    return await store.conversations.findById(v.parse(ConversationIdSchema, id));
  } catch (error) {
    if (error instanceof v.ValiError) throw error;
    throw new StoreUnavailableError("The conversation could not be read.", { cause: error });
  }
}

/** One of this face's failures; the status comes from the server's one table. */
function fail(code: ConversationsFailure, detail: string, path: string): Response {
  const status = failureStatus("edge", code);
  const body = { ok: false, code, message: detail, instance: path };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A JSON answer; the body is what the contract says it is, not a view of it. */
function json<T>(body: T): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The object's `GET /rpc/state` body, as this face reads it.
 *
 * @remarks
 * The object's members are its own; this face keeps them verbatim and adds `conversation`, so the
 * schema is an open dictionary of JSON values, not a second copy of the state's shape. A body that
 * is not a JSON object (an error page, a truncated read) is refused rather than served beside a
 * summary: the answer is a state with a conversation added, never a summary alone.
 */
const StateBodySchema: v.GenericSchema<unknown, Record<string, JsonValue>> = v.record(
  v.string(),
  JsonValueSchema,
);

/** The state a Session object answered, or why it is not one. */
type StateAnswer =
  | { readonly ok: true; readonly value: Record<string, JsonValue> }
  | { readonly ok: false };

/**
 * Parse the object's state body.
 *
 * @internal
 * @param answer - The object's response.
 * @returns The body as an object, or `undefined` when it is not JSON or not an object.
 */
async function stateOfAnswer(answer: Response): Promise<StateAnswer> {
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    return { ok: false };
  }
  const parsed = v.safeParse(StateBodySchema, body);
  return parsed.success ? { ok: true, value: parsed.output } : { ok: false };
}

/**
 * The state of the conversation's Session object, plus the conversation row (0119).
 *
 * @param request - The authenticated `/api/conversations/<id>/state` request.
 * @param conversation - The D1 row the request already read.
 * @returns The object's state with `conversation` added, or a typed failure.
 *
 * @remarks
 * The addition is **additive**: every key the object answers keeps its spelling and meaning, and a
 * caller that reads only those keys sees no change. `conversation` is the core DTO, read from D1;
 * it is always present, so a reader never has to guess whether the deployment answered.
 *
 * The object is addressed by the conversation's own id, which is the object name a send uses
 * (0270n). An object that answers `not_found` means no object holds this conversation: the row is
 * the index's **copy** (D078), and a copy with no original is not a conversation, so the answer is
 * `404` and not a state built from a row alone.
 */
async function stateOf(request: EdgeRequest, conversation: Conversation): Promise<Response> {
  const path = new URL(request.request.url).pathname;
  const session = request.env.SESSION;
  if (session === undefined) {
    return fail("unavailable", "The session binding is not configured.", path);
  }
  const url = new URL("https://session.internal/rpc/state");
  url.search = "conversation=" + encodeURIComponent(conversation.id);
  const stub = session.get(session.idFromName(conversation.id));
  let answer: Response;
  try {
    answer = await stub.fetch(
      new Request(url, {
        method: "GET",
        headers: { [REQUEST_ID_HEADER]: request.requestId, [SESSION_NAME_HEADER]: conversation.id },
        signal: request.signal,
      }),
    );
  } catch {
    return fail("unavailable", "The Session did not answer.", path);
  }
  if (answer.status === failureStatus("edge", "not_found")) {
    return fail("not_found", "No conversation has this id.", path);
  }
  if (!answer.ok) return fail("unavailable", "The Session has no state to read.", path);
  const state = await stateOfAnswer(answer);
  if (!state.ok) return fail("unavailable", "The Session answered with no state.", path);
  return json({ ...state.value, conversation });
}

/**
 * The conversation face (0119): one conversation's metadata, and its Session state beside it.
 *
 * @param lookup - Where the conversation row comes from; production reads D1.
 * @returns A handler for one authenticated edge request whose path names one conversation.
 *
 * @remarks
 * **D1 is the book.** The `conversations` row is the index a Session object writes (D078), and it
 * is what names a conversation, its project, and whether it is archived or soft-deleted; this face
 * reads that row and nothing else for the metadata. The object's own metadata is the copy that
 * reaches D1, so asking the object first would let the two disagree, and it would also make an
 * object that no longer holds the conversation a different answer from the row that says it does.
 * The object is addressed only for `/state`, after the row named it, by the id the row carries.
 *
 * **Archived is readable, deleted is not.** An archived row is `200` with `archived: true`
 * (0105 must be able to say so); a soft-deleted row and a missing row are the same `404`, so the
 * answer never reveals that a deleted conversation once existed.
 *
 * Authentication and the method are the edge's job (D059); the edge answers `401` before this
 * face runs, and a missing session binding is a `503` from `lookup`, never an empty answer.
 */
export function createConversationsFace(
  lookup: ConversationLookup,
): (request: EdgeRequest) => Promise<Response> {
  return async function conversations(request: EdgeRequest): Promise<Response> {
    const url = new URL(request.request.url);
    const path = url.pathname;
    const match = CONVERSATION_PATH.exec(path);
    if (match === null) return fail("not_found", "No route matches this path.", path);
    const raw = match[1] ?? "";
    const parsed = v.safeParse(ConversationParamSchema, raw);
    if (!parsed.success) return fail("invalid_request", "The conversation id is not an id.", path);
    let conversation: Conversation | undefined;
    try {
      conversation = await lookup(request.env, parsed.output);
    } catch (error) {
      console.error(
        "conversations: lookup failed",
        request.requestId,
        error instanceof Error ? error.name : "unknown",
      );
      return fail("unavailable", "The conversation could not be read.", path);
    }
    if (conversation === undefined || conversation.deleted_at !== null) {
      return fail("not_found", "No conversation has this id.", path);
    }
    if (match[2] === undefined) return json({ ok: true, conversation });
    return stateOf(request, conversation);
  };
}
