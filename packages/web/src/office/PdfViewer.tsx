import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";
import type { LoadedDocument } from "./viewer.ts";
import { PdfPage, type PageTextState } from "./PdfPage.tsx";

/** How far one press moves the page, as a multiplier of the zoom. */
const ZOOM_STEP_IN = 1.25;
const ZOOM_STEP_OUT = 0.8;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

/**
 * The PDF viewer: one page at a time, paged and zoomed from the keyboard.
 *
 * @param props.url - The session route the bytes are read at.
 * @param props.expectedPages - The row's page count; a mismatch is reported, not hidden (C2).
 * @param props.onExit - Where `Escape` puts focus: the panel's header, so the next Tab leaves.
 *
 * @remarks
 * **The worker is the bundle's.** {@link openDocument} sets PDF.js's worker source to the file
 * Vite emitted (`?url`), so parsing happens off the main thread and nothing comes from a CDN.
 *
 * **Keyboard first.** The viewer is a `group` with one focus stop; from anywhere inside it,
 * `PageUp` / `PageDown` (and `ArrowLeft` / `ArrowRight`) page, `+` / `-` zoom, and `Home` /
 * `End` jump. `Escape` leaves the viewer for the panel's header, so a person who tabbed in can
 * tab out again without knowing how many controls the page holds. Every action is also a real
 * button, so a pointer and a screen reader reach the same thing.
 *
 * Two states besides the page: opening (the reader is loading the document) and failed (PDF.js
 * refused the bytes — a retry, not a blank panel).
 */
export function PdfViewer({
  url,
  expectedPages,
  onExit,
}: {
  readonly url: string;
  readonly expectedPages: number | null;
  readonly onExit: () => void;
}): ReactElement {
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState<PageTextState | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let opened: LoadedDocument | null = null;
    setLoaded(null);
    setError(false);
    setZoom(1);
    setPage(1);
    setText(null);
    // The reader is its own chunk: a person who never opens a preview does not download it.
    void import("./viewer.ts")
      .then((viewer) => viewer.openDocument({ kind: "url", url }))
      .then((result) => {
        opened = result;
        if (live) setLoaded(result);
        else void result.task.destroy();
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
      if (opened !== null) void opened.task.destroy();
    };
  }, [url, attempt]);

  const pages = loaded === null ? 0 : loaded.pages;
  const goTo = (next: number): void => {
    if (pages === 0) return;
    setPage(Math.min(pages, Math.max(1, next)));
  };
  const zoomBy = (factor: number): void => {
    setZoom((current) =>
      Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(current * factor * 100) / 100)),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select") !== null) return;
    switch (event.key) {
      case "PageDown":
      case "ArrowRight":
        event.preventDefault();
        goTo(page + 1);
        return;
      case "PageUp":
      case "ArrowLeft":
        event.preventDefault();
        goTo(page - 1);
        return;
      case "+":
      case "=":
        event.preventDefault();
        zoomBy(ZOOM_STEP_IN);
        return;
      case "-":
      case "_":
        event.preventDefault();
        zoomBy(ZOOM_STEP_OUT);
        return;
      case "Home":
        event.preventDefault();
        goTo(1);
        return;
      case "End":
        event.preventDefault();
        goTo(pages);
        return;
      case "Escape":
        event.preventDefault();
        onExit();
        return;
      default:
        return;
    }
  };

  if (error) {
    return (
      <section className="hns-office__state" role="alert" data-testid="office-viewer-failed">
        <h3>プレビューを表示できません</h3>
        <p>PDF を読み込めませんでした。原本はそのまま残っています。</p>
        <button
          type="button"
          className="hns-office__retry"
          onClick={() => setAttempt((value) => value + 1)}
        >
          再試行
        </button>
      </section>
    );
  }

  return (
    <div
      className="hns-office__viewer"
      role="group"
      aria-label="PDF プレビュー"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="hns-office__toolbar" role="toolbar" aria-label="ページと拡大">
        <button
          type="button"
          className="hns-office__tool"
          aria-label="前のページ"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
        >
          前へ
        </button>
        <span className="hns-office__pageof" aria-live="polite" data-testid="office-page-number">
          {pages === 0 ? "— / —" : String(page) + " / " + String(pages)}
        </span>
        <button
          type="button"
          className="hns-office__tool"
          aria-label="次のページ"
          disabled={pages === 0 || page >= pages}
          onClick={() => goTo(page + 1)}
        >
          次へ
        </button>
        <button
          type="button"
          className="hns-office__tool"
          aria-label="縮小"
          onClick={() => zoomBy(ZOOM_STEP_OUT)}
        >
          縮小
        </button>
        <span className="hns-office__zoom" data-testid="office-zoom">
          {String(Math.round(zoom * 100))}%
        </span>
        <button
          type="button"
          className="hns-office__tool"
          aria-label="拡大"
          onClick={() => zoomBy(ZOOM_STEP_IN)}
        >
          拡大
        </button>
        <button type="button" className="hns-office__tool" onClick={onExit}>
          パネルから抜ける
        </button>
      </div>
      {expectedPages !== null && pages !== 0 && pages !== expectedPages ? (
        <p className="hns-office__note" role="status" data-testid="office-page-mismatch">
          行の記録は {String(expectedPages)} ページですが、PDF は {String(pages)} ページです。
        </p>
      ) : null}
      <div className="hns-office__canvas">
        {loaded === null ? (
          <p className="hns-office__note" data-testid="office-viewer-loading" role="status">
            PDF を開いています…
          </p>
        ) : (
          <PdfPage
            document={loaded.document}
            page={page}
            zoom={zoom}
            text={text}
            onText={setText}
          />
        )}
      </div>
      <p className="hns-office__note hns-office__keys">
        PageUp / PageDown でページ、+ / - で拡大縮小、Esc
        でパネルから抜けます。テキストは選択できます。
      </p>
    </div>
  );
}
