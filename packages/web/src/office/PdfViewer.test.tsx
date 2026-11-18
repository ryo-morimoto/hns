/* oxlint-disable anti-slop/no-module-mocking -- the viewer's one boundary is `openDocument`, and
   this runner cannot start PDF.js's worker: the stub parses the same URL with PDF.js's own legacy
   build, so the reader, the bytes, and the route are the production's. */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { expect, test, vi } from "vitest";
import { previewUrlOf } from "../../test/support/officeFace.ts";
import { pdfResponse, threePdf } from "../../test/support/pdf.ts";

/**
 * The viewer's keyboard: page by page, zoom, and out of the panel.
 *
 * @remarks
 * **The reader is `pdfjs-dist`'s own legacy build, opened from the row's URL** (its URL branch,
 * with the production options). It is the PDF.js that ships, compiled for fewer globals: this test
 * runner has no `Worker`, and the browser build refuses the main thread under Node. So the
 * document is real (the three-page fixture, parsed from the bytes the route hands out), the page
 * count is the route's, and what the test drives is the production `PdfViewer` — the same keys,
 * the same toolbar, the same `openDocument`.
 *
 * The reader is stubbed at the viewer's one boundary, `openDocument`, and only because of the
 * worker: the stub parses the URL with the legacy build. The viewer cannot start a worker on this
 * thread, and a test that shipped a worker fake would be proving a stand-in rather than the
 * reader.
 */
const PROJECT = "project-1";
const PATH = "提案書.docx";
const VERSION = "sha256:" + "a".repeat(64);
const URL_OF = previewUrlOf(PROJECT, PATH, VERSION);

/** Answer the preview route with the real fixture, keeping every request the reader made. */
/** The route's stand-in: the request log it keeps, for a test that reads the reader's ranges. */
interface Served {
  readonly ranges: (string | null)[];
}

function serve(): Served {
  const bytes = threePdf();
  const ranges: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
      if (!url.includes("/api/office/preview")) throw new Error("unexpected fetch " + url);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const range = headers.get("range");
      ranges.push(range);
      if (range === null) {
        return new Response(bytes.slice(), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "accept-ranges": "bytes",
            "content-length": String(bytes.byteLength),
          },
        });
      }
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
      if (match === null) throw new Error("unsupported range " + range);
      const start = Number(match[1]);
      const end =
        match[2] === "" ? bytes.byteLength - 1 : Math.min(Number(match[2]), bytes.byteLength - 1);
      const slice = bytes.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "content-type": "application/pdf",
          "accept-ranges": "bytes",
          "content-range":
            "bytes " + String(start) + "-" + String(end) + "/" + String(bytes.byteLength),
          "content-length": String(slice.byteLength),
        },
      });
    },
  );
  return { ranges };
}

/**
 * The reader the viewer gets in this runner: the same PDF.js, its legacy build.
 *
 * @returns A stand-in for the viewer's `openDocument` that reads the same URL.
 */
async function reader(): Promise<{
  readonly openDocument: (source: { readonly kind: string; readonly url?: string }) => Promise<{
    document: unknown;
    task: { destroy(): Promise<void> };
    pages: number;
  }>;
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return {
    openDocument: async (source) => {
      const response = await fetch(source.url ?? "");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const task = pdfjs.getDocument({ data: bytes });
      const document = await task.promise;
      return {
        document,
        task: { destroy: async () => await task.destroy() },
        pages: document.numPages,
      };
    },
  };
}

/** Render the viewer over the route. */
async function renderViewer(expectedPages: number | null = 3) {
  const onExit = vi.fn();
  const served = serve();
  const stub = await reader();
  vi.doMock("./viewer.ts", async () => {
    const actual = await vi.importActual<typeof import("./viewer.ts")>("./viewer.ts");
    return { ...actual, openDocument: stub.openDocument };
  });
  vi.resetModules();
  const { PdfViewer } = await import("./PdfViewer.tsx");
  // SAFETY: the element is a JSX tree; `ReactElement` is what `render` takes.
  render(
    (<PdfViewer url={URL_OF} expectedPages={expectedPages} onExit={onExit} />) as ReactElement,
  );
  return { onExit, ranges: served.ranges };
}

