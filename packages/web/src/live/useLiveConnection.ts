import { useEffect, useRef, useState } from "react";
import type { LiveFrame, LiveSendResult } from "@hns/core";
import {
  browserLiveSocket,
  createLiveClient,
  type LiveClient,
  type LiveSocketFactory,
} from "./client.ts";
import { initialLiveState, type LiveConversationState } from "./state.ts";

/** Options for the React binding. */
export interface LiveConnectionOptions {
  /** Tests pass a fake; production uses the browser's WebSocket. */
  readonly socket?: LiveSocketFactory | undefined;
  /** The project the conversation belongs to; sent so the edge picks that Session object. */
  readonly projectId?: string | undefined;
  /** Receives every parsed frame; the conversation screen patches the Relay store here. */
  readonly onFrame?: ((frame: LiveFrame) => void) | undefined;
  /** Receives every send answer; the conversation screen decides what to say. */
  readonly onSendResult?: ((result: LiveSendResult) => void) | undefined;
}

/** What {@link useLiveConnection} returns: the state a screen renders, and the client behind it. */
export interface LiveConnection {
  /** The latest state; a new object after every change. */
  readonly state: LiveConversationState;
  /**
   * The controller that carries commands.
   *
   * @remarks
   * Null on the first pass, before the effect that opens the socket runs, and again while the
   * conversation changes. A screen disables its composer meanwhile instead of guessing.
   */
  readonly client: LiveClient | null;
}

/**
 * Keep one conversation's live state, and the client that carries its commands, for the
 * lifetime of a component.
 *
 * @param conversationId - The decimal conversation id to subscribe to.
 * @param options - An optional socket factory, project, frame handler, and send-answer handler.
 * @returns The latest state and the live client.
 *
 * @remarks
 * The controller is created in an effect, so a server render never opens a socket. Leaving the
 * conversation (or unmounting) closes it and cancels a pending retry. The frame and answer
 * handlers are read through refs: a new handler must not reopen the socket. The client is
 * published after the effect, and cleared before the next one, so a command from the old
 * connection never reaches the new conversation.
 */
export function useLiveConnection(
  conversationId: string,
  options: LiveConnectionOptions = {},
): LiveConnection {
  const socket = options.socket;
  const projectId = options.projectId;
  const onFrame = options.onFrame;
  const onSendResult = options.onSendResult;
  const [state, setState] = useState(initialLiveState);
  const [client, setClient] = useState<LiveClient | null>(null);
  const frameHandler = useRef(onFrame);
  const answerHandler = useRef(onSendResult);

  useEffect(() => {
    frameHandler.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    answerHandler.current = onSendResult;
  }, [onSendResult]);

  useEffect(() => {
    const created = createLiveClient({
      conversationId,
      projectId,
      socket: socket ?? browserLiveSocket,
      onFrame: (frame) => {
        frameHandler.current?.(frame);
      },
    });
    const unsubscribe = created.subscribe(setState);
    const unsubscribeAnswers = created.onSendResult((result) => {
      answerHandler.current?.(result);
    });
    setState(created.state);
    setClient(created);
    return () => {
      unsubscribe();
      unsubscribeAnswers();
      created.close();
      setClient(null);
    };
  }, [conversationId, projectId, socket]);

  return { state, client };
}
