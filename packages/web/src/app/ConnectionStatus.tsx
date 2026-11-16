import type { ReactElement } from "react";
import { CONNECTION_LABELS, type ConnectionState } from "../live/state.ts";

/** The connection states the shell displays. */
export type Connection = ConnectionState;

/**
 * The connection pill.
 *
 * @param connection - The state; it selects the label and the dot color.
 * @param detail - A sentence for the tooltip and the accessible name. It is not rendered as
 * text, so compact chrome does not grow; `LiveConnection` shows it visibly.
 */
export function ConnectionStatus({
  connection,
  detail,
}: {
  readonly connection: Connection;
  readonly detail?: string | undefined;
}): ReactElement {
  const label = CONNECTION_LABELS[connection];
  return (
    <span
      className="hns-connection"
      data-state={connection}
      role="status"
      title={detail}
      aria-label={detail === undefined ? label : label + "。" + detail}
    >
      <span className="hns-connection__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
