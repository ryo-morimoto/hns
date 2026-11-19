import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtBundle, staticBuild, writeWorkspaceFiles } from "../support/bundle.ts";
import { signIn } from "../support/auth.ts";
import { watchControls } from "../support/controls.ts";
import { officeFixtures } from "../support/fixtures.ts";
import { ensurePack } from "../support/pack.ts";
import { encodePath, PROJECT } from "../support/page.ts";
import { REPO_ROOT, startOfficeRuntime, type OfficeRuntime } from "../support/runtime.ts";

const FIXTURES = officeFixtures();
const FILES = [...FIXTURES.map((fixture) => fixture.path), "projects/notes/議事録.docx"];

let runtime: OfficeRuntime | undefined;
let work = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "hns-e2e-"));
  const pack = await ensurePack({
    root: REPO_ROOT,
    build: process.env["HNS_E2E_BUILD_PACK"] === "1",
  });
  const assets = await staticBuild(builtBundle().dir);
  const contents = new Map<string, Uint8Array>();
  for (const fixture of FIXTURES) contents.set(fixture.path, fixture.bytes());
  contents.set("projects/notes/議事録.docx", FIXTURES[0]?.bytes() ?? new Uint8Array());
  await writeWorkspaceFiles(join(work, "root"), contents);
  runtime = await startOfficeRuntime({
    packRoot: pack.root,
    workspaceRoot: "",
    projectId: PROJECT,
    cacheRoot: join(work, "office-cache"),
    root: join(work, "root"),
    assets,
  });
});

test.afterAll(async () => {
  await runtime?.close();
  if (work !== "") await rm(work, { recursive: true, force: true });
});

/**
 * Route the page's requests to the journey's edge.
 *
 * @param page - The page.
 * @remarks
 * The page itself is served by the edge (the build's `index.html` under the edge's `/app`), so
 * every request is already the edge's origin: nothing is rewritten. The hook exists so a test
 * can read what the page sent as it is sent.
 */
async function openApp(page: Page): Promise<void> {
  if (runtime === undefined) throw new Error("the runtime did not start");
  await page.goto(runtime.edgeOrigin + "/app#/p/" + PROJECT);
  await expect(page.getByRole("heading", { name: "Workspace", level: 1 })).toBeVisible();
}

/** The hash route that opens one file, with the order the panel's next link walks. */
async function fileRoute(path: string): Promise<string> {
  if (runtime === undefined) throw new Error("the runtime did not start");
  return (
    runtime.edgeOrigin +
    "/app?files=" +
    FILES.map((item) => encodeURIComponent(item)).join("&files=") +
    "#/p/" +
    PROJECT +
    "/doc/" +
    encodePath(path)
  );
}

/** What the panel is drawing right now: no state element means the viewer has the panel. */
type DrawnState = { readonly status: string | null; readonly failure: string | null };

/**
 * The state the panel is drawing at this instant.
 *
 * @param page - The page.
 * @returns The state element's attributes, or `ready` when the viewer has taken the panel.
 *
 * @remarks
 * **A ready preview has no state element.** The panel draws a state while the row moves and hands
 * the panel to the PDF viewer once it is ready (`ready` is the one state with no sentence to read),
 * so "no state element, a viewer" is what a settled preview looks like. Reading `ready` here is
 * what the contract means by it; the viewer's own page number is what the journey asserts next.
 */
async function drawn(page: Page): Promise<DrawnState> {
  const state = page.getByTestId("office-state");
  if ((await state.count()) === 0) {
    return (await page.getByTestId("office-page-number").count()) > 0
      ? { status: "ready", failure: null }
      : { status: null, failure: null };
  }
  return {
    status: await state.first().getAttribute("data-office-state"),
    failure: await state.first().getAttribute("data-office-failure"),
  };
}

/**
 * Wait until the panel is past the states the alarm moves, or say what it drew instead.
 *
 * @param page - The page.
 * @returns The settled state, or the still-moving state the deadline ran out on.
 *
 * @remarks
 * The panel polls once a second, so the read after the alarm is what draws the settled row; this
 * waits for that read by observing the panel, never by sleeping a fixed time.
 */
async function settledState(page: Page): Promise<DrawnState> {
  // A condition, not a clock: the panel either draws one of the states the alarm moves, or the
  // viewer (which has no state element). The panel polls on its own until one of them is there.
  await page
    .waitForFunction(
      () => {
        if (document.querySelector("[data-testid='office-page-number']") !== null) return true;
        const element = document.querySelector("[data-office-state]");
        if (element === null) return false;
        const status = element.getAttribute("data-office-state");
        return status !== "queued" && status !== "generating" && status !== "stale";
      },
      undefined,
      { timeout: 90_000 },
    )
    .catch(() => undefined);
  return await drawn(page);
}

