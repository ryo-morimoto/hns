import assert from "node:assert/strict";
import { test } from "vitest";
import { applyTheme, readTheme, saveTheme } from "../../src/app/theme.ts";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test("the stored theme round-trips and rejects unknown values", () => {
  const storage = memoryStorage();
  assert.equal(readTheme(storage), "system");

  saveTheme(storage, "dark");
  assert.equal(readTheme(storage), "dark");

  storage.setItem("hns.theme", "blue");
  assert.equal(readTheme(storage), "system");
});

// Catches: system keeping a stale data-theme, so the OS preference stops applying.
test("applying system removes the override", () => {
  const root = document.createElement("html");

  applyTheme("dark", root);
  assert.equal(root.dataset["theme"], "dark");

  applyTheme("system", root);
  assert.equal(root.dataset["theme"], undefined);
});
