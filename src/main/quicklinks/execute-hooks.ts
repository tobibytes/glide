/** Entry points execute.ts calls for quicklink/snippet rows (keeps the shared executor edits to single lines). */
import { clipboard } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { Quicklink, ScoredItem, SearchItem } from "@shared/types";
import type { Store } from "../store";
import { copySnippetById, pasteSnippetById } from "../snippets/feature";
import { extraActionsFor, runExtraAction } from "./feature";
import { openQuicklink, resolveQuicklinkUrl } from "./open";

export { extraActionsFor, runExtraAction };

function quicklinkOf(store: Store, item: SearchItem): Pick<Quicklink, "url" | "openWith"> | undefined {
  const id = item.id.replace(/^quicklink:/, "");
  const q = store.getData().quicklinks.find((x) => x.id === id);
  if (q) return q;
  return item.url ? { url: item.url } : undefined;
}

export async function quicklinkAction(store: Store, item: SearchItem, scored: ScoredItem, actionId: "open" | "copyUrl"): Promise<ExecuteResult> {
  const q = quicklinkOf(store, item);
  if (!q) return { ok: false, error: "Quicklink has no URL" };
  if (actionId === "open") return openQuicklink(q, scored);
  const r = await resolveQuicklinkUrl(q.url, scored);
  if ("error" in r) return { ok: false, error: r.error };
  await clipboard.writeText(r.url);
  return { ok: true, hide: true, message: "URL copied" };
}

/** Paste/Copy with placeholders rendered; undefined when the snippet is not in the store (caller falls back). */
export function snippetAction(item: SearchItem, actionId: "paste" | "copy", hideLauncher: () => void): Promise<ExecuteResult> | undefined {
  const id = item.id.replace(/^snippet:/, "");
  return actionId === "paste" ? pasteSnippetById(id, hideLauncher) : copySnippetById(id);
}

export type { ItemAction };
