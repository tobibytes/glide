/** Typed wrappers over window.glide.feature("clipboard", …). */
import type { ExecuteResult } from "@shared/ipc";
import type { ClipEntry, ClipFilter, ClipSettings, ClipStats, ClipSummary } from "../../../main/features/clipboard/model";
import { glide } from "../../lib/glide";

export type { ClipEntry, ClipFilter, ClipSettings, ClipStats, ClipSummary };

const call = <T>(method: string, ...args: unknown[]) => glide().feature<T>("clipboard", method, ...args);

export interface SettingsResult {
  settings: ClipSettings;
  hotkeyOk: boolean;
}

export const clipApi = {
  list: (query: string, type: ClipFilter, limit = 0) => call<ClipSummary[]>("list", { query, type, limit }),
  get: (id: string) => call<ClipEntry | null>("get", id),
  paste: (id: string, plain = false) => call<ExecuteResult>("paste", id, { plain }),
  copy: (id: string) => call<ExecuteResult>("copy", id),
  pin: (id: string) => call<boolean>("pin", id),
  remove: (id: string) => call<boolean>("delete", id),
  clear: (keepPinned: boolean) => call<number>("clear", { keepPinned }),
  getSettings: () => call<SettingsResult>("getSettings"),
  setSettings: (patch: Partial<ClipSettings>) => call<SettingsResult>("setSettings", patch),
  stats: () => call<ClipStats>("stats"),
  imageDataUrl: (id: string, full = false) => call<string | null>("imageDataUrl", id, { full }),
};

export const FILTERS: Array<{ id: ClipFilter; label: string }> = [
  { id: "all", label: "All Types" },
  { id: "text", label: "Text" },
  { id: "image", label: "Images" },
  { id: "link", label: "Links" },
  { id: "color", label: "Colors" },
  { id: "file", label: "Files" },
];
