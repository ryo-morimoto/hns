import type { ConversationId, ProjectId } from "@hns/core";
import { ConversationIdSchema } from "@hns/core";
import * as v from "valibot";
import type { Store } from "@hns/store";
import { REQUEST_ID_HEADER } from "../edge/correlation.ts";
import type { WorkerEnv } from "../edge/env.ts";
import type { PolicyFace } from "./policy/face.ts";

/**
 * The Worker's send port: `sendMessage`'s production implementation (0270n).
 *
 * @remarks
 * This is the Worker's one way to put a turn into a conversation (the REST `POST` the older
 * designs had is not built; D059 / D077). It does the four things the Session object cannot do for
 * itself (D049):
 *
 * 1. **find the conversation** in the D1 index and therefore its project — the object cannot read
 *    D1, so the Worker is what says which project a conversation belongs to;
 * 2. **read the active policy** of that project from D1 (`PolicyFace.activeDocument`, which ensures
 *    revision 1 exists) and take its revision and hash from the store in the **same** request, so
 *    the snapshot's `revision` and `hash` are one revision's — 0224's grant port reads them the
 *    same way, and a send the object admits under a snapshot is what opens the granted path (0226);
 * 3. **forward** `POST /rpc/conversations/<id>/messages` to the Session object through the
 *    `SESSION` binding, with the snapshot in the body;
 * 4. **answer** the object's turn as the GraphQL union, mapping each refusal code to the one the
 *    face publishes.
 *
 * **Who may send.** The model has no per-conversation owner: a conversation names its project, and
 * a project has no `created_by`, so the check here is that a live conversation row exists and that
 * its project exists. A person with a session may therefore send to any indexed conversation of this
 * deployment — the same open authorization 0224's `requestGrant` has, and the same thing
 * `docs/contracts/auth.md` states. A missing row, a soft-deleted row, and a row whose project is
 * gone are **one** answer (`not_found`), so the face never tells a caller whether an id it does not
 * own exists. When a project gains an owner, the check belongs here, before an object is addressed.
 */

/** What one `sendMessage` call carries from GraphQL. */
export interface SendMessageRead {
  /** The conversation's raw id, already decoded from its global id. */
  readonly conversationId: string;
  /** The turn's text. */
  readonly text: string;
}

/** The successful answer: the object's turn, as the GraphQL payload. */
export interface SendMessageSuccess {
  readonly ok: true;
  /** The submission the object recorded for this turn. */
  readonly submissionId: string;
  /** The settlement's status (`unanswered` for a turn the model has not answered yet). */
  readonly status: string;
}

/** The refusal: a code the client branches on and a message a person reads. */
export interface SendMessageFailure {
  readonly ok: false;
  readonly code: "forbidden" | "invalid_request" | "limit_exceeded" | "not_found" | "unavailable";
  readonly message: string;
}

/** The port's answer. */
export type SendMessageResult = SendMessageSuccess | SendMessageFailure;

/** The send port one GraphQL request uses. */
export interface ConversationPort {
  /**
   * Send one turn into one conversation.
   *
   * @param input - The conversation and the text.
   * @param subject - The verified session's subject.
   * @returns The turn, or the typed refusal.
   *
   * @remarks
   * The object's own refusals are values: `not_found` for a conversation the object does not have,
   * `invalid_request` for a body it could not read, `limit_exceeded` when the monthly budget
   * refuses the turn, and `unavailable` when it could not be opened or the policy moved between
   * the Worker's read and the object's check (`epoch_stale`) — a retryable refusal, never a
   * silent Phase 0 turn.
   */
  send(input: SendMessageRead, subject: string): Promise<SendMessageResult>;
}

/** The shape the Session object's messages route answers with. */
const SendAnswerSchema = v.variant("ok", [
  v.object({
    ok: v.literal(true),
    submissionId: v.string(),
    status: v.string(),
    text: v.string(),
  }),
  v.object({ ok: v.literal(false), code: v.optional(v.string()), message: v.optional(v.string()) }),
]);

/** What one send needs from the Worker. */
export interface ConversationPortOptions {
  readonly env: WorkerEnv;
  readonly requestId: string;
  /** The active policy face (D1); it is what makes a snapshot possible without the object reading D1. */
  readonly policy: PolicyFace;
  /** The project lookup (D1). */
  readonly project: (projectId: ProjectId) => Promise<import("@hns/core").Project | undefined>;
  /** The store, for the conversation row and the policy's active revision and hash. */
  readonly store: () => Promise<Store>;
  /** The signal the request's deadline cancels. */
  readonly signal: AbortSignal;
}

