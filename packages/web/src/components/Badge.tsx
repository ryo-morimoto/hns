import type { ReactElement, ReactNode } from "react";
import { classNames } from "../design/classNames.ts";

const BADGE_TONES = ["neutral", "accent", "ok", "warn", "danger"] as const;
type BadgeTone = (typeof BADGE_TONES)[number];

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Badge({ tone = "neutral", className, children }: BadgeProps): ReactElement {
  return (
    <span className={classNames("hns-badge", `hns-badge--${tone}`, className)}>{children}</span>
  );
}
