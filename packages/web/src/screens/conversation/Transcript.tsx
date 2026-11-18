import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../../components/Button.tsx";
import { classNames } from "../../design/classNames.ts";
import { bottomOffset, followOf, type FollowState } from "./follow.ts";
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

/**
 * The transcript: entries, the in-flight answer, and the way back to the newest line.
 *
 * @param props - The lines, the draft, and what the progress line says.
 *
 * @remarks
 * Follow is the reader's: the view moves only while they are at the end, and it stops moving the
 * moment they scroll up, with a 最新へ button to come back. The follow state is held in a ref as
 * well as state so a growth never reads a stale value; only the reader's own scrolling (and the
 * screen's own jump) change it.
 */
export function Transcript({ items, draft, empty, progress }: TranscriptProps): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef<FollowState>("following");
  const [showLatest, setShowLatest] = useState(false);

  const toBottom = (): void => {
    const element = scroller.current;
    if (element === null) return;
    element.scrollTop = bottomOffset({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
    following.current = "following";
    setShowLatest(false);
  };

  // Every render can add a line or a delta; a reader at the end is taken to the new end, and a
  // reader who is not is offered the button instead of having the view pulled under them.
  useLayoutEffect(() => {
    if (following.current === "following") {
      toBottom();
    } else {
      setShowLatest(true);
    }
  });

  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const onScroll = (): void => {
      const next = followOf({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      });
      following.current = next;
      if (next === "following") setShowLatest(false);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
    };
  }, []);

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
