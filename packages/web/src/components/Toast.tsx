import type { ReactElement } from "react";
import { classNames } from "../design/classNames.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

const TOAST_TONES = ["info", "error"] as const;
type ToastTone = (typeof TOAST_TONES)[number];

interface ToastActionSpec {
  readonly label: string;
  readonly onSelect: () => void;
}

export interface ToastProps {
  readonly tone?: ToastTone;
  readonly message: string;
  readonly action?: ToastActionSpec;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

/**
 * A presentational toast: status for information, alert for errors. The queue that
 * places it lives with the app shell; Base UI's Toast is a dialog-roled manager.
 */
export function Toast({
  tone = "info",
  message,
  action,
  onDismiss,
  className,
}: ToastProps): ReactElement {
  return (
    <div
      className={classNames("hns-toast", `hns-toast--${tone}`, className)}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon name={tone === "error" ? "alert" : "check"} size={14} className="hns-toast__icon" />
      <span className="hns-toast__message">{message}</span>
      {action === undefined ? null : (
        <Button variant="ghost" onClick={action.onSelect}>
          {action.label}
        </Button>
      )}
      {onDismiss === undefined ? null : (
        <Button variant="icon" aria-label="閉じる" onClick={onDismiss}>
          <Icon name="close" size={12} />
        </Button>
      )}
    </div>
  );
}
