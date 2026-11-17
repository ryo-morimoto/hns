import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type HarnessOptions } from "@earendil-works/pi-durable";
import type { AgentEvent } from "./events.ts";
import { openSession } from "./session.ts";
import type { AgentLiveView, AgentSession } from "./session.ts";

interface Fixture {
  readonly session: AgentSession;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly advance: (ms: number) => void;
}

const MODEL = { provider: "faux", modelId: "faux-1" };
const START = 1_800_000_000_000;

async function withSession(
  run: (fixture: Fixture) => Promise<void>,
  events?: AgentEvent[],
  environment?: HarnessOptions["env"],
): Promise<void> {
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
    env: environment,
    onEvent:
      events === undefined
        ? undefined
        : (event: AgentEvent) => {
            events.push(event);
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

// Catches: the project root stored but never handed to the agent, so relative paths run in the
// wrong directory.
test("a conversation's workspace root becomes the agent cwd given to env", async () => {
  const seen: (string | undefined)[] = [];
  await withSession(
    async ({ session }) => {
      const conversation = await session.createConversation({
        title: "Rooted",
        workspaceRoot: "projects/a",
      });
      await session.send(conversation.id, "hi");
    },
    undefined,
    (target) => {
      seen.push(target.cwd);
      return undefined;
    },
  );
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((cwd) => cwd === "projects/a")).toBe(true);
});

// Catches: an unknown root invented as the machine ROOT instead of leaving the cwd unset.
test("a conversation without a workspace root gets no cwd", async () => {
  const seen: (string | undefined)[] = [];
  await withSession(
    async ({ session }) => {
      const conversation = await session.createConversation({
        title: "Unrooted",
        projectId: "p1",
      });
      await session.send(conversation.id, "hi");
    },
    undefined,
    (target) => {
      seen.push(target.cwd);
      return undefined;
    },
  );
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((cwd) => cwd === undefined)).toBe(true);
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

// Catches: the agent response losing the request id the DO needs to correlate the hop.
test("a send reports the request id without making the text the log contract", async () => {
  const events: AgentEvent[] = [];
  await withSession(async ({ session, faux }) => {
    const conversation = await session.createConversation({ title: "Correlated" });
    faux.setResponses([fauxAssistantMessage("hello")]);
    await session.send(conversation.id, "hi", "corr-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "agent.response",
      requestId: "corr-1",
      text: "hello",
    });
  }, events);
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

// Catches: the live face having no source, so a connected client only sees the final answer.
test("a conversation watch delivers the first view and later revisions", async () => {
  await withSession(async ({ session, faux }) => {
    const conversation = await session.createConversation({ title: "Watch" });
    const views: AgentLiveView[] = [];
    const watch = await session.watchConversation(conversation.id);
    expect(watch.initial.conversation.title).toBe("Watch");
    expect(watch.initial.entries).toStrictEqual([]);
    expect(watch.initial.draft).toBe("");
    watch.start((view) => views.push(view));

    faux.setResponses([fauxAssistantMessage("watched answer")]);
    await session.send(conversation.id, "hi");

    await expect
      .poll(() => views.some((view) => view.entries.some((entry) => entry.kind === "pi.assistant")))
      .toBe(true);
    const final = views.findLast((view) =>
      view.entries.some((entry) => entry.kind === "pi.assistant"),
    );
    assert.ok(final !== undefined);
    expect(final.conversation.title).toBe("Watch");
    expect(final.entries.map((entry) => entry.kind)).toContain("pi.user");
    expect(final.draft).toBe("");
    await watch.stop();
  });
});

test("watching an absent conversation is not found", async () => {
  await withSession(async ({ session }) => {
    await expect(session.watchConversation("999999")).rejects.toThrow(/not found/u);
  });
});

// Catches: a watch that only sees committed entries, so the live face never gets a token delta.
test("the watch carries the in-flight draft", async () => {
  const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await openSession({
    storage: new MemoryStorage(),
    models,
    registry: createRegistry(),
    model: MODEL,
    context: BACKGROUND_CONTEXT,
    now: () => START,
    settings: { progress: { partialIntervalMs: 0 } },
  });
  try {
    const conversation = await session.createConversation({ title: "Draft" });
    const views: AgentLiveView[] = [];
    const watch = await session.watchConversation(conversation.id);
    watch.start((view) => views.push(view));
    faux.setResponses([fauxAssistantMessage("x".repeat(80))]);

    await session.send(conversation.id, "hi");

    expect(views.some((view) => view.draft.length > 0 && view.draft.length < 80)).toBe(true);
    await watch.stop();
  } finally {
    await session.close();
  }
});

// Catches: a create that never reaches the index, so a fresh conversation is missing from the list.
test("a created conversation is pending until its version is marked indexed", async () => {
  await withSession(async ({ session }) => {
    const conversation = await session.createConversation({ title: "Indexed" });
    const pending = await session.pendingIndex();
    expect(pending.entries).toHaveLength(1);
    expect(pending.remaining).toBe(0);
    expect(pending.legacy).toBe(0);
    expect(pending.entries[0]?.conversation.id).toBe(conversation.id);
    expect(pending.entries[0]?.version).toBe(conversation.created_at);

    await session.markIndexed([{ id: conversation.id, version: conversation.created_at }]);
    expect((await session.pendingIndex()).entries).toHaveLength(0);
  });
});

// Catches: a drain that clears a newer turn's dirty mark, so the index keeps the old timestamp.
test("a turn that commits during a drain is still pending afterwards", async () => {
  await withSession(async ({ session, faux, advance }) => {
    const conversation = await session.createConversation({ title: "Racing" });
    const first = await session.pendingIndex();
    const version = first.entries[0]?.version;
    assert.ok(version !== undefined);

    advance(60_000);
    faux.setResponses([fauxAssistantMessage("hello")]);
    await session.send(conversation.id, "hi");

    // The drain wrote the version it read; the turn's newer version must survive the clear.
    await session.markIndexed([{ id: conversation.id, version }]);
    const pending = await session.pendingIndex();
    expect(pending.entries).toHaveLength(1);
    expect(pending.entries[0]?.version).toBe(new Date(START + 60_000).toISOString());
  });
});

// Catches: a drain that writes every dirty row at once, so one backlog turn pays for all of them.
test("a drain returns at most the requested batch and reports the rest", async () => {
  await withSession(async ({ session }) => {
    for (let index = 0; index < 3; index += 1) {
      await session.createConversation({ title: "chat-" + String(index) });
    }
    const pending = await session.pendingIndex(1);
    expect(pending.entries).toHaveLength(1);
    expect(pending.remaining).toBe(2);
  });
});

// Catches: a rebuild that only knows the newest page of conversations.
test("indexRows returns every conversation for a rebuild", async () => {
  await withSession(async ({ session, faux }) => {
    const titles: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const conversation = await session.createConversation({ title: "chat-" + String(index) });
      titles.push(conversation.title);
      faux.setResponses([fauxAssistantMessage("ok")]);
      await session.send(conversation.id, "hi");
    }
    const rows = await session.indexRows();
    expect(rows.map((row) => row.title)).toStrictEqual(titles);
  });
});
