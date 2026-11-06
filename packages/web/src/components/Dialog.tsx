import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactElement, ReactNode } from "react";
import { Button } from "./Button.tsx";

export interface DialogProps {
  readonly trigger: ReactElement;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
}

/**
 * A modal dialog on Base UI: focus trap, Esc, and focus restore are the library's, not ours
 * (0101). Styling is the hns primitives' class contract.
 */
export function Dialog({
  trigger,
  title,
  description,
  children,
  footer,
}: DialogProps): ReactElement {
  return (
    <BaseDialog.Root>
      <BaseDialog.Trigger render={trigger} />
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="hns-dialog-backdrop" />
        <BaseDialog.Popup className="hns-dialog-popup">
          <BaseDialog.Title className="hns-dialog-title">{title}</BaseDialog.Title>
          {description === undefined ? null : (
            <BaseDialog.Description className="hns-dialog-description">
              {description}
            </BaseDialog.Description>
          )}
          {children === undefined ? null : <div className="hns-dialog-body">{children}</div>}
          <div className="hns-dialog-footer">
            {footer}
            <BaseDialog.Close render={<Button variant="ghost">閉じる</Button>} />
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
