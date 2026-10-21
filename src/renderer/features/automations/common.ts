import { useEffect, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import { glide } from "../../lib/glide";
import type { AutomationsState, RunRecord } from "../../../main/features/automations/model";

export const automationsCall = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("automations", method, ...args);
export type { ExecuteResult };

/** Live automations state (pushed by main on every change) plus a 1 Hz clock for "in 3 min" labels. */
export function useAutomations(): [AutomationsState | null, number] {
  const [state, setState] = useState<AutomationsState | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void automationsCall<AutomationsState>("state").then(setState);
    const off = glide().onFeatureEvent((e) => {
      if (e.feature === "automations" && e.event === "state") setState(e.payload as AutomationsState);
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return [state, now];
}

export function relTime(at: number, now: number): string {
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  const unit = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)} min` : abs < 86400 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} d`;
  if (abs < 2) return "now";
  return s > 0 ? `in ${unit}` : `${unit} ago`;
}

export function clock(at: number): string {
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export const STATUS_ICON: Record<RunRecord["status"], string> = { ok: "✅", error: "⚠️", skipped: "⏭️" };
