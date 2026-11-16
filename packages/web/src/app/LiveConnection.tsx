import type { ReactElement } from "react";
import { explainConnection, type LiveConversationState } from "../live/state.ts";
import type { LiveSocketFactory } from "../live/client.ts";
import { useLiveConnection } from "../live/useLiveConnection.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";

/** The presentation-only live status; the hook wrapper renders it. */
function LiveConnectionView({ state }: { readonly state: LiveConversationState }): ReactElement {
  const explanation = explainConnection(state);
  return (
    <div className="hns-live" data-state={state.status}>
      <ConnectionStatus connection={state.status} detail={explanation.detail} />
      <p className="hns-live__detail">{explanation.detail}</p>
    </div>
  );
}

/**
 * The live status for one conversation.
 *
 * @param conversationId - The conversation to follow.
 * @param socket - Test seam; production uses the browser's WebSocket.
 *
 * @remarks
 * This is the component the conversation screen mounts. It deliberately owns the socket: a
 * workspace page does not pay for a subscription it never shows.
 */
export function LiveConnection({
  conversationId,
  socket,
}: {
  readonly conversationId: string;
  readonly socket?: LiveSocketFactory | undefined;
}): ReactElement {
  const state = useLiveConnection(conversationId, socket === undefined ? {} : { socket });
  return <LiveConnectionView state={state} />;
}
