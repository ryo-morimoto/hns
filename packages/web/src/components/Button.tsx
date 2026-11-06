import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { classNames } from "../design/classNames.ts";

const BUTTON_VARIANTS = ["primary", "ghost", "danger", "icon"] as const;
type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "children"
> {
  readonly variant?: ButtonVariant;
  /** Spins, sets aria-busy, and refuses the press; the label stays readable. */
  readonly loading?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Button({
  variant = "primary",
  loading = false,
  disabled = false,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      {...rest}
      type={type}
      className={classNames(
        "hns-button",
        `hns-button--${variant}`,
        loading && "hns-button--loading",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      {loading ? <span className="hns-button__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
