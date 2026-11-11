import { isoTimestamp } from "@hns/core";
import type { IsoTimestamp } from "@hns/core";
import { expect, test } from "vitest";
import { withStore } from "../test/support.ts";

test("automations keep JSON triggers and firings", () => {
  withStore((store) => {
    const project = store.projects.ensureDefault();
    const automation = store.automations.create({
      projectId: project.id,
      name: "hook",
      trigger: { type: "webhook" },
      action: { type: "task", title: "from hook" },
    });
    expect(automation.enabled).toBe(true);
    expect(automation.trigger.type).toBe("webhook");
    if (automation.trigger.type !== "webhook") throw new Error("webhook expected");
    const token = automation.trigger.token;
    if (token === undefined) throw new Error("webhook token missing");
    const byToken = store.automations.getByToken(token);
    expect(byToken?.id).toBe(automation.id);

    const disabled = store.automations.update(automation.id, { enabled: false, name: "renamed" });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.name).toBe("renamed");
    expect(store.automations.getByToken(token)?.id).toBe(automation.id);

    store.automations.update(automation.id, { trigger: { type: "webhook", token: "new-token" } });
    expect(store.automations.getByToken("new-token")?.id).toBe(automation.id);
    expect(store.automations.getByToken(token)).toBe(undefined);

    const firing = store.automations.createFiring({
      automationId: automation.id,
      at: isoTimestamp("2026-01-01T00:00:00.000Z"),
      status: "running",
    });
    expect(store.automations.listFirings(automation.id).length).toBe(1);
    const settled = store.automations.updateFiring(firing.id, { status: "done", runId: "run-1" });
    expect(settled?.status).toBe("done");
    expect(settled?.run_id).toBe("run-1");
    store.automations.setLastFiredAt(automation.id, isoTimestamp("2026-01-01T00:01:00.000Z"));
    expect(store.automations.get(automation.id)?.last_fired_at).toBe("2026-01-01T00:01:00.000Z");
    expect(store.automations.delete(automation.id)).toBe(true);
    expect(store.automations.get(automation.id)).toBe(undefined);
    expect(store.automations.listFirings(automation.id).length).toBe(0);
  });
});

test("an automation rejects a non-ISO last_fired_at before writing", () => {
  withStore((store) => {
    const project = store.projects.ensureDefault();
    const automation = store.automations.create({
      projectId: project.id,
      name: "hook",
      trigger: { type: "webhook" },
      action: { type: "task" },
    });
    // SAFETY: a JS caller can bypass the type; the setter must still refuse a non-ISO value.
    const hostileTime = "2026-01-01T00:01" as IsoTimestamp;
    expect(() => store.automations.setLastFiredAt(automation.id, hostileTime)).toThrow();
    expect(store.automations.get(automation.id)?.last_fired_at).toBe(null);
  });
});

test("a firing rejects a non-ISO at before writing", () => {
  withStore((store) => {
    const project = store.projects.ensureDefault();
    const automation = store.automations.create({
      projectId: project.id,
      name: "hook",
      trigger: { type: "webhook" },
      action: { type: "task" },
    });
    // SAFETY: a JS caller can bypass the type; createFiring must still refuse a non-ISO value.
    const hostileTime = "2026-01-01T00:01" as IsoTimestamp;
    expect(() =>
      store.automations.createFiring({
        automationId: automation.id,
        at: hostileTime,
        status: "running",
      }),
    ).toThrow();
    expect(store.automations.listFirings(automation.id).length).toBe(0);
  });
});
