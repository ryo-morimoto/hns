import { ConversationIdSchema, MAX_TURN_INPUT_LENGTH } from "@hns/core";
import { fromGlobalId } from "@hns/core/graphql";
import {
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfigMap,
} from "graphql";
import * as v from "valibot";
import type { GraphQLContext } from "../context.ts";
import { StoreUnavailableError } from "../../edge/store.ts";
import type { SendMessageResult as SendMessageAnswer } from "../send-message-port.ts";
import { MutationFailureType, mutationFailure, type MutationFailureView } from "./failure.ts";
import type { MutationModule } from "./index.ts";

/**
 * `sendMessage`: the Worker's one way to send a turn into a conversation (0270n).
 *
 * @remarks
 * The agent answers a conversation's turn only when something sends one; until this mutation there
 * was no Worker entry for it, so 0226's granted path never opened in a deployment (its issue says
 * so in "未実装（起動点）"). The GraphQL face is where it belongs (D059 / D077: the chat's send is
 * not a REST face).
 *
 * **The snapshot.** The Worker reads the project's active policy from D1 and puts the revision, its
 * hash, and the document in the object's send body
 * ({@link ConversationPort}); the object parses it, hash-checks it, and admits the turn under it,
 * which is what gives the run a granted path. The resolver itself never builds a snapshot: the port
 * is the one place that reads D1 for it.
 *
 * **The checks.** The conversation id is a global id of type `Conversation` — a `Project` id or a
 * raw id is `invalid_request`, so a client cannot address a project as a conversation by accident.
 * The text is the session contract's own bound (`MAX_TURN_INPUT_LENGTH`, the core model's spelling of
 * the agent's `MAX_INPUT_LENGTH`): empty or longer is
 * `invalid_request`. The caller must be a session; there is no per-conversation owner in the model,
 * so `forbidden` is not an answer here today (the port refuses an unknown conversation as
 * `not_found` before an object is addressed).
 */

/** The successful member of `sendMessage`: the turn the object recorded. */
export interface SendMessagePayloadView {
  readonly __typename: "SendMessagePayload";
  /** The submission the Session object recorded for this turn. */
  readonly submissionId: string;
  /** The settlement's status, as the session contract spells it (`unanswered`, `answered`, …). */
  readonly status: string;
}

/** The `sendMessage` union. */
export type SendMessageResult = SendMessagePayloadView | MutationFailureView;

/** The `sendMessage` arguments. */
interface SendMessageArgs {
  readonly input: {
    readonly conversationId: string;
    readonly text: string;
  };
}

/**
 * The conversation id the input names.
 *
 * @param value - The client's global id.
 * @returns The raw conversation id.
 * @throws Error when the value is not a `Conversation` global id or not a model id: the resolver
 * answers that with `invalid_request` (it is a value, not a defect).
 */
function conversationIdOf(value: string): string {
  const decoded = fromGlobalId(value);
  if (!decoded.ok || decoded.value.type !== "Conversation") {
    throw new Error("conversationId must name a Conversation.");
  }
  return v.parse(ConversationIdSchema, decoded.value.id);
}

/** The text the input carries, or the failure to answer with. */
function textOf(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_TURN_INPUT_LENGTH) return undefined;
  return value;
}

/**
 * The `sendMessage` feature.
 *
 * @returns The module that adds `sendMessage(input)` to the Mutation root.
 */
export function sendMessageModule(): MutationModule {
  return {
    name: "messages",
    fields: (): GraphQLFieldConfigMap<undefined, GraphQLContext> => {
      const payload = new GraphQLObjectType({
        name: "SendMessagePayload",
        fields: {
          submissionId: { type: new GraphQLNonNull(GraphQLString) },
          status: { type: new GraphQLNonNull(GraphQLString) },
        },
      });
      const result = new GraphQLUnionType({
        name: "SendMessageResult",
        types: [payload, MutationFailureType],
        resolveType: (value: SendMessageResult): string => value.__typename,
      });
      const input = new GraphQLInputObjectType({
        name: "SendMessageInput",
        fields: {
          /** The conversation's global id (`Conversation`), as the client's store holds it. */
          conversationId: { type: new GraphQLNonNull(GraphQLString) },
          /** The turn's text; the session contract's input bound applies. */
          text: { type: new GraphQLNonNull(GraphQLString) },
        },
      });
      return {
        sendMessage: {
          type: new GraphQLNonNull(result),
          args: { input: { type: new GraphQLNonNull(input) } },
          resolve: async (
            _source: undefined,
            args: SendMessageArgs,
            context: GraphQLContext,
          ): Promise<SendMessageResult> => {
            if (context.session.subject.length === 0) {
              return mutationFailure("forbidden", "A session is required to send a message.");
            }
            let conversationId: string;
            try {
              conversationId = conversationIdOf(args.input.conversationId);
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              return mutationFailure("invalid_request", "conversationId must name a Conversation.");
            }
            const text = textOf(args.input.text);
            if (text === undefined) {
              return mutationFailure(
                "invalid_request",
                "text must be 1-" + String(MAX_TURN_INPUT_LENGTH) + " characters.",
              );
            }
            if (!context.budget.spend(1)) {
              return mutationFailure(
                "limit_exceeded",
                "This request writes more rows than it may.",
              );
            }
            let answer: SendMessageAnswer;
            try {
              answer = await context.messages.send(
                { conversationId, text },
                context.session.subject,
              );
            } catch (error) {
              // A store or object outage is `unavailable`; a corrupt row is a defect (a 500), so it
              // is rethrown rather than rounded into a retryable refusal.
              if (error instanceof StoreUnavailableError) {
                return mutationFailure("unavailable", error.message);
              }
              throw error;
            }
            if (!answer.ok) return mutationFailure(answer.code, answer.message);
            return {
              __typename: "SendMessagePayload",
              submissionId: answer.submissionId,
              status: answer.status,
            };
          },
        },
      };
    },
  };
}
