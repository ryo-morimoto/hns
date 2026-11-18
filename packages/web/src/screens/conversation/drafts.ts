/**
 * The storage key prefix the drafts live under, one key per conversation.
 *
 * @remarks
 * One key per conversation rather than one map: two tabs on two conversations then write two
 * keys instead of overwriting each other's whole map, which is the failure a single key has.
 */
const DRAFT_KEY_PREFIX = "hns.conversation.draft:";

/** The key one conversation's draft is kept under. */
export function draftKey(conversationId: string): string {
  return DRAFT_KEY_PREFIX + conversationId;
}

/**
 * The slice of `Storage` the drafts need.
 *
 * @remarks
 * Structural, so the screen can be handed a working store in tests and production can hand it
 * the browser's. A store that throws (a disabled cookie jar, a full quota) is treated as one that
 * forgot: the draft is then only in memory for this visit.
 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Read one conversation's draft; empty when there is none or the store refuses. */
export function readDraft(storage: DraftStorage | null, conversationId: string): string {
  if (storage === null) return "";
  try {
    return storage.getItem(draftKey(conversationId)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Keep one conversation's draft.
 *
 * @param storage - Where it goes; null keeps it nowhere but in memory.
 * @param conversationId - The conversation the text belongs to.
 * @param text - The draft; empty removes the key instead of storing an empty string.
 *
 * @remarks
 * Removing an empty draft keeps the store from growing one key per conversation that was
 * opened and left, and it makes "there is no draft" one state rather than two.
 */
export function writeDraft(
  storage: DraftStorage | null,
  conversationId: string,
  text: string,
): void {
  if (storage === null) return;
  try {
    if (text === "") {
      storage.removeItem(draftKey(conversationId));
      return;
    }
    storage.setItem(draftKey(conversationId), text);
  } catch {
    // A refused write leaves the earlier draft; the text on screen is still the text.
  }
}

/** The browser's local storage, or null where the platform has none (a server render, a test). */
export function browserDraftStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
