import { ConversationIdSchema, type Conversation, type JsonValue } from "@hns/core";
import * as v from "valibot";
import { readBody } from "../edge/body.ts";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import { SESSION_NAME_HEADER } from "../edge/env.ts";
import type { EdgeRequest } from "../edge/handler.ts";
import { DEFAULT_LIMITS } from "../edge/limits.ts";
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

/** `/api/conversations/<id>` and `/api/conversations/<id>/state` (0119, 0271n). */
const CONVERSATION_PATH = /^\/api\/conversations\/([^/]+)(\/state)?$/u;

/**
 * The longest title a conversation may carry.
 *
 * @remarks
 * The same bound the runtime applies when it creates a conversation (`CreateInputSchema` in
 * `@hns/agent`), so a rename can never store a title a create could not.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * A character a title may not contain: the C0 controls, the DEL, and the C1 controls.
 *
 * @remarks
 * A line break, a tab, or a NUL in a title is a rendering hazard (the list and the header draw it
 * as one line) and a sign of a caller sending something other than a name. Matching a code unit is
 * enough: none of these characters is ever part of a surrogate pair.
 */
// oxlint-disable-next-line no-control-regex -- the class is exactly the control characters.
const TITLE_CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * A title the face accepts: 1..{@link MAX_TITLE_LENGTH} code points, no control character.
 *
 * @remarks
 * The length is counted in code points, not UTF-16 units, so an emoji is one character as a person
 * sees it. The value is stored as it arrived: the face does not trim or normalise, because a title
 * the user typed is theirs.
 */
const ConversationTitleSchema = v.pipe(
  v.string(),
  v.check((value) => !TITLE_CONTROL.test(value), "The title contains a control character."),
  v.check(
    (value) => [...value].length <= MAX_TITLE_LENGTH,
    "The title is longer than " + String(MAX_TITLE_LENGTH) + " characters.",
  ),
  v.check((value) => value.length > 0, "The title is empty."),
);

/**
 * The `PATCH` body (0271n): the fields it may change, and nothing else.
 *
 * @remarks
 * `v.strictObject` is what makes an unknown key `invalid_request`: a caller that asks to change
 * `project_id` or `deleted_at` is refused rather than silently ignored, so a typo never looks like
 * a successful write. Both members are optional and only the ones present are written, so
 * `{title}` renames, `{archived: true}` archives, and `{archived: false}` is the undo.
 *
 * The object may be empty (`{}` changes nothing) but `null` is not: the body must be a JSON
 * object, so a body that is missing and a request that changed nothing stay different requests. A
 * JSON array is refused before the schema sees it (`patchOf`): `strictObject` reads one as a
 * record of its indexes and would accept it as an empty patch.
 */
const PatchBody = v.strictObject({
  title: v.optional(ConversationTitleSchema),
  archived: v.optional(v.boolean()),
});

/** What a `PATCH` asked to change; only the members present are written. */
type PatchInput = v.InferOutput<typeof PatchBody>;

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
 * (0270n). An object that answers `not_found` means **the row and the object disagree**: D1 says a
 * conversation exists and the object that should hold it does not. The row is the index's copy
 * (D078) and a copy with no original is not a conversation, so this face answers `404` `not_found`
 * rather than build a state from the row alone.
 *
 * The caller cannot tell that answer from "deleted or never existed", and it must not have to: no
 * conversation is readable here. What distinguishes the two is the operator's tools — the index's
 * own record (`index_state.last_error*` and the dirty backlog, see `docs/contracts/journal-index.md`)
 * and the object itself. The rows are repaired from the objects, not the other way round: the
 * Session object's next index drain rewrites or removes a row that disagrees, and
 * `POST /rpc/reindex` rebuilds a project's rows from its objects in one go. Until one of those runs,
 * the metadata route (`/api/conversations/<id>`) keeps serving the row, because D1 is what it reads;
 * the state route is the one that says the original is missing.
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
 * What a write answered, before it is turned into a response.
 *
 * @remarks
 * A closed union: a write either landed, or hit one of the face's own failures. Anything else it
 * throws (a `ValiError` from a corrupt row) is a defect and reaches the edge as a 500.
 */
type PatchAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ConversationsFailure; readonly detail: string };

/** The failed member of {@link PatchAnswer}, for a caller that only needs to answer. */
type PatchFailure = Extract<PatchAnswer, { readonly ok: false }>;

