import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../../components/Button.tsx";
import { classNames } from "../../design/classNames.ts";
import { bottomOffset, followOf, type FollowState, type ScrollMetrics } from "./follow.ts";
import { RichText } from "./RichText.tsx";
import type { ProgressView, TranscriptItem } from "./transcript.ts";

/** One line's label, in the screen's own words; never the entry kind. */
const KIND_LABELS: Record<TranscriptItem["kind"], string> = {
  user: "あなた",
  assistant: "エージェント",
  tool: "ツール",
  system: "記録",
};

/** The tool line of a transcript: the one item kind with a name and a body to fold away. */
type ToolLine = Extract<TranscriptItem, { readonly kind: "tool" }>;

/** One tool result, collapsed to one line until the reader opens it. */
function ToolItem({ item }: { readonly item: ToolLine }): ReactElement {
  const [open, setOpen] = useState(false);
  const summary = item.text.split("\n")[0] ?? "";
  return (
    <li className="hns-message hns-message--tool">
      <button
        type="button"
        className="hns-message__toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className="hns-message__label">
          {KIND_LABELS.tool}
          {item.name === "" ? "" : " · " + item.name}
        </span>
        <span className="hns-message__summary">{open ? "閉じる" : summary}</span>
      </button>
      {open ? (
        <div className="hns-message__body">
          <RichText text={item.text} />
        </div>
      ) : null}
    </li>
  );
}

/** The progress line: one slot, one of four sentences, whether or not a turn is in flight. */
function ProgressLine({ progress }: { readonly progress: ProgressView | null }): ReactElement {
  return (
    <div
      className="hns-progress"
      data-kind={progress?.kind ?? "idle"}
      role="status"
      aria-live="polite"
    >
      {progress === null ? null : (
        <>
          {progress.live ? <span className="hns-progress__dot" aria-hidden="true" /> : null}
          <span>{progress.label}</span>
        </>
      )}
    </div>
  );
}

export interface TranscriptProps {
  readonly items: readonly TranscriptItem[];
  /** The in-flight answer, drawn after the last durable line. */
  readonly draft: string;
  /** The transcript is empty and the view is fresh: the conversation has not started. */
  readonly empty: boolean;
  readonly progress: ProgressView | null;
}

/** The container's numbers, as the follow rule wants them. */
function metricsOf(element: HTMLDivElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

/**
 * The transcript: entries, the in-flight answer, and the way back to the newest line.
 *
 * @param props - The lines, the draft, and what the progress line says.
 *
 * @remarks
 * **Follow is the reader's, and it is state, not a ref.** The 最新へ button is drawn only while
 * the reader is away from the end (`reading`), and whether it is offered must be decided by the
 * last `scroll` event the reader caused, not by a number read back from a layout this code does
 * not own. The rule itself is {@link followOf}, which is tested on its own.
 *
 * A render can add a line or a delta. While `following`, the view is taken to the new end;
 * while `reading`, the view stays where the reader put it and the button appears.
 *
 * **最新へ** takes the view back to the end, records `following`, and drops the button, so new
 * text moves the view again.
 */
export function Transcript({ items, draft, empty, progress }: TranscriptProps): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState<FollowState>("following");

  const toBottom = (): void => {
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = bottomOffset(metricsOf(element));
    }
    setFollow("following");
  };

  // Every render can add a line or a delta; a reader at the end is taken to the new end, and a
  // reader who is not is offered the button instead of having the view pulled under them.
  useLayoutEffect(() => {
    if (follow !== "following") return;
    const element = scroller.current;
    if (element !== null) element.scrollTop = bottomOffset(metricsOf(element));
  }, [follow, items.length, draft]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const onScroll = (): void => {
      setFollow(followOf(metricsOf(element)));
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
    };
  }, []);

  const showLatest = follow === "reading";

  return (
    <div className="hns-transcript">
      <div
        className="hns-transcript__scroll"
        ref={scroller}
        data-follow={showLatest ? "reading" : "following"}
      >
        {empty ? (
          <section className="hns-transcript__empty" aria-label="空の会話">
            <p className="hns-view__note">まだメッセージがありません。下の欄から送る。</p>
          </section>
        ) : (
          <ol className="hns-transcript__list">
            {items.map((item) =>
              item.kind === "tool" ? (
                <ToolItem key={item.id} item={item} />
              ) : (
                <li
                  key={item.id}
                  className={classNames("hns-message", `hns-message--${item.kind}`)}
                >
                  <span className="hns-message__label">{KIND_LABELS[item.kind]}</span>
                  <div className="hns-message__body">
                    <RichText text={item.text} />
                  </div>
                </li>
              ),
            )}
            {draft === "" ? null : (
              <li className="hns-message hns-message--draft" aria-label="生成中">
                <span className="hns-message__label">{KIND_LABELS.assistant}</span>
                <div className="hns-message__body">
                  <RichText text={draft} />
                </div>
              </li>
            )}
          </ol>
        )}
        <ProgressLine progress={progress} />
      </div>
      {showLatest ? (
        <Button variant="ghost" className="hns-transcript__latest" onClick={toBottom}>
          最新へ
        </Button>
      ) : null}
    </div>
  );
}
