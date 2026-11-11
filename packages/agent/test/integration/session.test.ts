import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openSession } from "../../src/session.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };
const PREFIX = "hns_session";
const ROW_LIMIT_PER_TURN = 24;
const LONG_RESPONSE = "word ".repeat(200).trim();

interface Fixture {
  readonly path: string;
  readonly models: ReturnType<typeof createModels>;
  readonly faux: ReturnType<typeof fauxProvider>;
}

async function open(path: string, fixture: Fixture) {
  const db = await openNodeSqliteDatabase(path);
  const storage = await SqliteStorage.open(db, { prefix: PREFIX });
  const session = await openSession({
    storage,
    models: fixture.models,
    registry: createRegistry(),
    model: MODEL,
    context: BACKGROUND_CONTEXT,
  });
  return { session, db };
}

async function tableCounts(
  db: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
): Promise<Map<string, number>> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const counts = new Map<string, number>();
  for (const table of tables) {
    const quoted = '"' + table.name.replaceAll('"', '""') + '"';
    const rows = await db.all<{ count: number }>("SELECT COUNT(*) AS count FROM " + quoted);
    counts.set(table.name, rows[0]?.count ?? 0);
  }
  return counts;
}

function totalRows(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "hns-session-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const fixture: Fixture = { path: join(base, "session.sqlite"), models, faux };
  try {
    await run(fixture);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// Catches: a turn that writes a row per token instead of a row per message boundary.
test("one text turn adds at most the row budget", async () => {
  await withFixture(async (fixture) => {
    const { session, db } = await open(fixture.path, fixture);
    try {
      const conversation = await session.createConversation({ title: "Budget" });
      const before = totalRows(await tableCounts(db));
      fixture.faux.setResponses([fauxAssistantMessage(LONG_RESPONSE)]);
      const turn = await session.send(conversation.id, "hi");
      expect(turn.text).toBe(LONG_RESPONSE);
      const entries = await session.transcript(conversation.id);
      expect(entries.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);
      const after = totalRows(await tableCounts(db));
      expect(after - before).toBeLessThanOrEqual(ROW_LIMIT_PER_TURN);
    } finally {
      await session.close();
    }
  });
});

test("a close and reopen restores conversations and the transcript", async () => {
  await withFixture(async (fixture) => {
    const first = await open(fixture.path, fixture);
    const conversation = await first.session.createConversation({ title: "Persisted" });
    fixture.faux.setResponses([fauxAssistantMessage("remember me")]);
    await first.session.send(conversation.id, "hello");
    await first.session.close();

    const second = await open(fixture.path, fixture);
    try {
      const list = await second.session.listConversations();
      expect(list.map((item) => item.title)).toStrictEqual(["Persisted"]);
      const entries = await second.session.transcript(conversation.id);
      expect(entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
    } finally {
      await second.session.close();
    }
  });
});
