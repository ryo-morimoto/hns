import { useEffect, useRef, useState } from "react";
import type { LiveFrame } from "@hns/core";
import { browserLiveSocket, createLiveClient, type LiveSocketFactory } from "./client.ts";
import { initialLiveState, type LiveConversationState } from "./state.ts";

/** Options for the React binding. */
export interface LiveConnectionOptions {
  /** Tests pass a fake; production uses the browser's WebSocket. */
  readonly socket?: LiveSocketFactory | undefined;
  /** The project the conversation belongs to; sent so the edge picks that Session object. */
  readonly projectId?: string | undefined;
  /** Receives every parsed frame; the conversation screen patches the Relay store here. */
  readonly onFrame?: ((frame: LiveFrame) => void) | undefined;
}

/**
 * Keep one conversation's live state for the lifetime of a component.
 *
 * @param conversationId - The decimal conversation id to subscribe to.
 * @param options - An optional socket factory, project, and frame handler.
 * @returns The latest state; it starts at `connecting`.
 *
 * @remarks
 * The controller is created in an effect, so a server render never opens a socket. Leaving the
 * conversation (or unmounting) closes it and cancels a pending retry. The frame handler is read
 * through a ref: a new handler must not reopen the socket.
 */
export function useLiveConnection(
  conversationId: string,
  options: LiveConnectionOptions = {},
): LiveConversationState {
  const socket = options.socket;
  const projectId = options.projectId;
  const onFrame = options.onFrame;
  const [state, setState] = useState(initialLiveState);
  const frameHandler = useRef(onFrame);

  useEffect(() => {
    frameHandler.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    const client = createLiveClient({
      conversationId,
      projectId,
      socket: socket ?? browserLiveSocket,
      onFrame: (frame) => {
        frameHandler.current?.(frame);
      },
    });
    const unsubscribe = client.subscribe(setState);
    setState(client.state);
    return () => {
      unsubscribe();
      client.close();
    };
  }, [conversationId, projectId, socket]);

  return state;
}
