import type { LiveFrame } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { commitLocalUpdate, type Environment } from "relay-runtime";
import * as v from "valibot";

/** The live title each conversation's socket has reported, per environment. */
const liveTitles = new WeakMap<Environment, Map<string, string>>();

/** The live titles of one environment, created on first use. */
function titlesOf(environment: Environment): Map<string, string> {
  const existing = liveTitles.get(environment);
  if (existing !== undefined) return existing;
  const created = new Map<string, string>();
  liveTitles.set(environment, created);
  return created;
}

/** The title the store holds for a conversation, read without opening a record proxy. */
function storedTitle(environment: Environment, conversationId: string): string | undefined {
  const record = environment.getStore().getSource().get(toGlobalId("Conversation", conversationId));
  // The source holds scalars by field name; the parse keeps any other shape out of the title.
  const parsed = v.safeParse(v.string(), record?.["title"]);
  return parsed.success ? parsed.output : undefined;
}

/** Write one title, unless the store already holds it. */
function writeTitle(environment: Environment, conversationId: string, title: string): void {
  const dataId = toGlobalId("Conversation", conversationId);
  commitLocalUpdate(environment, (store) => {
    const record = store.get(dataId);
    if (record === null || record === undefined) return;
    if (record.getValue("title") === title) return;
    record.setValue(title, "title");
  });
}

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
 * read that names the conversation. A title is a plain string, so an empty one is written like
 * any other; the server's value is the truth.
 *
 * The title is also kept per conversation, because a later list read normalizes the server's
 * older value over it. {@link reapplyLiveTitles} puts it back once that read lands.
 */
export function applyLiveFrameToStore(environment: Environment, frame: LiveFrame): void {
  if (frame.type !== "snapshot") return;
  titlesOf(environment).set(frame.conversationId, frame.title);
  writeTitle(environment, frame.conversationId, frame.title);
}

/**
 * Re-apply the titles the sockets reported after a list read normalized over them.
 *
 * @param environment - The environment the screens read from.
 *
 * @remarks
 * A reconnect refetches the list (the socket does not carry conversations added while it was
 * down), and the response carries the title the server had when that read began. The live
 * snapshot is newer, so it wins until the socket reports another one or closes. Only titles the
 * store no longer holds are written, so calling this after every list render costs nothing.
 */
export function reapplyLiveTitles(environment: Environment): void {
  const titles = liveTitles.get(environment);
  if (titles === undefined) return;
  for (const [conversationId, title] of titles) {
    if (storedTitle(environment, conversationId) !== title) {
      writeTitle(environment, conversationId, title);
    }
  }
}

/**
 * Drop one conversation's live title.
 *
 * @param environment - The environment the screens read from.
 * @param conversationId - The conversation whose subscription is ending.
 *
 * @remarks
 * Called when the conversation screen unmounts. Without it a snapshot title would outlive the
 * connection and win over every later read, including a rename made elsewhere.
 */
export function forgetLiveTitle(environment: Environment, conversationId: string): void {
  liveTitles.get(environment)?.delete(conversationId);
}
