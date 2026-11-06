import type { ReactElement } from "react";
import { classNames } from "../design/classNames.ts";

const ICON_NAMES = ["close", "chevron-down", "check", "alert"] as const;
type IconName = (typeof ICON_NAMES)[number];

/** The only sizes the design system allows. */
const ICON_SIZES = [12, 14, 16] as const;
type IconSize = (typeof ICON_SIZES)[number];

/** Every path lives here; a new icon is a new key, not a file. */
const PATHS: Record<IconName, string> = {
  close: "M4 4l8 8M12 4l-8 8",
  "chevron-down": "M4 6.5L8 10.5L12 6.5",
  check: "M3.5 8.5L6.5 11.5L12.5 5",
  alert: "M8 3.5v5.5M8 12v.5",
};

export interface IconProps {
  readonly name: IconName;
  readonly size?: IconSize;
  /** Omit for decorative icons; a label turns the icon into an image. */
  readonly label?: string;
  readonly className?: string;
}

export function Icon({ name, size = 14, label, className }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={classNames("hns-icon", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