/**
 * The refusal the object's code maps to.
 *
 * @param code - The object's closed code, or undefined for a body without one.
 * @param message - The object's message, which a person reads.
 * @returns The face's failure.
 *
 * @remarks
 * The switch is closed on the object's own answers. `limit_unavailable` (the cost gauge could not
 * be read) is answered as `limit_exceeded`: the turn did not begin because a budget could not be
 * established, and a client retries it the same way it retries a spent budget. A code this list
 * does not name is `unavailable`, never a success.
 */
function refusalOf(code: string | undefined, message: string | undefined): SendMessageFailure {
  const text = message ?? "The turn was refused.";
  switch (code) {
    case "not_found":
      return { ok: false, code: "not_found", message: text };
    case "invalid_request":
      return { ok: false, code: "invalid_request", message: text };
    case "limit_exceeded":
    case "limit_unavailable":
      return { ok: false, code: "limit_exceeded", message: text };
    default:
      return { ok: false, code: "unavailable", message: text };
  }
}

/**
 * Build the send port over one request's Worker environment.
 *
 * @param options - The environment, the policy face, the project lookup, the store, and the
 * request's signal.
 * @returns The port.
 */
export function conversationPortOver(options: ConversationPortOptions): ConversationPort {
  return {
    async send(input, _subject) {
      const conversationId = v.safeParse(ConversationIdSchema, input.conversationId);
      if (!conversationId.success) {
        return {
          ok: false,
          code: "invalid_request",
          message: "conversationId is not a conversation id.",
        };
      }
      // The conversation names its project. A row that is missing or soft-deleted is not addressed
      // at all: a send to a deleted conversation is a send to nothing, and it is the same answer
      // as a row another person owns (not_found), so the face leaks no existence.
      const conversation = await findLive(options.store, conversationId.output);
      if (conversation === undefined) {
        return { ok: false, code: "not_found", message: "No conversation has this id." };
      }
      const project = await options.project(conversation.projectId);
      if (project === undefined) {
        return { ok: false, code: "not_found", message: "No project has this id." };
      }
      const document = await options.policy.activeDocument(project.id);
      if (!document.ok) {
        return {
          ok: false,
          code: document.code === "unsupported" ? "invalid_request" : "unavailable",
          message: document.message,
        };
      }
      const active = await findActivePolicy(options.store, project.id);
      const session = options.env.SESSION;
      if (session === undefined) {
        return { ok: false, code: "unavailable", message: "The Session binding is missing." };
      }
      const stub = session.get(session.idFromName(conversation.id));
      const body = JSON.stringify({
        text: input.text,
        requestId: options.requestId,
        // The snapshot the object admits the turn under. The object parses and hash-checks it and
        // **never passes it to the model** (0226): the model must not learn the policy.
        policy: { revision: active.revision, hash: active.hash, document: document.value },
      });
      let response: Response;
      try {
        response = await stub.fetch(
          new Request(
            "https://session.internal/rpc/conversations/" +
              encodeURIComponent(conversation.id) +
              "/messages",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [REQUEST_ID_HEADER]: options.requestId,
              },
              body,
              signal: options.signal,
            },
          ),
        );
      } catch {
        return { ok: false, code: "unavailable", message: "The Session did not answer." };
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch {
        return { ok: false, code: "unavailable", message: "The Session answered with no turn." };
      }
      const parsed = v.safeParse(SendAnswerSchema, answer);
      if (!parsed.success) {
        return { ok: false, code: "unavailable", message: "The Session answered with no turn." };
      }
      if (!parsed.output.ok) return refusalOf(parsed.output.code, parsed.output.message);
      return { ok: true, submissionId: parsed.output.submissionId, status: parsed.output.status };
    },
  };
}

/**
 * The live conversation row with this id, or undefined.
 *
 * @remarks
 * The store is opened lazily and closed before the answer, so a port that also reads the policy
 * does not hold two adapters. A soft-deleted row is not live: its conversation is hidden from
 * every list and a send to it would be a send nobody can read.
 */
async function findLive(
  open: () => Promise<Store>,
  id: ConversationId,
): Promise<{ readonly id: ConversationId; readonly projectId: ProjectId } | undefined> {
  const store = await open();
  const row = await store.conversations.findById(id);
  if (row === undefined || row.deleted_at !== null) return undefined;
  return { id: row.id, projectId: row.project_id };
}

/**
 * The project's active policy revision and hash.
 *
 * @throws Error when the revision is missing after the face ensured one: that is a store defect,
 * not a refusal.
 */
async function findActivePolicy(
  open: () => Promise<Store>,
  projectId: ProjectId,
): Promise<{ readonly revision: number; readonly hash: string }> {
  const store = await open();
  const active = await store.policy.active(projectId);
  if (active === undefined) {
    throw new Error("the active policy is missing after the face ensured it");
  }
  return { revision: active.revision, hash: active.hash };
}