/**
 * The `PATCH` body, or why it is not one.
 *
 * @internal
 * @param request - The authenticated request; its body is read here, within the edge's limit.
 * @returns The parsed patch, or the failure the caller answers with.
 *
 * @remarks
 * The body is the edge's budget (`DEFAULT_LIMITS.maxBodyBytes`): the face is reached after the
 * edge has authenticated, and an oversized body is refused rather than buffered. A body that is
 * not JSON is `invalid_request`, not `unsupported_media_type`: a caller that sent JSON's content
 * type and a broken document made a bad request, and the answer says which.
 */
async function patchOf(
  request: EdgeRequest,
): Promise<{ readonly ok: true; readonly value: PatchInput } | PatchFailure> {
  const body = await readBody(request.request, DEFAULT_LIMITS.maxBodyBytes);
  if (!body.ok) {
    return {
      ok: false,
      code: "invalid_request",
      detail:
        body.code === "payload_too_large"
          ? "The request body exceeds the configured limit."
          : "The request body must be application/json.",
    };
  }
  let raw: JsonValue;
  try {
    raw = JSON.parse(body.text.length === 0 ? "null" : body.text);
  } catch {
    return { ok: false, code: "invalid_request", detail: "The body is not JSON." };
  }
  if (Array.isArray(raw)) {
    return { ok: false, code: "invalid_request", detail: "The body must be a JSON object." };
  }
  const parsed = v.safeParse(PatchBody, raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_request",
      detail:
        "The body must be {title?: 1.." +
        String(MAX_TITLE_LENGTH) +
        " chars} and/or {archived?: boolean}.",
    };
  }
  return { ok: true, value: parsed.output };
}

/**
 * Apply a patch to the conversation's D1 row (0271n).
 *
 * @internal
 * @param env - The Worker environment carrying the `DB` binding.
 * @param conversation - The row the request read.
 * @param patch - What the body asked to change.
 * @returns Ok, or the outage the write hit.
 *
 * @throws StoreUnavailableError when the database is missing or a write fails.
 *
 * @remarks
 * **Only D1 is written.** The Session object's metadata is not asked to change, so the new title
 * and the archive flag live on the row until the object writes that row again from its own
 * metadata (see {@link createConversationsFace}).
 */
async function applyPatch(
  env: EdgeRequest["env"],
  conversation: Conversation,
  patch: PatchInput,
): Promise<PatchAnswer> {
  const store = await storeFor(env);
  try {
    if (patch.title !== undefined) {
      await store.conversations.rename(conversation.project_id, conversation.id, patch.title);
    }
    if (patch.archived !== undefined) {
      await store.conversations.setArchived(
        conversation.project_id,
        conversation.id,
        patch.archived,
      );
    }
  } catch (error) {
    throw new StoreUnavailableError("The conversation could not be written.", { cause: error });
  }
  return { ok: true };
}

/**
 * Bury the conversation with a tombstone (0271n).
 *
 * @internal
 * @param env - The Worker environment carrying the `DB` binding.
 * @param conversation - The row the request read, which is not deleted yet.
 * @throws StoreUnavailableError when the database is missing or the write fails.
 *
 * @remarks
 * A logical delete, never a row removal: the object still holds the conversation, and the row says
 * what this face answers. The tombstone is what makes every later route on the path a `404`.
 */
async function bury(env: EdgeRequest["env"], conversation: Conversation): Promise<void> {
  const store = await storeFor(env);
  try {
    await store.conversations.softDelete(conversation.project_id, conversation.id);
  } catch (error) {
    throw new StoreUnavailableError("The conversation could not be deleted.", { cause: error });
  }
}

/**
 * Answer with the row a write left, read back through the production lookup.
 *
 * @internal
 * @remarks
 * The client replaces its copy with what D1 holds, not with what the request asked for, so a
 * write the store applied differently (or a row that vanished under the request) cannot be
 * reported as success.
 */
async function readBack(request: EdgeRequest, id: string, path: string): Promise<Response> {
  let updated: Conversation | undefined;
  try {
    updated = await lookupConversation(request.env, id);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) throw error;
    return fail("unavailable", "The conversation could not be read.", path);
  }
  if (updated === undefined || updated.deleted_at !== null) {
    return fail("not_found", "No conversation has this id.", path);
  }
  return json({ ok: true, conversation: updated });
}

