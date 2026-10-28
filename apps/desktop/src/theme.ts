import { useEffect, useLayoutEffect, useState } from "react";

export type Theme = "light" | "dark";
export const themeStorageKey = "pinhao.appearance.v1";
const systemQuery = "(prefers-color-scheme: dark)";

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(themeStorageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia(systemQuery).matches ? "dark" : "light";
}

export function useTheme() {
  const [preference, setPreference] = useState<Theme | null>(storedTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = preference ?? system;

  useEffect(() => {
    const media = window.matchMedia(systemQuery);
    const updateSystem = () => setSystem(media.matches ? "dark" : "light");
    const updateStorage = (event: StorageEvent) => {
      if (event.key === themeStorageKey || event.key === null) {
        setPreference(storedTheme());
      }
    };
    updateSystem();
    media.addEventListener("change", updateSystem);
    window.addEventListener("storage", updateStorage);
    return () => {
      media.removeEventListener("change", updateSystem);
      window.removeEventListener("storage", updateStorage);
    };
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    void window.pinhao?.setAppearance?.({ theme: preference ?? "system" }).catch(() => {});
  }, [theme, preference]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setPreference(next);
    try {
      localStorage.setItem(themeStorageKey, next);
    } catch {
      // The current window keeps its selection when browser storage is unavailable.
    }
  }

  return { theme, toggleTheme };
}
