import type { ExecuteResult } from "@shared/ipc";
import type { NavAction } from "../types";
import type { ViewProps } from "../types";
import { fileIndex, type FileHitDTO } from "./api";

export const FILE_ACTIONS: Array<{ id: string; title: string; shortcut: string; destructive?: boolean }> = [
  { id: "open", title: "Open", shortcut: "⏎" },
  { id: "reveal", title: "Show in Finder", shortcut: "⌘⏎" },
  { id: "openWith", title: "Open With…", shortcut: "⌘O" },
  { id: "copyPath", title: "Copy Path", shortcut: "⇧⌘C" },
  { id: "copyFile", title: "Copy File", shortcut: "⇧⌘." },
  { id: "quickLook", title: "Quick Look", shortcut: "⌘Y" },
  { id: "trash", title: "Move to Trash", shortcut: "⌃X", destructive: true },
];

export function handleResult(r: ExecuteResult, view: Pick<ViewProps, "push" | "close" | "toast">): void {
  if (!r.ok) {
    view.toast(r.error ?? "Action failed", "error");
    return;
  }
  if (r.view) view.push(r.view);
  else if (r.hide) view.close();
  if (r.message) view.toast(r.message);
}

export async function runAction(hit: FileHitDTO, actionId: string, view: Pick<ViewProps, "push" | "close" | "toast">, after?: (id: string, r: ExecuteResult) => void): Promise<void> {
  try {
    const r = await fileIndex.action(hit.path, actionId);
    handleResult(r, view);
    after?.(actionId, r);
  } catch (err) {
    view.toast(err instanceof Error ? err.message : String(err), "error");
  }
}

export function navActions(hit: FileHitDTO, view: Pick<ViewProps, "push" | "close" | "toast">, after?: (id: string, r: ExecuteResult) => void): NavAction[] {
  return FILE_ACTIONS.map((a) => ({ ...a, run: () => runAction(hit, a.id, view, after) }));
}