/** Wait until the toolbar shows the document's page count. */
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("office-page-number").textContent).toBe("1 / 3"));
}

// Catches: a viewer whose page count is the state's rather than the document's (C2's "pages are
// the row's").
test("C2: the viewer's page count is the document's", async () => {
  serve();
  const stub = await reader();
  const opened = await stub.openDocument({ kind: "url", url: URL_OF });
  expect(opened.pages).toBe(3);
  await opened.task.destroy();
  await renderViewer(3);
  await loaded();
});

// Catches: a page turn that is pointer-only (C4), a turn past the last page, and a toolbar that
// does not follow the keyboard.
test("C4: PageDown and PageUp page, and the end of the document is the end", async () => {
  const user = userEvent.setup();
  await renderViewer();
  await loaded();
  screen.getByRole("group", { name: "PDF プレビュー" }).focus();
  await user.keyboard("{PageDown}");
  await waitFor(() => expect(screen.getByTestId("office-page-number").textContent).toBe("2 / 3"));
  await user.keyboard("{PageUp}");
  await waitFor(() => expect(screen.getByTestId("office-page-number").textContent).toBe("1 / 3"));
  await user.keyboard("{End}");
  await waitFor(() => expect(screen.getByTestId("office-page-number").textContent).toBe("3 / 3"));
  await user.keyboard("{PageDown}");
  expect(screen.getByTestId("office-page-number").textContent).toBe("3 / 3");
});

// Catches: zoom reachable by pointer only (C4), and a zoom outside its bounds.
test("C4: + and - zoom the page", async () => {
  const user = userEvent.setup();
  await renderViewer();
  await loaded();
  screen.getByRole("group", { name: "PDF プレビュー" }).focus();
  expect(screen.getByTestId("office-zoom").textContent).toBe("100%");
  await user.keyboard("+");
  await waitFor(() => expect(screen.getByTestId("office-zoom").textContent).toBe("125%"));
  await user.keyboard("-");
  await waitFor(() => expect(screen.getByTestId("office-zoom").textContent).toBe("100%"));
});

// Catches: a viewer a keyboard user cannot leave: Escape reaches the panel's exit, which is what
// puts focus back on the one focus stop before the viewer.
test("C4: Escape leaves the viewer", async () => {
  const user = userEvent.setup();
  const { onExit } = await renderViewer();
  await loaded();
  screen.getByRole("group", { name: "PDF プレビュー" }).focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
});

// Catches: a reader failure drawn as a blank page instead of a failure with a way to try again.
test("a document the reader cannot open is a failure with a retry", async () => {
  vi.stubGlobal("fetch", async (): Promise<Response> =>
    pdfResponse(new TextEncoder().encode("not a pdf")),
  );
  vi.doMock("./viewer.ts", async () => {
    const actual = await vi.importActual<typeof import("./viewer.ts")>("./viewer.ts");
    return {
      ...actual,
      openDocument: async () => {
        throw new Error("not a PDF");
      },
    };
  });
  vi.resetModules();
  const { PdfViewer } = await import("./PdfViewer.tsx");
  // SAFETY: the element is a JSX tree; `ReactElement` is what `render` takes.
  render(
    (<PdfViewer url={URL_OF} expectedPages={null} onExit={() => undefined} />) as ReactElement,
  );
  await waitFor(() => expect(screen.getByTestId("office-viewer-failed")).toBeTruthy());
  expect(screen.getByRole("button", { name: "再試行" })).toBeTruthy();
});

// Catches: a page count the row claims and the document does not have drawn as if it matched.
test("a page count that disagrees with the document is reported", async () => {
  await renderViewer(5);
  await loaded();
  expect(screen.getByTestId("office-page-mismatch").textContent).toContain("5 ページ");
});
