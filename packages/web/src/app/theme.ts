import { useCallback, useEffect, useState } from "react";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  system: "システム",
  light: "ライト",
  dark: "ダーク",
};

const STORAGE_KEY = "hns.theme";

export function readTheme(storage: Storage): Theme {
  const value = storage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

/** system removes the override so light-dark() follows the OS (0101). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
}

export function saveTheme(storage: Storage, theme: Theme): void {
  storage.setItem(STORAGE_KEY, theme);
}

export type ThemeChoice = readonly [Theme, (theme: Theme) => void];

export function useTheme(): ThemeChoice {
  const [theme, setTheme] = useState<Theme>(() => readTheme(window.localStorage));

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const choose = useCallback((next: Theme) => {
    setTheme(next);
    saveTheme(window.localStorage, next);
  }, []);

  return [theme, choose] as const;
}
