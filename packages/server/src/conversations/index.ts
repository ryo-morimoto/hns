/**
 * The conversations face (0119): one conversation's metadata, and its Session state.
 *
 * @remarks
 * The D1 `conversations` row is the book (D078); the Session object is asked only for the state
 * that lives on it.
 */
export { createConversationsFace, lookupConversation } from "./face.ts";
