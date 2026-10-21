import { useEffect } from "react";
import type { Settings } from "@shared/types";

/** Mirrors settings.theme onto <html data-theme>; "system" removes the attribute so prefers-color-scheme wins. */
export function useTheme(theme: Settings["theme"] | undefined): void {
  useEffect(() => {
    const el = document.documentElement;
    if (!theme || theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
  }, [theme]);
}
