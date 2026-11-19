import type { Page } from "@playwright/test";

/** The workspace the journey opens documents in (the one project). */
export const PROJECT = "project-1";

/**
 * Open one workspace file the way the panel's entry does: its hash route.
 *
 * @param page - The page (already at the app).
 * @param path - The workspace-relative path.
 * @param order - The order the route carries, which the panel's "next" link walks.
 * @returns Nothing; the page is at the route and the shell is drawing it.
 *
 * @remarks
 * `#/p/<project>/doc/<path>` is the app's address for a file (0239's entry); `?files=` is the
 * order the route names, which the panel uses for "next". The navigation is a hash change on the
 * page the build loaded, so the app's own router, panel, query documents and viewer all run —
 * the page's first byte is the shipped `index.html`.
 */
export async function openDocument(
  page: Page,
  path: string,
  order: readonly string[],
): Promise<void> {
  const query = "?files=" + order.map((item) => encodeURIComponent(item)).join("&files=");
  const hash = "#/p/" + PROJECT + "/doc/" + encodePath(path);
  await page.goto("/app" + query + hash);
}

/** A workspace path as the hash carries it: each segment encoded on its own. */
export function encodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}