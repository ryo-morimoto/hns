import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/**
 * The PDF.js worker, as a URL the browser loads.
 *
 * @remarks
 * `?url` asks Vite to emit the worker as its own file beside the bundle and hand back the URL it is
 * served at: the built app loads `/assets/pdf.worker.min-<hash>.mjs` from the same origin as
 * everything else, and **nothing is fetched from a CDN** (no `workerSrc` points off-origin).
 *
 * The emission happens **only where this module is in the build**: the worker is emitted because
 * the panel is wired into the shell (the shell's panel slot loads it), which is what
 * `packages/web/src/build.test.ts` asserts of `deploy/assets`. A runner resolves the URL to the
 * package's own `node_modules` path, which is a test's stand-in and not a deployment's.
 */
export const PDF_WORKER_URL: string = workerUrl;

/** Whether the worker was given to PDF.js; set once per page load. */
let workerConfigured = false;

/**
 * Point PDF.js at the bundled worker.
 *
 * @remarks
 * PDF.js falls back to a "fake worker" that parses on the main thread when it has no source; that
 * fallback is what makes a large preview freeze the tab. The source is set before the first
 * document is opened and never read from anywhere else.
 */
function configureWorker(): void {
  if (workerConfigured) return;
  GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
  workerConfigured = true;
}

/** How the viewer is given a document: a URL to range-read, or bytes it already has. */
export type ViewerSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "data"; readonly data: Uint8Array };

/**
 * The options a URL is opened with; one place, so a test reads what production does.
 *
 * @remarks
 * `disableRange: false` is the contract's choice (`docs/office.md` §6): PDF.js asks the session
 * route for the pieces it renders, so a large proposal is not downloaded whole before page 1.
 * `disableAutoFetch` keeps it from pulling the rest in the background.
 */
export const URL_DOCUMENT_OPTIONS = {
  disableRange: false,
  disableAutoFetch: true,
  disableStream: false,
  withCredentials: true,
} as const;

/**
 * What one read of a preview route answered before PDF.js was asked for the document.
 *
 * @remarks
 * **"Not yet" is not "broken".** The route answers `425 Too Early` while a row exists and the
 * alarm has not finished the conversion (0239); PDF.js reading that answer would report a failed
 * document, and the panel would show a failure for a preview that is about to exist. The viewer
 * asks once, before the reader, and waits when the answer says so.
 */
export type PreviewProbe =
  | { readonly kind: "ready" }
  | { readonly kind: "early"; readonly retryAfterMs: number };

/** How long to wait for a not-ready preview when the answer names no moment, in milliseconds. */
export const DEFAULT_RETRY_MS = 1_000;

/**
 * Ask a preview route whether its bytes are there yet, without reading them.
 *
 * @param url - The preview route the row names.
 * @param signal - Aborts the ask when the visit ends.
 * @returns Whether the bytes may be read, or when to ask again.
 *
 * @remarks
 * The ask is a `HEAD`: the route answers the same status and headers as the `GET`, and no range
 * of the artifact is read. A route that does not answer `HEAD` (`405`) or a network failure is
 * **not** "early": PDF.js is given the document and the answer is the reader's to report, because
 * this probe may not turn an unexpected answer into a wait that never ends.
 */
export async function probePreview(url: string, signal: AbortSignal): Promise<PreviewProbe> {
  let answer: Response;
  try {
    answer = await fetch(url, { method: "HEAD", credentials: "include", signal });
  } catch {
    return { kind: "ready" };
  }
  if (answer.status !== 425) return { kind: "ready" };
  const named = Number(answer.headers.get("retry-after"));
  return {
    kind: "early",
    retryAfterMs: Number.isFinite(named) && named > 0 ? named * 1000 : DEFAULT_RETRY_MS,
  };
}

/** A loaded document, the way the viewer holds it. */
export interface LoadedDocument {
  /** The document to render from. */
  readonly document: PDFDocumentProxy;
  /** The loading task; destroying it closes the worker's side of the document too. */
  readonly task: PDFDocumentLoadingTask;
  readonly pages: number;
}

/**
 * Open one PDF with the bundled worker.
 *
 * @param source - The route to read the bytes at, or bytes the caller already has.
 * @returns The document, its loading task, and how many pages it has.
 *
 * @throws When the bytes are not a PDF, the worker cannot start, or the route refuses the read.
 */
export async function openDocument(source: ViewerSource): Promise<LoadedDocument> {
  configureWorker();
  const task: PDFDocumentLoadingTask =
    source.kind === "url"
      ? getDocument({ url: source.url, ...URL_DOCUMENT_OPTIONS })
      : getDocument({ data: source.data, disableRange: true, disableStream: true });
  const document = await task.promise;
  return { document, task, pages: document.numPages };
}

/** What a rendered page reports back: where it is and how big it came out. */
export interface RenderedPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Render one page into a canvas at a zoom.
 *
 * @param document - The open document.
 * @param pageNumber - 1-based page number.
 * @param canvas - The canvas to draw on.
 * @param zoom - 1 is the page at its natural size on a 96 dpi screen.
 * @returns The page number and the size it was drawn at, in CSS pixels.
 * @throws When the page is missing or the render fails.
 *
 * @remarks
 * The scale is multiplied by the device pixel ratio so text stays sharp, and the canvas keeps the
 * page's layout size: the CSS size is what a person sees, the backing store is what makes it
 * legible on a dense display.
 */
export async function renderPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  zoom: number,
): Promise<RenderedPage> {
  const page = await document.getPage(pageNumber);
  const natural = page.getViewport({ scale: 1 });
  const ratio = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: zoom * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = String(Math.floor(viewport.width / ratio)) + "px";
  canvas.style.height = String(Math.floor(viewport.height / ratio)) + "px";
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("the canvas has no 2d context");
  const task: RenderTask = page.render({ canvas, canvasContext: context, viewport });
  await task.promise;
  page.cleanup();
  return { page: pageNumber, width: Math.floor(natural.width), height: Math.floor(natural.height) };
}

/** One positioned run of text on a page, in CSS pixels, measured from the page's top edge. */
export interface TextItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

/** One page's text, positioned, with the page's natural size. */
export interface PageText {
  readonly page: number;
  readonly items: readonly TextItem[];
  readonly width: number;
  readonly height: number;
}

/**
 * Read one page's text items, positioned in the page's own coordinates.
 *
 * @param document - The open document.
 * @param pageNumber - 1-based page number.
 * @returns The items, with the page's natural size.
 *
 * @remarks
 * The canvas draws the glyphs; this is what makes them selectable and readable aloud. PDF.js
 * gives each item an affine transform in PDF points (with the origin at the page's bottom-left),
 * and the overlay places it with the same scale the canvas was drawn at.
 */
export async function pageText(document: PDFDocumentProxy, pageNumber: number): Promise<PageText> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: TextItem[] = [];
  for (const item of content.items) {
    if (!("str" in item) || item.str.trim() === "") continue;
    const [, , c, d, e, f] = item.transform;
    const height = Math.hypot(d, c) || item.height;
    items.push({ text: item.str, x: e, y: viewport.height - f, height });
  }
  return { page: pageNumber, items, width: viewport.width, height: viewport.height };
}
