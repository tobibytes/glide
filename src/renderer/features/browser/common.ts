import { useEffect, useState } from "react";
import { glide } from "../../lib/glide";
import type { BrowserRow, BrowserStatus } from "../../../main/features/browser";

export type { BrowserRow, BrowserStatus };
export const browserCall = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("browser", method, ...args);

/** Index status, refreshed whenever main finishes a background refresh. */
export function useBrowserStatus(): [BrowserStatus | null, (s: BrowserStatus) => void] {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  useEffect(() => {
    void browserCall<BrowserStatus>("status").then(setStatus);
    return glide().onFeatureEvent((e) => {
      if (e.feature === "browser" && e.event === "status") setStatus(e.payload as BrowserStatus);
    });
  }, []);
  return [status, setStatus];
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}
