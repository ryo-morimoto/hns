import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

const TRIGGER = '{"type":"webhook","token":"abc123"}';
const ACTION = '{"type":"task","title":"from hook"}';

const AUTOMATION = [
  "INSERT INTO automations (id, project_id, name, trigger_json, action_json, token, enabled, created_at, updated_at)",
  "VALUES ('a1', 'default', 'hook', '" +
    TRIGGER +
    "', '" +
    ACTION +
    "', 'abc123', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');",
].join(" ");

const FIRING = [
  "INSERT INTO firings (id, automation_id, at, status, detail, run_id, created_at)",
  "VALUES ('f1', 'a1', '2026-01-01T00:00:00.000Z', 'running', NULL, NULL, '2026-01-01T00:00:00.000Z');",
].join(" ");

// Catches: a stored trigger, action, or firing that does not read back through the model.
test("a stored automation keeps its JSON trigger and action, and its firings", async () => {
  await harness.withStore(async (store) => {
    await harness.exec(AUTOMATION + " " + FIRING);
    const automation = await store.automations.get("a1");
    expect(automation?.name).toBe("hook");
    expect(automation?.enabled).toBe(true);
    expect(automation?.trigger).toStrictEqual({ type: "webhook", token: "abc123" });
    expect(automation?.action).toStrictEqual({ type: "task", title: "from hook" });
    expect((await store.automations.list()).map((row) => row.id)).toStrictEqual(["a1"]);
    expect((await store.automations.getByToken("abc123"))?.id).toBe("a1");
    expect(await store.automations.getByToken("other")).toBe(undefined);
    const firing = await store.automations.getFiring("f1");
    expect(firing?.status).toBe("running");
    expect((await store.automations.listFirings("a1")).map((row) => row.id)).toStrictEqual(["f1"]);
    expect(await store.automations.get("missing")).toBe(undefined);
  });
});

// Catches: an unknown trigger type in a stored row read back as a default instead of failing.
test("an unknown stored trigger fails loudly on read", async () => {
  await harness.withStore(async (store) => {
    await harness.exec(AUTOMATION);
    await harness.exec(
      "UPDATE automations SET trigger_json = '{\"type\":\"guess\"}' WHERE id = 'a1'",
    );
    await expect(store.automations.get("a1")).rejects.toThrow();
  });
});
