import { useCallback, useEffect, useState } from "react";
import { glide } from "../../lib/glide";
import type { LayoutsState } from "../../../main/features/layouts/index";
import type { AppRef, Layout, Workspace } from "../../../main/features/layouts/model";

export type { AppRef, Layout, LayoutsState, Workspace };
export type LayoutSummary = LayoutsState["layouts"][number];
export type WorkspaceSummary = LayoutsState["workspaces"][number];

export const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("layouts", method, ...args);

export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

/** Live layouts state; refreshes on the feature's "changed" event. */
export function useLayouts(): [LayoutsState | null, () => void] {
  const [state, setState] = useState<LayoutsState | null>(null);
  const refresh = useCallback(() => void call<LayoutsState>("state").then(setState), []);
  useEffect(() => {
    refresh();
    return glide().onFeatureEvent((e) => {
      if (e.feature === "layouts" && e.event === "changed") refresh();
    });
  }, [refresh]);
  return [state, refresh];
}

/** Windows grouped by app for detail panes. */
export function groupByApp(layout: Pick<Layout, "windows">): Array<{ app: string; titles: string[] }> {
  const m = new Map<string, string[]>();
  for (const w of layout.windows) {
    const list = m.get(w.appName) ?? [];
    list.push(w.title || "Untitled window");
    m.set(w.appName, list);
  }
  return [...m].map(([app, titles]) => ({ app, titles }));
}

export function ago(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
