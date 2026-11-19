import type { BrowserContext } from "@playwright/test";
import { signSession } from "../../packages/server/src/edge/session.ts";

/** The secret the journey's edge is built with (runtime.ts). */
export const SESSION_SECRET = "e2e-session-secret-0123456789abcdef";

/**
 * Give the browser a session, the way the login face will.
 *
 * @param context - The browser context.
 * @param origin - The edge's origin (the cookie is the edge's host).
 * @returns Nothing.
 *
 * @remarks
 * **The cookie is the edge's own signer's value.** `signSession` is the function the login face
 * (0108) issues with; this calls it rather than forging a format, so a journey that runs is a
 * journey whose session the edge really verifies. The login face itself does not exist yet, and
 * this is the one place the journey stands in for it.
 */
export async function signIn(context: BrowserContext, origin: string): Promise<void> {
  const cookie = await signSession(SESSION_SECRET, {
    subject: "owner",
    expiresAt: Date.now() + 3_600_000,
  });
  await context.addCookies([
    {
      name: "hns_session",
      value: cookie,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}