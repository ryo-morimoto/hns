import { type ReactElement } from "react";
import { explainConnection, type LiveConversationState } from "../live/state.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";

/**
 * The status line for one conversation's connection.
 *
 * @param state - The live state the route's client publishes.
 * @param label - True to show the short state name beside the sentence.
 *
 * @remarks
 * This component **does not open a connection**. The conversation route owns the one
 * `LiveClient` a visit has (its frames also patch the sidebar's title), and the connection's
 * state is handed to it; a second opener here is how one visit came to have two sockets.
 */
export function LiveConnection({
  state,
  label = false,
}: {
  readonly state: LiveConversationState;
  readonly label?: boolean;
}): ReactElement {
  return (
    <div className="hns-live" data-state={state.status}>
      {label ? <ConnectionStatus connection={state.status} /> : null}
      <p className="hns-live__detail">{explainConnection(state).detail}</p>
    </div>
  );
}
