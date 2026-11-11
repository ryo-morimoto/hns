import { expect, test } from "vitest";
import { armWake, SESSION_HEARTBEAT_MS } from "./alarm.ts";
import type { AlarmStorage } from "./state.ts";

interface Recorder {
  readonly storage: AlarmStorage;
  readonly getAlarm: () => number | null;
  readonly deleted: () => number;
}

function recorder(initial: number | null = null): Recorder {
  let alarm = initial;
  let deleted = 0;
  return {
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
      deleteAlarm: async () => {
        alarm = null;
        deleted += 1;
      },
    },
    getAlarm: () => alarm,
    deleted: () => deleted,
  };
}

test("an active Session arms a heartbeat", async () => {
  const state = recorder();
  await armWake(state.storage, { active: true }, 1_000);
  expect(state.getAlarm()).toBe(1_000 + SESSION_HEARTBEAT_MS);
});

test("a sleeping Session arms the next wakeup", async () => {
  const state = recorder();
  await armWake(state.storage, { active: false, at: 9_000 }, 1_000);
  expect(state.getAlarm()).toBe(9_000);
});

// Catches: an idle Session keeping a stale alarm that wakes a dead run.
test("an idle Session clears an existing alarm", async () => {
  const state = recorder(5_000);
  await armWake(state.storage, { active: false }, 1_000);
  expect(state.getAlarm()).toBeNull();
  expect(state.deleted()).toBe(1);
});

test("arming the same wakeup twice leaves one alarm", async () => {
  const state = recorder();
  await armWake(state.storage, { active: true }, 1_000);
  const first = state.getAlarm();
  await armWake(state.storage, { active: true }, 1_000);
  expect(state.getAlarm()).toBe(first);
  expect(state.deleted()).toBe(0);
});
