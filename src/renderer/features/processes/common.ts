import { useEffect, useState } from "react";
import { glide } from "../../lib/glide";
import type { ProcessInfo } from "../../../main/features/processes/parse";
import type { SignalResult } from "../../../main/features/processes";

export type { KillRisk, PortListener, ProcessInfo } from "../../../main/features/processes/parse";
export type { SignalResult };
export { formatKb } from "../../../main/features/processes/parse";

export const procCall = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("processes", method, ...args);

export interface ProcList {
  processes: ProcessInfo[];
  selfPids: number[];
  at: number;
}

/** Polls `fn` every `ms` while mounted (and immediately). */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => void fn().then((v) => alive && setValue(v), () => undefined);
    load();
    const t = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ms, tick, ...deps]);
  return [value, () => setTick((n) => n + 1)];
}

export interface PendingKill {
  pid: number;
  name: string;
  command: string;
  sig: "SIGTERM" | "SIGKILL";
  reason: string;
}
