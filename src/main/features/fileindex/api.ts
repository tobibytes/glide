/**
 * Process-wide handle on the running index, used by src/main/sources/files.ts
 * (root search) which is constructed outside the feature host.
 */
import type { FileIndexService } from "./service";
import type { FileIndexSettings } from "./settings";

let active: { service: FileIndexService; settings: () => FileIndexSettings } | null = null;

export function setActiveFileIndex(value: typeof active): void {
  active = value;
}

export function activeFileIndex(): FileIndexService | null {
  return active?.service ?? null;
}

export function activeFileIndexSettings(): FileIndexSettings | null {
  return active?.settings() ?? null;
}
