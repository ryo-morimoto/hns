import { execute, parse } from "graphql";
import { expect, test, vi } from "vitest";
import { toGlobalId } from "@hns/core/graphql";
import { MAX_TURN_INPUT_LENGTH } from "@hns/core";
import { createContext, type MessagePort } from "../context.ts";
import { buildGraphQLSchema } from "../schema.ts";
import { envWith } from "../../../test/support/edge.ts";
import { sendMessageModule } from "./send-message.ts";

/**
 * `Mutation.sendMessage` (0270n): the resolver's own checks against a port that records the call.
 *
 * @remarks
 * The production path (D1 conversation, D1 policy snapshot, a real Session object, and a machine) is
 * `test/integration/send-message.test.ts`; here the port is a fake, so what is proven is the face:
 * that a conversation is addressed by a `Conversation` global id and nothing else, that the text
 * bound is the session contract's, that a session is required, and that the resolver passes no more
 * than it checked to the port.
 */

const SEND_MESSAGE =
  "mutation Send($input: SendMessageInput!) { sendMessage(input: $input) { __typename ... on SendMessagePayload { submissionId status } ... on MutationFailure { code } } }";

const schema = buildGraphQLSchema([sendMessageModule()]);

/** One call a recording port saw. */
interface RecordedCall {
  readonly input: { readonly conversationId: string; readonly text: string };
  readonly subject: string;
}

/** A port and the calls it recorded. */
interface RecordingPort {
  readonly port: MessagePort;
  readonly calls: RecordedCall[];
}

/** A port that records what it was asked and answers the turn. */
function recordingPort(
  answer: Awaited<ReturnType<MessagePort["send"]>> = {
    ok: true,
    submissionId: "1",
    status: "unanswered",
  },
): RecordingPort {
  const calls: RecordedCall[] = [];
  return {
    calls,
    port: {
      async send(input, subject) {
        calls.push({ input, subject });
        return answer;
      },
    },
  };
}

/** Run the mutation with the given input and port. */
async function run(
  input: { readonly conversationId: string; readonly text: string },
  port: MessagePort,
  subject = "person-1",
) {
  const context = createContext({
    env: envWith(),
    requestId: "test",
    session: { subject, expiresAt: 0 },
    messages: port,
    policy: undefined,
    maxRows: 10,
    maxRowsPerList: 10,
  });
  return await execute({
    schema,
    document: parse(SEND_MESSAGE),
    contextValue: context,
    variableValues: { input },
  });
}

const CONVERSATION = toGlobalId("Conversation", "conversation-1");

// Catches: the Worker's bound and the session contract's drifting apart, so a text the agent would
// accept is refused here (or worse, one it refuses is forwarded).
test("the Worker's text bound is the session contract's", async () => {
  const { MAX_INPUT_LENGTH } = await import("@hns/agent/session");
  expect(MAX_TURN_INPUT_LENGTH).toBe(MAX_INPUT_LENGTH);
});

// The happy path: the turn reaches the port as the conversation's raw id and the exact text.
test("a conversation global id and the text reach the port", async () => {
  const { port, calls } = recordingPort();
  const result = await run({ conversationId: CONVERSATION, text: "hello" }, port);
  expect(result.errors).toBeUndefined();
  expect(result.data).toMatchObject({
    sendMessage: { __typename: "SendMessagePayload", submissionId: "1", status: "unanswered" },
  });
  expect(calls).toStrictEqual([
    { input: { conversationId: "conversation-1", text: "hello" }, subject: "person-1" },
  ]);
});

// Catches: a client addressing a project (or anything else) as a conversation, which would let a
// send name an id whose type the model does not agree with.
test("a global id of another type, or a raw id, is invalid and the port is not called", async () => {
  for (const conversationId of [
    toGlobalId("Project", "project-1"),
    "conversation-1",
    "",
    "not base64!",
  ]) {
    const { port, calls } = recordingPort();
    const result = await run({ conversationId, text: "hello" }, port);
    expect(result.data, conversationId).toMatchObject({
      sendMessage: { __typename: "MutationFailure", code: "INVALID_REQUEST" },
    });
    expect(calls, conversationId).toHaveLength(0);
  }
});

// Catches: an empty turn (which the object would refuse anyway) or one over the session contract's
// bound reaching the port; the bound is the agent's own, not a second number.
test("an empty or too long text is invalid and the port is not called", async () => {
  for (const text of ["", "x".repeat(MAX_TURN_INPUT_LENGTH + 1)]) {
    const { port, calls } = recordingPort();
    const result = await run({ conversationId: CONVERSATION, text }, port);
    expect(result.data).toMatchObject({
      sendMessage: { __typename: "MutationFailure", code: "INVALID_REQUEST" },
    });
    expect(calls).toHaveLength(0);
  }
  // The bound itself is accepted.
  const { port, calls } = recordingPort();
  await run({ conversationId: CONVERSATION, text: "x".repeat(MAX_TURN_INPUT_LENGTH) }, port);
  expect(calls).toHaveLength(1);
});

// Catches: a resolver that sends for an empty session subject, which the edge should have refused.
test("an empty session subject is forbidden and the port is not called", async () => {
  const { port, calls } = recordingPort();
  const result = await run({ conversationId: CONVERSATION, text: "hello" }, port, "");
  expect(result.data).toMatchObject({
    sendMessage: { __typename: "MutationFailure", code: "FORBIDDEN" },
  });
  expect(calls).toHaveLength(0);
});

// The port's refusals become the face's union members, one code each.
test("the port's refusal is the mutation failure a client branches on", async () => {
  const cases = [
    ["not_found", "NOT_FOUND"],
    ["invalid_request", "INVALID_REQUEST"],
    ["unavailable", "UNAVAILABLE"],
    ["limit_exceeded", "LIMIT_EXCEEDED"],
  ] as const;
  for (const [code, expected] of cases) {
    const { port } = recordingPort({ ok: false, code, message: "refused" });
    const result = await run({ conversationId: CONVERSATION, text: "hello" }, port);
    expect(result.data, code).toMatchObject({
      sendMessage: { __typename: "MutationFailure", code: expected },
    });
  }
});

// Catches: a thrown defect being rounded into a retryable refusal; it must reach the handler as a
// 500, which is what the face answers for one.
test("a defect from the port is not turned into a union failure", async () => {
  const port: MessagePort = {
    async send() {
      throw new Error("a corrupt row");
    },
  };
  const result = await run({ conversationId: CONVERSATION, text: "hello" }, port);
  expect(result.data?.sendMessage ?? null).toBeNull();
  expect(result.errors?.[0]?.message).toBe("a corrupt row");
  expect(vi.fn()).not.toHaveBeenCalled();
});
