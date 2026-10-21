import { useEffect, useState } from "react";
import { glide } from "../../lib/glide";
import type { FocusState } from "../../../main/features/focus/types";

export const focusCall = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("focus", method, ...args);

/** Live focus state (refreshed by "state" events and a 1 s clock while a session runs). */
export function useFocusState(): [FocusState | null, (s: FocusState) => void] {
  const [state, setState] = useState<FocusState | null>(null);
  useEffect(() => {
    void focusCall<FocusState>("state").then(setState);
    return glide().onFeatureEvent((e) => {
      if (e.feature === "focus" && e.event === "state") setState(e.payload as FocusState);
    });
  }, []);
  const running = state?.session?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void focusCall<FocusState>("state").then(setState), 1_000);
    return () => clearInterval(t);
  }, [running]);
  return [state, setState];
}

/** "45m write report" / "1h deep work" / "30" → minutes + goal. */
export function parseDurationPrefix(text: string): { minutes: number; goal: string } | null {
  const m = text.trim().match(/^(\d{1,3}(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?)?(?:\s+(.*))?$/i);
  if (!m) return null;
  if (!m[2] && m[3]) return null; // "3 little pigs" is a goal, not a duration
  const n = Number(m[1]);
  const minutes = m[2] && /^h/i.test(m[2]) ? n * 60 : n;
  if (!minutes || minutes > 24 * 60) return null;
  return { minutes: Math.round(minutes), goal: (m[3] ?? "").trim() };
}
