import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { openSession } from "./session.ts";
import type { AgentSession } from "./session.ts";

interface Fixture {
  readonly session: AgentSession;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly advance: (ms: number) => void;
}

const MODEL = { provider: "faux", modelId: "faux-1" };
const START = 1_800_000_000_000;

async function withSession(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let clock = START;
  let request = 0;
  const session = await openSession({
    storage: new MemoryStorage(),
    models,
    registry: createRegistry(),
    model: MODEL,
    context: BACKGROUND_CONTEXT,
    now: () => clock,
    newRequestId: () => {
      request += 1;
      return "request-" + request;
    },
  });
  try {
    await run({
      session,
      faux,
      advance: (ms: number) => {
        clock += ms;
      },
    });
  } finally {
    await session.close();
  }
}

test("conversations are created, listed newest first, and fetched by id", async () => {
  await withSession(async ({ session }) => {
    const first = await session.createConversation({ title: "First" });
    const second = await session.createConversation({ title: "Second", projectId: "project-2" });

    expect(first.id).not.toBe(second.id);
    expect(second.project_id).toBe("project-2");
    expect(second.created_at).toBe(new Date(START).toISOString());

    const list = await session.listConversations();
    expect(list.map((conversation) => conversation.title)).toStrictEqual(["Second", "First"]);
    expect(list[1]?.project_id).toBe("default");

    const fetched = await session.getConversation(first.id);
    assert.ok(fetched !== undefined);
    expect(fetched.title).toBe("First");
    expect(await session.getConversation("999999")).toBeUndefined();
    expect(
      (await session.listConversations(1)).map((conversation) => conversation.title),
    ).toStrictEqual(["Second"]);
  });
});

test("an invalid conversation id is refused", async () => {
  await withSession(async ({ session }) => {
    await expect(session.getConversation("not-a-number")).rejects.toThrow(
      /invalid conversation id/u,
    );
    await expect(session.send("0", "hi")).rejects.toThrow(/invalid conversation id/u);
  });
});

test("a turn is stored in the transcript and updates the conversation timestamp", async () => {
  await withSession(async ({ session, faux, advance }) => {
    const conversation = await session.createConversation({ title: "Talk" });
    faux.setResponses([fauxAssistantMessage("hello")]);
    advance(60_000);

    const turn = await session.send(conversation.id, "hi");
    expect(turn.settlement.status).toBe("done");
    expect(turn.text).toBe("hello");

    const entries = await session.transcript(conversation.id);
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toContain("pi.user");
    expect(kinds).toContain("pi.assistant");

    const updated = await session.getConversation(conversation.id);
    assert.ok(updated !== undefined);
    expect(updated.updated_at).toBe(new Date(START + 60_000).toISOString());
  });
});

test("an empty input is refused before a submission is admitted", async () => {
  await withSession(async ({ session }) => {
    const conversation = await session.createConversation({ title: "Empty" });
    await expect(session.send(conversation.id, "")).rejects.toThrow();
    expect(await session.transcript(conversation.id)).toHaveLength(0);
  });
});

test("an absent conversation is not found for send and transcript", async () => {
  await withSession(async ({ session }) => {
    await expect(session.send("999999", "hi")).rejects.toThrow(/not found/u);
    await expect(session.transcript("999999")).rejects.toThrow(/not found/u);
    expect(await session.abort("999999")).toBe(false);
  });
});

test("abort of an idle conversation succeeds", async () => {
  await withSession(async ({ session }) => {
    const conversation = await session.createConversation({ title: "Abort" });
    expect(await session.abort(conversation.id)).toBe(true);
  });
});
