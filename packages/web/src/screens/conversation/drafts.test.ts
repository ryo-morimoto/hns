import { beforeEach, expect, test } from "vitest";
import {
  browserDraftStorage,
  draftKey,
  readDraft,
  writeDraft,
  type DraftStorage,
} from "./drafts.ts";

/** An in-memory store that behaves like local storage for these three methods. */
function memoryStorage(): DraftStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

// Catches: two conversations sharing one draft, which overwrites what a person was writing.
test("a draft belongs to one conversation", () => {
  const storage = memoryStorage();
  writeDraft(storage, "a", "for a");
  writeDraft(storage, "b", "for b");
  expect(readDraft(storage, "a")).toBe("for a");
  expect(readDraft(storage, "b")).toBe("for b");
  expect(readDraft(storage, "c")).toBe("");
  expect(draftKey("a")).not.toBe(draftKey("b"));
});

// Catches: an emptied draft left as an empty key, so the store grows one key per visit.
test("an empty draft removes the key instead of storing emptiness", () => {
  const storage = memoryStorage();
  writeDraft(storage, "a", "typed");
  writeDraft(storage, "a", "");
  expect(storage.map.has(draftKey("a"))).toBe(false);
  expect(readDraft(storage, "a")).toBe("");
});

// Catches: a store that refuses a write taking the screen down with it.
test("a refusing store is treated as one that forgot", () => {
  const refusing: DraftStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  expect(readDraft(refusing, "a")).toBe("");
  expect(() => {
    writeDraft(refusing, "a", "x");
  }).not.toThrow();
  expect(readDraft(null, "a")).toBe("");
  expect(() => {
    writeDraft(null, "a", "x");
  }).not.toThrow();
});

// Catches: the browser store being replaced by a stub in the production path.
test("the production store is the browser's local storage", () => {
  const storage = browserDraftStorage();
  expect(storage).not.toBeNull();
  writeDraft(storage, "a", "kept");
  expect(window.localStorage.getItem(draftKey("a"))).toBe("kept");
  expect(readDraft(browserDraftStorage(), "a")).toBe("kept");
});
