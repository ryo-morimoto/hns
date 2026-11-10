import { expect, test } from "vitest";
import { applyTheme, readTheme, saveTheme } from "./theme.ts";

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
  expect(readTheme(storage)).toBe("system");

  saveTheme(storage, "dark");
  expect(readTheme(storage)).toBe("dark");

  storage.setItem("hns.theme", "blue");
  expect(readTheme(storage)).toBe("system");
});

// Catches: system keeping a stale data-theme, so the OS preference stops applying.
test("applying system removes the override", () => {
  const root = document.createElement("html");

  applyTheme("dark", root);
  expect(root.dataset["theme"]).toBe("dark");

  applyTheme("system", root);
  expect(root.dataset["theme"]).toBe(undefined);
});
