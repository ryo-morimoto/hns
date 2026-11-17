import { useEffect, useRef, type ReactElement } from "react";
import { useRelayEnvironment } from "react-relay";
import { explainConnection, type LiveConversationState } from "../live/state.ts";
import type { LiveSocketFactory } from "../live/client.ts";
import { applyLiveFrameToStore, forgetLiveTitle } from "../live/store.ts";
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
 * @param projectId - The project that owns the conversation; the edge addresses its Session object.
 * @param socket - Test seam; production uses the browser's WebSocket.
 * @param onReconnect - Called when a dropped connection is healthy again.
 *
 * @remarks
 * This is the component the conversation screen mounts. It deliberately owns the socket: a
 * workspace page does not pay for a subscription it never shows. The frames also patch the
 * Relay store (the conversation's title in the sidebar's list); a reconnect reports upward so
 * the open screen can refetch what the socket does not carry, such as conversations added
 * while the connection was down.
 */
export function LiveConnection({
  conversationId,
  projectId,
  socket,
  onReconnect,
}: {
  readonly conversationId: string;
  readonly projectId?: string | undefined;
  readonly socket?: LiveSocketFactory | undefined;
  readonly onReconnect?: (() => void) | undefined;
}): ReactElement {
  const environment = useRelayEnvironment();
  const state = useLiveConnection(conversationId, {
    projectId,
    socket,
    onFrame: (frame) => {
      applyLiveFrameToStore(environment, frame);
    },
  });
  const previous = useRef(state.status);

  useEffect(() => {
    return () => {
      forgetLiveTitle(environment, conversationId);
    };
  }, [environment, conversationId]);

  useEffect(() => {
    const reconnected = previous.current === "reconnecting" && state.status === "online";
    previous.current = state.status;
    if (reconnected) onReconnect?.();
  }, [state.status, onReconnect]);

  return <LiveConnectionView state={state} />;
}
