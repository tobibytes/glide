/** Typed wrappers around window.glide.feature("fileindex", …). */
import type { ExecuteResult } from "@shared/ipc";
import { glide } from "../../lib/glide";
import type { AppDTO, PreviewDTO, SearchResultDTO } from "../../../main/features/fileindex/types";
import type { IndexStatus } from "../../../main/features/fileindex/service";
import type { FileIndexSettings } from "../../../main/features/fileindex/settings";

export type { AppDTO, FileHitDTO, PreviewDTO, SearchResultDTO } from "../../../main/features/fileindex/types";
export type { IndexStatus } from "../../../main/features/fileindex/service";
export type { FileIndexSettings } from "../../../main/features/fileindex/settings";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("fileindex", method, ...args);

export const fileIndex = {
  search: (query: string, limit = 50) => call<SearchResultDTO>("search", query, limit),
  readPreview: (path: string) => call<PreviewDTO>("readPreview", path),
  action: (path: string, actionId: string, appPath?: string) => call<ExecuteResult>("action", path, actionId, appPath),
  listApps: () => call<AppDTO[]>("listApps"),
  status: () => call<IndexStatus | null>("status"),
  rebuild: () => call<IndexStatus | null>("rebuild"),
  getSettings: () => call<FileIndexSettings>("getSettings"),
  setSettings: (patch: Partial<FileIndexSettings>) => call<FileIndexSettings>("setSettings", patch),
};

/** Subscribe to index status pushes from main. */
export function onStatus(cb: (s: IndexStatus) => void): () => void {
  return glide().onFeatureEvent((e) => {
    if (e.feature === "fileindex" && e.event === "status") cb(e.payload as IndexStatus);
  });
}
