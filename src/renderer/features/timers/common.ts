import { useEffect, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import { glide } from "../../lib/glide";
import type { TimersState } from "../../../main/features/timers";

export const timersCall = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("timers", method, ...args);
export type { ExecuteResult };

/** Live timers state plus a clock that ticks while anything runs (10 Hz for stopwatches). */
export function useTimers(): [TimersState | null, number] {
  const [state, setState] = useState<TimersState | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void timersCall<TimersState>("state").then(setState);
    return glide().onFeatureEvent((e) => {
      if (e.feature === "timers" && e.event === "state") setState(e.payload as TimersState);
    });
  }, []);
  const stopwatchRunning = !!state?.stopwatches.some((s) => s.pausedAt === null);
  const active = !!state && (state.timers.length > 0 || stopwatchRunning);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), stopwatchRunning ? 100 : 500);
    return () => clearInterval(t);
  }, [active, stopwatchRunning]);
  return [state, now];
}
