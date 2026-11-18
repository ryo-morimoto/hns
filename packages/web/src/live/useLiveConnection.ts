import { useEffect, useRef, useState } from "react";
import type { LiveFrame } from "@hns/core";
import {
  browserLiveSocket,
  createLiveClient,
  type LiveClient,
  type LiveSocketFactory,
} from "./client.ts";
import { initialLiveState, type LiveConversationState } from "./state.ts";

/** What {@link useLiveConnection} returns: the state a screen renders, and the client behind it. */
export interface LiveConnection {
  /** The latest state; a new object after every change. */
  readonly state: LiveConversationState;
  /**
   * The controller that carries the connection's commands.
   *
   * @remarks
   * Null on the first pass, before the effect that opens the socket runs, and again while the
   * conversation changes. The owner (the conversation route) hands it to the screen, so one
   * visit has one client and one socket.
   */
  readonly client: LiveClient | null;
}

/** What one conversation's connection needs from its owner. */
export interface LiveConnectionOptions {
  /** Tests pass a fake; production uses the browser's WebSocket. */
  readonly socket?: LiveSocketFactory | undefined;
  /** The project the conversation belongs to; sent so the edge picks that Session object. */
  readonly projectId?: string | undefined;
  /** Receives every parsed frame; the route patches the Relay store here. */
  readonly onFrame?: ((frame: LiveFrame) => void) | undefined;
  /**
   * Whether a connection should be opened at all; defaults to true.
   *
   * @remarks
   * A shell rendered without a socket (every test that does not name one) shows the conversation
   * it reads and no live part. The hook still runs — hooks are unconditional — and this is what
   * keeps it from reaching for the platform's WebSocket behind a test's back.
   */
  readonly enabled?: boolean | undefined;
}

/**
 * Open and keep one conversation's connection for the lifetime of a component.
 *
 * @param conversationId - The decimal conversation id to subscribe to.
 * @param options - The socket factory, the project, and the frame handler.
 * @returns The latest state and the client.
 *
 * @remarks
 * **Exactly one component opens the connection.** The conversation route mounts this and passes
 * the client down; a screen never opens its own, because two clients for one conversation are
 * two subscribers on the object, two reconnects racing, and two rows in whatever counts
 * connections.
 *
 * The controller is created in an effect, so a server render never opens a socket. Leaving the
 * conversation (or unmounting) closes it and cancels a pending retry. The frame handler is read
 * through a ref: a new handler must not reopen the socket. The client is published after the
 * effect and cleared before the next one, so a command from the old connection never reaches
 * the new conversation.
 */
export function useLiveConnection(
  conversationId: string,
  options: LiveConnectionOptions = {},
): LiveConnection {
  const socket = options.socket;
  const projectId = options.projectId;
  const onFrame = options.onFrame;
  const enabled = options.enabled ?? true;
  const [state, setState] = useState(initialLiveState);
  const [client, setClient] = useState<LiveClient | null>(null);
  const frameHandler = useRef(onFrame);

  useEffect(() => {
    frameHandler.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    if (!enabled) return;
    const created = createLiveClient({
      conversationId,
      projectId,
      socket: socket ?? browserLiveSocket,
      onFrame: (frame) => {
        frameHandler.current?.(frame);
      },
    });
    const unsubscribe = created.subscribe(setState);
    setState(created.state);
    setClient(created);
    return () => {
      unsubscribe();
      created.close();
      setClient(null);
    };
  }, [conversationId, projectId, socket, enabled]);

  return { state, client };
}
