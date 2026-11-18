import { useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Button } from "../../components/Button.tsx";

/**
 * What the composer is sending into, and what it knows about the run.
 *
 * @remarks
 * `running` is what decides between 送信 and 停止 in the **same slot**: the two buttons occupy the
 * same place, so the stop control never moves. `stopped` keeps the stop disabled until the next
 * send, so a second press cannot abort a run that has already ended.
 */
interface ComposerRun {
  readonly running: boolean;
  readonly stopped: boolean;
}

export interface ComposerProps {
  /** The draft, owned by the screen so it survives a switch. */
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** Send `value`; called only for non-empty text, and only while not sending. */
  readonly onSend: (text: string) => void;
  /** Stop the run. */
  readonly onStop: () => void;
  /** False while a send is outstanding, so the button cannot start a second one. */
  readonly canSend: boolean;
  /**
   * Whether a run is in flight; it decides which of the two commands the slot holds.
   *
   * @remarks
   * It is the one input that must not wait for the send's answer: the run starts with a
   * `send` and its progress arrives on the socket, so the slot flips to 停止 when the run
   * shows, not when the send is acknowledged.
   */
  readonly running: boolean;
  /** Why sending is blocked, when it is; shown under the field. */
  readonly blockedReason: string | null;
  /** The last send failure, if any; it clears when the text changes. */
  readonly failure: string | null;
  readonly run: ComposerRun;
}

/** Whether a keyboard event is the Enter that sends, rather than a newline or a pick. */
function isSendKey(event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  // An IME's Enter picks a candidate; `isComposing` is not set by every browser, so the key code
  // a composing Enter carries is checked too. Neither means the person meant to send.
  return !composing && event.keyCode !== 229;
}

/**
 * The message field, the send button, and the stop button.
 *
 * @param props - The draft, the two commands, and what the screen knows about the run.
 *
 * @remarks
 * The screen owns the draft text and clears it **before** it calls `onSend`; a failed send puts
 * the text back only if this conversation's field is still empty (the acceptance's rule), which
 * is why the composer has no failure handling of its own.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  canSend,
  running,
  blockedReason,
  failure,
  run,
}: ComposerProps): ReactElement {
  const field = useRef<HTMLTextAreaElement>(null);
  const [composing, setComposing] = useState(false);
  const status = useId();
  const ready = canSend && !running && value.trim() !== "";

  const send = (): void => {
    if (!ready) return;
    onSend(value);
  };

  return (
    <form
      className="hns-composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="hns-sr-only" htmlFor="hns-composer-field">
        メッセージ
      </label>
      <textarea
        id="hns-composer-field"
        ref={field}
        className="hns-composer__field"
        value={value}
        rows={3}
        aria-describedby={blockedReason === null && failure === null ? undefined : status}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onCompositionStart={() => {
          setComposing(true);
        }}
        onCompositionEnd={() => {
          setComposing(false);
        }}
        onKeyDown={(event) => {
          if (!isSendKey(event, composing || event.nativeEvent.isComposing)) return;
          event.preventDefault();
          send();
        }}
      />
      <div className="hns-composer__actions">
        <span className="hns-composer__hint">Enter で送信、Shift+Enter で改行</span>
        {/* One slot for both commands: the stop button is where the send button was. */}
        <span className="hns-composer__submit">
          {running ? (
            <Button
              variant="danger"
              onClick={() => {
                onStop();
              }}
              // Only a run already stopped disables the button: whether the connection can carry
              // the stop is the press's answer (the composer says why), not a disabled button.
              disabled={run.stopped}
              aria-label="停止"
            >
              停止
            </Button>
          ) : (
            <Button type="submit" disabled={!ready} aria-label="送信">
              送信
            </Button>
          )}
        </span>
      </div>
      {blockedReason === null && failure === null ? null : (
        <p
          className="hns-composer__status"
          id={status}
          role={failure === null ? "status" : "alert"}
        >
          {failure ?? blockedReason}
        </p>
      )}
    </form>
  );
}
