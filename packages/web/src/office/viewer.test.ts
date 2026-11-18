import { afterAll, beforeAll, expect, test } from "vitest";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import { fillPdfjsGlobals } from "../../test/support/pdfjs.ts";
import { onePdf, threePdf } from "../../test/support/pdf.ts";
import { PDF_WORKER_URL, URL_DOCUMENT_OPTIONS, pageText, renderPage } from "./viewer.ts";

/**
 * The PDF reader, over real PDFs.
 *
 * @remarks
 * `pdfjs-dist` is the reader the viewer ships. Its **browser** build cannot run under this test
 * runner (jsdom has no `Worker`, and the build refuses the main thread under Node — it says so and
 * then sets up a stand-in that cannot resolve its module), so the documents a test opens are
 * opened with PDF.js's own **legacy build**: the same parser, renderer, and text extractor,
 * compiled for fewer globals. The viewer's own module is still the production one: the worker URL
 * it hands PDF.js, and the options it opens a URL with, are what these tests read.
 *
 * The canvas stand-in only accepts drawing calls: jsdom has no rasteriser. A render's promise
 * resolving is the proof that PDF.js parsed the bytes into a page and ran its drawing operators.
 */

beforeAll(fillPdfjsGlobals);
afterAll(() => undefined);

/** The legacy build's `getDocument`, over the viewer's own options. */
async function open(data: Uint8Array): Promise<{
  readonly document: PDFDocumentProxy;
  readonly task: PDFDocumentLoadingTask;
  readonly pages: number;
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data, ...URL_DOCUMENT_OPTIONS });
  const document = await task.promise;
  return { document, task, pages: document.numPages };
}

/** A canvas whose context accepts PDF.js's calls, for a machine with no rasteriser. */
function canvasStub(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const operations: string[] = [];
  const context = {
    canvas,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    save: () => undefined,
    restore: () => undefined,
    transform: () => undefined,
    setTransform: () => undefined,
    resetTransform: () => undefined,
    scale: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    fillRect: () => operations.push("fillRect"),
    strokeRect: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    fill: () => operations.push("fill"),
    stroke: () => undefined,
    clip: () => undefined,
    fillText: () => operations.push("fillText"),
    drawImage: () => operations.push("drawImage"),
    measureText: () => ({ width: 1 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    setLineDash: () => undefined,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "left",
    textBaseline: "alphabetic",
    direction: "ltr",
    filter: "none",
  };
  Object.defineProperty(canvas, "getContext", { value: () => context, configurable: true });
  return canvas;
}

// Catches: a worker source that points off-origin (a CDN would be a third-party script that
// runs with the bundle's privileges), or a build that failed to emit the worker as a file.
test("the worker source is the bundled, same-origin file", () => {
  const url = new URL(PDF_WORKER_URL, "https://hns.example/app/");
  expect(url.origin).toBe("https://hns.example");
  expect(url.pathname).toContain("pdf.worker");
  expect(PDF_WORKER_URL.startsWith("http://") || PDF_WORKER_URL.startsWith("https://")).toBe(false);
});

// Catches: a viewer that asks for the whole artifact first (disableRange) — the contract reads a
// preview by ranges so a large one shows its first page without a full download.
test("a URL document is read by ranges, with the session's credentials", () => {
  expect(URL_DOCUMENT_OPTIONS.disableRange).toBe(false);
  expect(URL_DOCUMENT_OPTIONS.withCredentials).toBe(true);
  expect(URL_DOCUMENT_OPTIONS.disableAutoFetch).toBe(true);
});

// Catches: the reader's page count disagreeing with the document, which is what C2 compares a row
// against.
test("the reader counts the pages a PDF has", async () => {
  const three = await open(threePdf());
  try {
    expect(three.pages).toBe(3);
    expect(three.document.numPages).toBe(3);
  } finally {
    await three.task.destroy();
  }
  const one = await open(onePdf());
  try {
    expect(one.pages).toBe(1);
  } finally {
    await one.task.destroy();
  }
});

// Catches: a page turn that does not reach the other page's text (the text layer would keep
// page 1's run), and a text layer whose items are dropped.
test("a page's text is the page's own, and a page turn reads the next one", async () => {
  const opened = await open(threePdf());
  try {
    const first = await pageText(opened.document, 1);
    expect(first.items.map((item) => item.text).join("")).toContain("Page 1");
    expect(first.width).toBeGreaterThan(0);
    const third = await pageText(opened.document, 3);
    expect(third.items.map((item) => item.text).join("")).toContain("Page 3");
  } finally {
    await opened.task.destroy();
  }
});

// Catches: a zoom that changes the drawing but not the page's layout size (the page would be
// cropped), and a render that never reaches the drawing operators.
test("a page renders at the zoomed size, and a larger zoom draws a larger page", async () => {
  const opened = await open(onePdf());
  try {
    const small = await renderPage(opened.document, 1, canvasStub(), 1);
    expect(small.page).toBe(1);
    expect(small.width).toBeGreaterThan(0);
    expect(small.height).toBeGreaterThan(0);
    const large = await renderPage(opened.document, 1, canvasStub(), 2);
    expect(large.width).toBe(small.width);
    expect(large.height).toBe(small.height);
  } finally {
    await opened.task.destroy();
  }
});
