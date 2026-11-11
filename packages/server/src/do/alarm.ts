import type { Wake } from "@earendil-works/pi-durable";
import type { AlarmStorage } from "./state.ts";

/** How far ahead an active Session arms its recovery alarm. */
export const SESSION_HEARTBEAT_MS = 60_000;

/**
 * Arm the Durable Object alarm for the next wakeup, or clear it.
 *
 * @param storage - The alarm-bearing storage.
 * @param wake - `Harness.wake()`; `active` wins over `at`.
 * @param now - Epoch milliseconds of the host clock.
 * @returns Nothing; the alarm is set or deleted.
 *
 * @remarks
 * Idempotent: arming the same wakeup twice leaves one alarm. An active Session gets a
 * heartbeat so a process that dies mid-run is woken again; an idle Session gets no alarm.
 */
export async function armWake(storage: AlarmStorage, wake: Wake, now: number): Promise<void> {
  if (wake.active) {
    await storage.setAlarm(now + SESSION_HEARTBEAT_MS);
    return;
  }
  if (wake.at !== undefined) {
    await storage.setAlarm(wake.at);
    return;
  }
  if ((await storage.getAlarm()) !== null) await storage.deleteAlarm();
}
