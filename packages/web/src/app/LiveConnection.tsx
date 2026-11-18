import { useEffect, useRef, type ReactElement } from "react";
import { useRelayEnvironment } from "react-relay";
import type { Environment as RelayEnvironment } from "relay-runtime";

import type { LiveSendResult } from "@hns/core";
import { explainConnection, type LiveConversationState } from "../live/state.ts";
import type { LiveClient, LiveSocketFactory } from "../live/client.ts";
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
 * @param onReady - Called with the client once the connection exists, so the screen can send.
 * @param onSendResult - Called with every answer to a send the screen made.
 * @param children - Rendered instead of the bare status, with the live state, when a screen
 * needs more than the status line; the client arrives through `onReady`, not through this.
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
  onReady,
  onSendResult,
  onState,
  children,
  environment: given,
}: {
  readonly conversationId: string;
  readonly projectId?: string | undefined;
  readonly socket?: LiveSocketFactory | undefined;
  readonly onReconnect?: (() => void) | undefined;
  readonly onReady?: ((client: LiveClient) => void) | undefined;
  readonly onSendResult?: ((result: LiveSendResult) => void) | undefined;
  readonly children?:
    | ((connection: { readonly state: LiveConversationState }) => ReactElement)
    | undefined;
  /** Receives the live state on every change, for a screen that renders more than the status. */
  readonly onState?: ((state: LiveConversationState) => void) | undefined;
  /** The environment whose store the frames patch; defaults to the one this render is under. */
  readonly environment?: RelayEnvironment | undefined;
}): ReactElement {
  const ambient = useRelayEnvironment();
  const environment = given ?? ambient;
  const connection = useLiveConnection(conversationId, {
    projectId,
    socket,
    onSendResult,
    onFrame: (frame) => {
      applyLiveFrameToStore(environment, frame);
    },
  });
  const previous = useRef(connection.state.status);
  const ready = onReady;
  const client = connection.client;

  useEffect(() => {
    if (client === null) return;
    ready?.(client);
  }, [client, ready]);

  const report = onState;
  useEffect(() => {
    report?.(connection.state);
  }, [report, connection.state]);

  useEffect(() => {
    return () => {
      forgetLiveTitle(environment, conversationId);
    };
  }, [environment, conversationId]);

  useEffect(() => {
    const reconnected = previous.current === "reconnecting" && connection.state.status === "online";
    previous.current = connection.state.status;
    if (reconnected) onReconnect?.();
  }, [connection.state.status, onReconnect]);

  return children === undefined ? (
    <LiveConnectionView state={connection.state} />
  ) : (
    children({ state: connection.state })
  );
}
