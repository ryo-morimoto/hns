import assert from "node:assert/strict";
import { migrateStore, type D1Binding } from "@hns/store";
import { expect, test } from "vitest";
import { openFakeD1 } from "../../test/support/d1.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import type { CostAlert } from "./alerts.ts";
import {
  CostGaugeUnavailableError,
  CostLimitError,
  createCostGate,
  type CostFailureStage,
  type CostGate,
} from "./gate.ts";
import { readMonthlyTotal } from "./ledger.ts";
import type { TurnStorage } from "./meter.ts";

const AT = new Date("2026-11-17T12:00:00.000Z");

interface Fixture {
  readonly db: D1Binding;
  readonly storage: TurnStorage;
  readonly alerts: CostAlert[];
  readonly failures: CostFailureStage[];
  readonly gate: CostGate;
  close(): void;
}

/** A gate over a real (node:sqlite) ledger and a real (node:sqlite) object store. */
async function open(
  options: { readonly db?: D1Binding | undefined; readonly storage?: TurnStorage | undefined } = {},
): Promise<Fixture> {
  const fake = openFakeD1();
  await migrateStore(fake.db);
  const state = openSqliteState();
  state.state.storage.sql.exec("CREATE TABLE turn_rows (value TEXT)");
  const storage = options.storage ?? state.state.storage;
  const alerts: CostAlert[] = [];
  const failures: CostFailureStage[] = [];
  return {
    db: options.db ?? fake.db,
    storage,
    alerts,
    failures,
    gate: createCostGate({
      db: options.db ?? fake.db,
      storage,
      now: () => AT,
      alert: (alert) => alerts.push(alert),
      failure: (stage) => failures.push(stage),
    }),
    close: () => {
      state.close();
      fake.close();
    },
  };
}

/** The error a promise rejects with, or undefined. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the rejected value is unknown by definition.
async function errorOf(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Add `rows` rows to the turn table, as a turn's work would. */
function write(storage: TurnStorage, rows: number): void {
  for (let index = 0; index < rows; index += 1) {
    storage.sql.exec("INSERT INTO turn_rows (value) VALUES ('x')");
  }
}

test("a turn records the rows it added", async () => {
  const fixture = await open();
  try {
    const value = await fixture.gate.turn(
      { id: "t1", conversationId: "2", requests: 1 },
      async () => {
        write(fixture.storage, 3);
        return "answer";
      },
    );
    expect(value).toBe("answer");
    expect(await readMonthlyTotal(fixture.db, AT)).toStrictEqual({
      doRows: 3,
      doRequests: 1,
      r2Objects: 0,
    });
    const row = await fixture.db
      .prepare("SELECT id, outcome, conversation_id, do_rows FROM cost_turn")
      .first();
    expect(row).toStrictEqual({ id: "t1", outcome: "completed", conversation_id: "2", do_rows: 3 });
  } finally {
    fixture.close();
  }
});

// Catches: a retried turn spending the month budget twice.
test("a retried turn records nothing new", async () => {
  const fixture = await open();
  try {
    await fixture.gate.turn({ id: "same", conversationId: "2", requests: 1 }, async () => {
      write(fixture.storage, 3);
    });
    await fixture.gate.turn({ id: "same", conversationId: "2", requests: 1 }, async () => {
      write(fixture.storage, 3);
    });
    const count = await fixture.db.prepare("SELECT COUNT(*) AS count FROM cost_turn").first();
    expect(count).toStrictEqual({ count: 1 });
    expect(await readMonthlyTotal(fixture.db, AT)).toStrictEqual({
      doRows: 3,
      doRequests: 1,
      r2Objects: 0,
    });
  } finally {
    fixture.close();
  }
});

