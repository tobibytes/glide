/** Typed wrappers over window.glide.feature("clipboard", …). */
import type { ExecuteResult } from "@shared/ipc";
import type { ClipEntry, ClipFilter, ClipSettings, ClipStats, ClipSummary, SourceSummary } from "../../../main/features/clipboard/model";
import type { StackOrder } from "../../../main/features/clipboard/stack";
import { glide } from "../../lib/glide";

export type { ClipEntry, ClipFilter, ClipSettings, ClipStats, ClipSummary, SourceSummary, StackOrder };

const call = <T>(method: string, ...args: unknown[]) => glide().feature<T>("clipboard", method, ...args);

export interface SettingsResult {
  settings: ClipSettings;
  hotkeyOk: boolean;
  stackHotkeyOk: boolean;
}

export interface StackState {
  collecting: boolean;
  limit: number;
  collected: number;
  order: StackOrder;
  /** In paste order (first = next). */
  items: ClipSummary[];
}

export type ActionResult = ExecuteResult & { message?: string };

export const clipApi = {
  list: (query: string, type: ClipFilter, source: string | null = null, limit = 0) => call<ClipSummary[]>("list", { query, type, source, limit }),
  sources: () => call<SourceSummary[]>("sources"),
  get: (id: string) => call<ClipEntry | null>("get", id),
  paste: (id: string, opts: { plain?: boolean; keepOpen?: boolean } = {}) => call<ActionResult>("paste", id, opts),
  pasteText: (text: string, keepOpen = false) => call<ActionResult>("pasteText", text, { keepOpen }),
  copy: (id: string) => call<ActionResult>("copy", id),
  copyMarkdownLink: (id: string) => call<ActionResult>("copyMarkdownLink", id),
  update: (id: string, text: string) => call<ClipSummary | null>("update", id, text),
  merge: (ids: string[], paste = false) => call<ActionResult>("merge", ids, { paste }),
  saveSnippet: (id: string, name?: string) => call<ActionResult>("saveSnippet", id, name),
  openLink: (id: string) => call<ActionResult>("openLink", id),
  reveal: (id: string) => call<ActionResult>("reveal", id),
  ignoreApp: (id: string) => call<ActionResult>("ignoreApp", id),
  pin: (id: string) => call<boolean>("pin", id),
  remove: (ids: string | string[]) => call<boolean>("delete", ids),
  clear: (keepPinned: boolean) => call<number>("clear", { keepPinned }),
  pauseFor: (minutes: number) => call<ActionResult>("pauseFor", minutes),
  resume: () => call<ActionResult>("resume"),
  getSettings: () => call<SettingsResult>("getSettings"),
  setSettings: (patch: Partial<ClipSettings>) => call<SettingsResult>("setSettings", patch),
  stats: () => call<ClipStats>("stats"),
  imageDataUrl: (id: string, full = false) => call<string | null>("imageDataUrl", id, { full }),
  thumbs: (ids: string[]) => call<Record<string, string>>("thumbs", ids),
  stack: {
    get: () => call<StackState>("stackGet"),
    start: (limit = 0) => call<ActionResult>("stackStart", limit),
    stop: () => call<StackState>("stackStop"),
    add: (ids: string[]) => call<StackState>("stackAdd", ids),
    remove: (id: string) => call<StackState>("stackRemove", id),
    move: (id: string, dir: -1 | 1) => call<StackState>("stackMove", id, dir),
    clear: () => call<StackState>("stackClear"),
    pasteNext: () => call<ActionResult>("stackPasteNext"),
  },
};

export const FILTERS: Array<{ id: ClipFilter; label: string }> = [
  { id: "all", label: "All Types" },
  { id: "text", label: "Text" },
  { id: "image", label: "Images" },
  { id: "link", label: "Links" },
  { id: "file", label: "Files" },
  { id: "color", label: "Colors" },
  { id: "pinned", label: "Pinned" },
];

/** Renderer-side thumbnail cache (data URLs), shared by the list, grid and stack views. */
const thumbCache = new Map<string, string>();
export async function loadThumbs(ids: string[]): Promise<Map<string, string>> {
  const missing = ids.filter((id) => !thumbCache.has(id));
  if (missing.length) {
    const got = await clipApi.thumbs(missing);
    for (const [id, url] of Object.entries(got)) thumbCache.set(id, url);
  }
  return thumbCache;
}
export const cachedThumb = (id: string) => thumbCache.get(id) ?? null;
