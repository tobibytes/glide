import { useMemo } from "react";
import type { ViewRequest } from "@shared/ipc";
import { resolveView } from "../../features/registry";

/** One entry of the launcher's navigation stack. */
export interface ViewEntry {
  key: number;
  id: string;
  props: Record<string, unknown>;
  /** search-field text while this view is on top */
  query: string;
  placeholder: string;
  title: string;
}

export interface LauncherApi {
  updateEntry(key: number, patch: Partial<Pick<ViewEntry, "query" | "placeholder">>): void;
  push(view: ViewRequest): void;
  pop(): void;
  close(): void;
  toast(message: string, kind?: "info" | "error"): void;
}

/** props.title, else the title of the item that opened it, else "clipboard.history" → "Clipboard History". */
export function viewTitle(req: ViewRequest, hint?: string): string {
  const t = req.props?.title;
  if (typeof t === "string" && t.trim()) return t;
  if (hint) return hint;
  return req.id
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).replace(/([a-z])([A-Z])/g, "$1 $2"))
    .join(" ");
}

/** Renders the top view with ViewProps bound to the launcher (callbacks are stable per entry). */
export function ViewHost({ entry, api }: { entry: ViewEntry; api: LauncherApi }) {
  const Comp = resolveView(entry.id);
  const { key } = entry;
  const bound = useMemo(
    () => ({
      setQuery: (q: string) => api.updateEntry(key, { query: q }),
      setPlaceholder: (p: string) => api.updateEntry(key, { placeholder: p }),
      push: api.push,
      pop: api.pop,
      close: api.close,
      toast: api.toast,
    }),
    [key, api],
  );
  if (!Comp) return <div className="launcher__empty">This feature isn't available yet</div>;
  return <Comp props={entry.props} query={entry.query} {...bound} />;
}
