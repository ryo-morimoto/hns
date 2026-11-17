import type { LiveFrame } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { commitLocalUpdate, type Environment } from "relay-runtime";

/**
 * Write one live frame's list fields into the Relay store.
 *
 * @param environment - The environment the screens read from.
 * @param frame - A frame the protocol accepted.
 *
 * @remarks
 * The socket is the only channel that carries a conversation's current title, and the sidebar's
 * fragment reads that field from the store. A snapshot is the frame that carries it; append,
 * delta, pong, and error change no list field, so they leave the store alone. A snapshot for a
 * conversation the list has not loaded creates nothing: the frame is not a substitute for the
 * read that names the conversation.
 */
export function applyLiveFrameToStore(environment: Environment, frame: LiveFrame): void {
  if (frame.type !== "snapshot" || frame.title === "") return;
  const dataId = toGlobalId("Conversation", frame.conversationId);
  commitLocalUpdate(environment, (store) => {
    const record = store.get(dataId);
    if (record === null || record === undefined) return;
    if (record.getValue("title") === frame.title) return;
    record.setValue(frame.title, "title");
  });
}
