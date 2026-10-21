import { glide } from "../../lib/glide";
export type { DestinationRow, FinderSettings, FinderSettingsState } from "../../../main/features/finder/types";

export const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("finder", method, ...args);
export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "/";
export const tilde = (p: string, home?: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);

export interface OpResult {
  ok: boolean;
  error?: string;
  path?: string;
  moved?: Array<{ from: string; to: string }>;
  skipped?: number;
  hide?: boolean;
}
