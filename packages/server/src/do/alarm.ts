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
 * @param officeAt - The next moment an office preview row needs the alarm (0237), if any.
 * @returns Nothing; the alarm is set or deleted.
 *
 * @remarks
 * Idempotent: arming the same wakeup twice leaves one alarm. An active Session gets a
 * heartbeat so a process that dies mid-run is woken again; an idle Session gets no alarm.
 *
 * **An office row composes with the wake, it does not replace it.** The alarm is the
 * **earliest** of the wake's and the office TTL's, so a preview that is due while the Session is
 * idle is still woken (C9): the alternative — arming the wake and dropping the office time, or the
 * reverse — loses whichever work was not chosen. An idle Session with an office row therefore
 * keeps an alarm, which is exactly the row that has not finished yet.
 */
export async function armWake(
  storage: AlarmStorage,
  wake: Wake,
  now: number,
  officeAt?: number | undefined,
): Promise<void> {
  const wakeAt = wake.active
    ? now + SESSION_HEARTBEAT_MS
    : wake.at !== undefined
      ? wake.at
      : undefined;
  const at =
    officeAt === undefined ? wakeAt : wakeAt === undefined ? officeAt : Math.min(wakeAt, officeAt);
  if (at !== undefined) {
    await storage.setAlarm(at);
    return;
  }
  if ((await storage.getAlarm()) !== null) await storage.deleteAlarm();
}
