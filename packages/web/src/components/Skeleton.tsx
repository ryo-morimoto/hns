import type { CSSProperties, ReactElement } from "react";
import { classNames } from "../design/classNames.ts";

export interface SkeletonProps {
  readonly width?: CSSProperties["width"];
  readonly height?: CSSProperties["height"];
  readonly radius?: "sm" | "lg";
  readonly className?: string;
}

export function Skeleton({
  width = "100%",
  height = 10,
  radius = "sm",
  className,
}: SkeletonProps): ReactElement {
  return (
    <span
      className={classNames("hns-skeleton", radius === "lg" && "hns-skeleton--lg", className)}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