/**
 * `PATCH /api/conversations/<id>`: rename, archive, or both, on the D1 row (0271n).
 *
 * @param request - The authenticated request, whose body is the patch.
 * @param conversation - The row the request read; it is live.
 * @param path - The request's path, for the failure envelope.
 * @returns `{ok:true, conversation}` with the row as the write left it, or a typed failure.
 *
 * @remarks
 * The body is read before the write, so a bad body costs no D1 statement. The response is the row
 * a GET would answer next.
 */
async function patchConversation(
  request: EdgeRequest,
  conversation: Conversation,
  path: string,
): Promise<Response> {
  const patch = await patchOf(request);
  if (!patch.ok) return fail(patch.code, patch.detail, path);
  let answer: PatchAnswer;
  try {
    answer = await applyPatch(request.env, conversation, patch.value);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) throw error;
    console.error(
      "conversations: patch failed",
      request.requestId,
      error instanceof Error ? error.name : "unknown",
    );
    return fail("unavailable", error.message, path);
  }
  switch (answer.ok) {
    case true:
      return readBack(request, conversation.id, path);
    case false:
      return fail(answer.code, answer.detail, path);
  }
}

/**
 * `DELETE /api/conversations/<id>`: the tombstone, and the row it left (0271n).
 *
 * @param request - The authenticated request.
 * @param conversation - The row the request read; it is live, so this delete is the first.
 * @param path - The request's path, for the failure envelope.
 * @returns `{ok:true, id, deleted_at}`, or a typed failure.
 *
 * @remarks
 * A first delete answers `200`; every delete after it is `404`, because the row is tombstoned and
 * the route refuses a tombstoned row before it reaches here. The tombstone is read back from D1 so
 * the client gets the moment the row was buried, not the moment the request arrived.
 */
async function deleteConversation(
  request: EdgeRequest,
  conversation: Conversation,
  path: string,
): Promise<Response> {
  try {
    await bury(request.env, conversation);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) throw error;
    console.error(
      "conversations: delete failed",
      request.requestId,
      error instanceof Error ? error.name : "unknown",
    );
    return fail("unavailable", error.message, path);
  }
  let deleted: Conversation | undefined;
  try {
    deleted = await lookupConversation(request.env, conversation.id);
  } catch (error) {
    if (!(error instanceof StoreUnavailableError)) throw error;
    return fail("unavailable", "The conversation could not be read.", path);
  }
  if (deleted === undefined || deleted.deleted_at === null) {
    // The write said ok and the row does not say deleted: the row moved under this request.
    return fail("unavailable", "The delete could not be confirmed.", path);
  }
  return json({ ok: true, id: conversation.id, deleted_at: deleted.deleted_at });
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
 * **Management (0271n) is the same row, one write at a time.** `PATCH` changes only the members
 * the body carries (`title`, `archived`), and `DELETE` is a tombstone (`deleted_at`), after which
 * every route on the path — GET, PATCH, and DELETE again — answers the same `404` as an id that
 * never existed: deleting twice is idempotent and still leaks nothing. The archive undo is
 * `PATCH {archived: false}`; the face has no separate undo.
 *
 * **A human's write lands on D1 only, and the object's copy wins later.** The rename, the archive
 * flag and the tombstone are written to the `conversations` row, never to the Session object's
 * metadata, so the direction of truth is still D078's Object → D1: the object does not read D1
 * (D049), and this face has no route by which a human's edit could reach it. The result is an
 * asymmetry the caller must expect. Every read this face serves comes from D1, so the answer
 * reflects the edit at once; but the object still carries the old title (and the flag it was
 * created with), and when the object writes that row from its own metadata — an index drain, or
 * `POST /rpc/reindex` — the object's copy replaces the row: the old title comes back, the archive
 * flag goes, and a drained or rebuilt tombstone becomes simply gone rather than deleted. The edit
 * lasts until the object writes that row again; making it last needs a write path into the
 * object's metadata, which this face deliberately does not have.
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
    const method = request.request.method;
    if (method === "PATCH" || method === "DELETE") {
      // `/state` is a read of the object and has no writable member: a path that names it is a
      // different route, not a longer spelling of this one.
      if (match[2] !== undefined) return fail("not_found", "No route matches this path.", path);
      return method === "PATCH"
        ? await patchConversation(request, conversation, path)
        : await deleteConversation(request, conversation, path);
    }
    if (match[2] === undefined) return json({ ok: true, conversation });
    return stateOf(request, conversation);
  };
}
