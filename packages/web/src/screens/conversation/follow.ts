/**
 * How close to the bottom still counts as reading the end of the transcript.
 *
 * @remarks
 * A reader within this many pixels of the end has not scrolled away, and a layout that rounds
 * its scroll height would otherwise drop them into "reading".
 */
export const FOLLOW_SLACK_PX = 24;

/** Where the reader is in the transcript. */
export type FollowState = "following" | "reading";

/** The numbers a scroll container reports, as far as following cares. */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Whether the reader is at (or near) the end.
 *
 * @param metrics - The container's scroll position and sizes.
 * @returns `following` when new text should move the view, `reading` when it must not.
 *
 * @remarks
 * A container that does not overflow is always at its end, so it always follows. A container
 * that has not been laid out (every size zero) counts as at its end for the same reason: there is
 * nothing above the reader to lose.
 */
export function followOf(metrics: ScrollMetrics): FollowState {
  const fromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return fromBottom <= FOLLOW_SLACK_PX ? "following" : "reading";
}

/**
 * The scroll offset that shows the newest line.
 *
 * @param metrics - The container's numbers.
 * @returns The offset to set.
 */
export function bottomOffset(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}
