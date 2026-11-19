import type { Page } from "@playwright/test";

/**
 * What the controls did, as the journey needs to check them.
 *
 * @remarks
 * `requested` counts the `requestDocumentPreview` mutations the page sent, which is how the
 * "second open is the cache" condition is read without trusting the panel's own text: the row
 * is `ready` and the page did not ask the server to make a new one.
 */
export interface Controls {
  readonly requested: () => number;
  /** Every request the page made, as its method and path. */
  readonly all: () => readonly string[];
}

/** Count the app's request mutation as the page sends it. */
export async function watchControls(page: Page): Promise<Controls> {
  let requested = 0;
  const all: string[] = [];
  page.on("request", (request) => {
    all.push(request.method() + " " + new URL(request.url()).pathname);
    if (!request.url().endsWith("/graphql")) return;
    const body = request.postData() ?? "";
    if (body.includes("RequestMutation")) requested += 1;
  });
  return { requested: () => requested, all: () => all };
}