// Catches: a failed turn writing no row, so the rows it spent are invisible.
test("a failed turn is recorded and its error is rethrown", async () => {
  const fixture = await open();
  try {
    await expect(
      fixture.gate.turn({ id: "failed", conversationId: "2", requests: 1 }, async () => {
        write(fixture.storage, 2);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const row = await fixture.db
      .prepare("SELECT outcome, do_rows FROM cost_turn WHERE id = 'failed'")
      .first();
    expect(row).toStrictEqual({ outcome: "failed", do_rows: 2 });
  } finally {
    fixture.close();
  }
});

// Catches: a used-up row budget still admitting a run.
test("an exhausted DO row budget refuses a new run", async () => {
  const fixture = await open();
  try {
    await fixture.db.prepare("UPDATE cost_limits SET do_rows_limit = 2").run();
    await fixture.gate.admit(AT);
    await fixture.gate.turn({ id: "t1", conversationId: "2", requests: 1 }, async () => {
      write(fixture.storage, 2);
    });
    const error = await errorOf(fixture.gate.admit(AT));
    assert(error instanceof CostLimitError, "expected a limit refusal");
    expect(error.budget).toBe("doRows");
  } finally {
    fixture.close();
  }
});

// Catches: an exhausted provider month still starting a run that can only fail.
test("an exhausted provider month refuses a new run", async () => {
  const fixture = await open();
  try {
    await fixture.db
      .prepare(
        "UPDATE provider_gateway SET month_key = '2026-11', month_spent = 10, month_limit = 10 WHERE id = 'gateway'",
      )
      .run();
    const error = await errorOf(fixture.gate.admit(AT));
    assert(error instanceof CostLimitError, "expected a limit refusal");
    expect(error.budget).toBe("provider");
  } finally {
    fixture.close();
  }
});

// Catches: a stale provider period key being read as this month's spend.
test("a provider row from the month before does not refuse", async () => {
  const fixture = await open();
  try {
    await fixture.db
      .prepare(
        "UPDATE provider_gateway SET month_key = '2026-10', month_spent = 10, month_limit = 10 WHERE id = 'gateway'",
      )
      .run();
    await expect(fixture.gate.admit(AT)).resolves.toBeUndefined();
  } finally {
    fixture.close();
  }
});

// Catches: an unreadable gauge being treated as permission to spend.
test("an unreadable gauge refuses instead of admitting", async () => {
  const missing = await open();
  try {
    await missing.db.prepare("DELETE FROM cost_limits").run();
    const error = await errorOf(missing.gate.admit(AT));
    assert(error instanceof CostGaugeUnavailableError, "expected a gauge failure");
  } finally {
    missing.close();
  }
  const broken = await open({
    db: {
      prepare: () => {
        throw new Error("d1 is down");
      },
      batch: async () => [],
    },
  });
  try {
    const error = await errorOf(broken.gate.admit(AT));
    assert(error instanceof CostGaugeUnavailableError, "expected a gauge failure");
  } finally {
    broken.close();
  }
});

// Catches: an alert on every turn, or a missed one when a ratio is crossed.
test("each threshold is alerted once as the month crosses it", async () => {
  const fixture = await open();
  try {
    await fixture.db.prepare("UPDATE cost_limits SET do_rows_limit = 10").run();
    await fixture.gate.turn({ id: "t1", conversationId: "2", requests: 1 }, async () => {
      write(fixture.storage, 6);
    });
    await fixture.gate.turn({ id: "t2", conversationId: "2", requests: 1 }, async () => {
      write(fixture.storage, 3);
    });
    await fixture.gate.turn({ id: "t3", conversationId: "2", requests: 1 }, async () => {
      write(fixture.storage, 1);
    });
    expect(fixture.alerts.map((alert) => alert.level)).toStrictEqual([
      "warn",
      "critical",
      "exceeded",
    ]);
    expect(fixture.alerts[0]).toStrictEqual({
      metric: "doRows",
      level: "warn",
      used: 6,
      limit: 10,
    });
  } finally {
    fixture.close();
  }
});

// Catches: bookkeeping failing the turn the user already got an answer for.
test("a failed record leaves the turn successful", async () => {
  const fake = openFakeD1();
  await migrateStore(fake.db);
  const state = openSqliteState();
  state.state.storage.sql.exec("CREATE TABLE turn_rows (value TEXT)");
  const failures: CostFailureStage[] = [];
  const failing: D1Binding = {
    prepare: (sql) => {
      if (sql.includes("INTO cost_turn")) throw new Error("write failed");
      return fake.db.prepare(sql);
    },
    batch: (statements) => fake.db.batch(statements),
  };
  const gate = createCostGate({
    db: failing,
    storage: state.state.storage,
    now: () => AT,
    alert: () => undefined,
    failure: (stage) => failures.push(stage),
  });
  try {
    await expect(
      gate.turn({ id: "t1", conversationId: "2", requests: 1 }, async () => "answer"),
    ).resolves.toBe("answer");
    expect(failures).toStrictEqual(["record"]);
  } finally {
    state.close();
    fake.close();
  }
});

// Catches: a broken row counter failing the turn instead of recording zero.
test("a measurement failure records zero rows", async () => {
  const brokenStorage: TurnStorage = {
    sql: {
      exec: () => {
        throw new Error("no sql");
      },
    },
  };
  const fixture = await open({ storage: brokenStorage });
  try {
    await expect(
      fixture.gate.turn({ id: "t1", conversationId: "2", requests: 1 }, async () => "answer"),
    ).resolves.toBe("answer");
    expect(fixture.failures).toStrictEqual(["measure"]);
    const row = await fixture.db.prepare("SELECT do_rows FROM cost_turn WHERE id = 't1'").first();
    expect(row).toStrictEqual({ do_rows: 0 });
  } finally {
    fixture.close();
  }
});