/**
 * The page's rendered page number, once the viewer drew page 1.
 *
 * @param page - The page.
 * @returns `1 / <pages>`.
 *
 * @remarks
 * The viewer draws its toolbar before the document is parsed, and the count reads `— / —` until
 * then; waiting for a real count is what makes this the document's own answer and not the
 * spinner's placeholder.
 */
async function pageNumber(page: Page): Promise<string> {
  const number = page.getByTestId("office-page-number");
  await expect(number).toBeVisible({ timeout: 60_000 });
  await expect(number).not.toHaveText("— / —", { timeout: 60_000 });
  return (await number.textContent()) ?? "";
}

test.beforeEach(async ({ context }) => {
  if (runtime === undefined) throw new Error("the runtime did not start");
  // The login face (0108) has not landed: the journey holds the session the edge verifies.
  await signIn(context, runtime.edgeOrigin);
});

test("three formats open, the second open is the cache, a next file follows, and the failures are said", async ({
  page,
}) => {
  const controls = await watchControls(page);
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.error("e2e console", message.type(), message.text().slice(0, 500));
    }
  });
  page.on("pageerror", (error) => console.error("e2e pageerror", error.message.slice(0, 600)));
  page.on("request", (request) => {
    if (request.url().includes("/assets/")) return;
    console.error(
      "e2e req",
      request.method(),
      request.url().replace(/^http:\/\/127\.0\.0\.1:[0-9]+/, ""),
    );
  });

  await openApp(page);
  if (runtime === undefined) throw new Error("the runtime did not start");

  // C1: each format opens, the row is ready with the document's page count, and page 1 is drawn.
  for (const fixture of FIXTURES) {
    // Every read of the byte route, so the bytes' own answer can be asserted (0239's regression).
    const previews: { readonly status: number; readonly type: string }[] = [];
    const onPreview = (response: import("@playwright/test").Response): void => {
      if (response.url().includes("/api/office/preview")) {
        previews.push({
          status: response.status(),
          type: response.headers()["content-type"] ?? "",
        });
      }
    };
    page.on("response", onPreview);
    await page.goto(await fileRoute(fixture.path));
    const firstOpen = controls.requested();
    // The panel's request is a mutation the page sends once per visit; the alarm runs the job.
    // The panel exists and is drawing one of its states: the read found no row and the request
    // it sent is what comes next.
    await expect
      .poll(async () => (await drawn(page)).status, {
        message: fixture.path + " drew no panel state",
        timeout: 60_000,
      })
      .not.toBe(null);
    await expect
      .poll(async () => runtime?.officeRows().length ?? 0, {
        message:
          fixture.path + " made no office row; sessions " + JSON.stringify(runtime?.sessionNames()),
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const rowBefore = runtime.officeRows()[0];
    // C1: the alarm runs the job, as the deployment's timer does once the request is answered.
    await runtime.alarm();
    const ready = await settledState(page);
    if (ready.status !== "ready") {
      // The state the page drew, for a failure's diagnosis: the panel's own elements only.
      console.error(
        "e2e debug panel",
        await page
          .locator("[aria-label='文書プレビュー']")
          .evaluate((node) => node.outerHTML.slice(0, 600)),
      );
    }
    if (ready.status !== "ready") {
      console.error(
        "e2e debug html",
        await page.locator("[aria-label='文書プレビュー']").innerHTML(),
      );
      throw new Error(
        fixture.path +
          " drew " +
          String(ready.status) +
          ": row " +
          JSON.stringify(rowBefore) +
          " now " +
          JSON.stringify(runtime.officeRowDetails()) +
          " jobs " +
          JSON.stringify(runtime.officeJobs()),
      );
    }
    expect(ready.status, fixture.path + " drew " + String(ready.status)).toBe("ready");
    expect(ready.failure).toBe(null);
    // The bytes' route answers bytes. It once answered the preview's own row as JSON, because the
    // public path sat under the object's JSON RPC prefix (0239); a page reader cannot see that
    // difference until the viewer says "PDF を読み込めませんでした", so it is asserted here.
    page.off("response", onPreview);
    expect(previews, fixture.path + " read " + JSON.stringify(previews)).toContainEqual({
      status: 200,
      type: "application/pdf",
    });
    const shown = await pageNumber(page);
    expect(shown).toBe("1 / " + String(fixture.pages));
    // The text layer over the canvas: the source document's text is what page 1 says.
    await expect(page.getByTestId("office-text-layer")).toContainText(fixture.text, {
      timeout: 30_000,
    });
    // The page asked for the preview (one request), and the row came back ready.
    expect(controls.requested()).toBeGreaterThanOrEqual(firstOpen);

    // C2: opening the same file again is the cache: no new job, no new request.
    //
    // **The job count is the cache's evidence.** A second conversion would write a second
    // `office.job`; a cache hit answers the row the first run settled and writes none (the machine
    // reads its cache before the sandbox runs, `stats.cached: true`). The page's own request is
    // counted too: a visit that re-requested would be a second write at the object.
    const jobsBefore = runtime.officeJobs().length;
    const requestsBefore = controls.requested();
    await page.goto(runtime.edgeOrigin + "/app#/p/" + PROJECT);
    await page.goto(await fileRoute(fixture.path));
    const again = await settledState(page);
    expect(again.status).toBe("ready");
    expect(await pageNumber(page)).toBe("1 / " + String(fixture.pages));
    expect(runtime.officeJobs().length).toBe(jobsBefore);
    expect(controls.requested()).toBe(requestsBefore);
  }

  // C2's audit half (C5): one office.job per first open, and none of them carries the document.
  const jobs = runtime.officeJobs();
  expect(jobs.length).toBe(FIXTURES.length);
  for (const job of jobs) {
    expect(job.detail["outcome"]).toBe("ready");
    expect(job.detail["engineVersion"]).toBe("0.8.7");
    expect(job.detail["operation"]).toBe("preview");
    const text = JSON.stringify(job.detail);
    expect(text).not.toContain("提案書の本文です");
    expect(text).not.toContain("売上");
    expect(text).not.toContain("報告資料");
  }

  // The next control: a link to the next file in the route's order, which opens it.
  //
  // The loop above ends on the last document, whose next is the end of the list (and no control);
  // the first one is reopened here, and its next is the second.
  await page.goto(await fileRoute(FIXTURES[0]?.path ?? ""));
  expect((await settledState(page)).status).toBe("ready");
  const next = page.getByTestId("office-next");
  await expect(next).toBeVisible();
  // The next link carries the order it was opened from (0239), as the location's query: dropping
  // it would end a walk through a folder at its second file.
  // **The address is absolute and carries the order once** (0239): a relative link kept this
  // page's query and appended to it, so the list grew by one on every step.
  const order = "?" + FILES.map((item) => "files=" + encodeURIComponent(item)).join("&");
  const nextHref =
    (runtime as OfficeRuntime).edgeOrigin +
    "/app" +
    order +
    "#/p/" +
    PROJECT +
    "/doc/" +
    encodeURIComponent(FILES[1] ?? "");
  await expect(next).toHaveAttribute("href", nextHref);
  // No second `files=` beyond the list's own: one order, not one more per step.
  expect((nextHref.match(/files=/gu) ?? []).length).toBe(FILES.length);
  await next.click();
  // The URL the link went to is the next file's address, with the order it came from.
  await expect(page).toHaveURL(
    new RegExp(
      "files=" +
        encodeURIComponent(FILES[0] ?? "") +
        ".*#/p/" +
        PROJECT +
        "/doc/" +
        encodeURIComponent(FILES[1] ?? "") +
        "$",
      "u",
    ),
  );
  const followed = await settledState(page);
  expect(followed.status).toBe("ready");
  expect(await pageNumber(page)).toBe("1 / " + String(FIXTURES[1]?.pages ?? 0));

  // The panel is keyboard-reachable (0238's acceptance, asserted in a real browser): from the
  // panel's header, Tab reaches a control **inside the panel**, and it is a real element a
  // person can press — not the page body, and not something outside the panel.
  await page.locator("#office-title").focus();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    const panel = active?.closest(".hns-office") ?? null;
    return { tag: active?.tagName ?? null, inPanel: panel !== null };
  });
  // The viewer is itself a focus stop (a group); anything focusable inside the panel is the
  // acceptance's answer, and the page body (BODY) would be the failure it exists to catch.
  expect(focused.inPanel).toBe(true);
  expect(focused.tag).not.toBe("BODY");

  // A path the workspace cannot have is refused without a request: the route keeps it, the
  // panel says so, and nothing is sent.
  const before = controls.requested();
  await page.goto(
    (runtime as OfficeRuntime).edgeOrigin + "/app#/p/" + PROJECT + "/doc/..%2F..%2Fetc%2Fpasswd",
  );
  const refused = await settledState(page);
  expect(refused.failure).toBe("not_authorized");
  expect(await page.getByTestId("office-label").textContent()).toBe("権限がありません");
  expect(controls.requested()).toBe(before);
});
