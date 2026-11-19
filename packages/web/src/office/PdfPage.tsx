import { useEffect, useRef, useState, type ReactElement } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "./viewer.ts";

/**
 * The reader's module, loaded when there is a page to draw.
 *
 * @remarks
 * It is an import rather than a static one so PDF.js is a chunk of its own: a person who never
 * opens a preview does not download the renderer (W-P1's initial budget).
 */
async function reader(): Promise<typeof import("./viewer.ts")> {
  return await import("./viewer.ts");
}

/** The z-index of the text layer: above the canvas, below every control. */
const PAGE_TEXT_Z_INDEX = 1;

/** One page's text, once it has been read; null until then. */
export interface PageTextState {
  readonly page: number;
  readonly items: readonly TextItem[];
  readonly width: number;
  readonly height: number;
}

/**
 * One page: the canvas PDF.js draws into, and the text layer over it.
 *
 * @param props.document - The open document.
 * @param props.page - 1-based page number.
 * @param props.zoom - 1 is the page at its natural size.
 * @param props.text - The text already read (for any page); the page's own is used.
 * @param props.onText - Receives a page's text once it has been read.
 *
 * @remarks
 * **The canvas is the page; the text layer is what a person selects.** PDF.js draws glyphs into
 * the canvas and reports the same glyphs as positioned runs; the runs are placed transparently
 * over the canvas, at the zoomed positions, so a drag selects what is on screen and the selection
 * can be copied. A page with no text (a scan) places nothing and still shows its image.
 *
 * A superseded render (a page turn or a zoom while the previous one is in flight) is dropped by
 * the effect's cleanup, so a slow page never paints over a newer one.
 */
export function PdfPage({
  document,
  page,
  zoom,
  text,
  onText,
}: {
  readonly document: PDFDocumentProxy;
  readonly page: number;
  readonly zoom: number;
  readonly text: PageTextState | null;
  readonly onText: (value: PageTextState) => void;
}): ReactElement {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    let live = true;
    setFailed(false);
    setDrawn(false);
    void reader()
      .then((viewer) => viewer.renderPage(document, page, target, zoom))
      .then(() => {
        if (live) setDrawn(true);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [document, page, zoom]);

  useEffect(() => {
    if (text !== null && text.page === page) return;
    let live = true;
    void reader()
      .then((viewer) => viewer.pageText(document, page))
      .then((found) => {
        if (live) onText(found);
      })
      .catch(() => {
        // A page with no text layer still draws; nothing to place is not a failure to show.
      });
    return () => {
      live = false;
    };
  }, [document, page, onText]);

  const shown = text !== null && text.page === page ? text : null;
  return (
    <div
      className="hns-office__page"
      data-testid="office-page"
      data-page={String(page)}
      style={drawn ? undefined : { visibility: "hidden" }}
    >
      {/* Hidden until a page is on it: a blank white box is not "the page", it is "not yet". */}
      <canvas
        ref={canvas}
        className="hns-office__pdf"
        aria-hidden="true"
        data-drawn={drawn ? "true" : "false"}
      />
      {failed ? (
        <p className="hns-office__note" role="alert">
          ページを描けませんでした。
        </p>
      ) : null}
      {shown === null ? null : (
        <div
          className="hns-office__text"
          data-testid="office-text-layer"
          style={{
            width: String(shown.width * zoom) + "px",
            height: String(shown.height * zoom) + "px",
            zIndex: PAGE_TEXT_Z_INDEX,
          }}
        >
          {shown.items.map((item, index) => (
            <span
              key={String(index)}
              className="hns-office__glyph"
              data-testid="office-glyph"
              style={{
                left: String(item.x * zoom) + "px",
                top: String(item.y * zoom) + "px",
                fontSize: String(item.height * zoom) + "px",
              }}
            >
              {item.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
