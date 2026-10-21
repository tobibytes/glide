import { DEFAULT_USER_EXCLUSIONS } from "./exclusions";

export interface FileIndexSettings extends Record<string, unknown> {
  scopes: string[];
  exclusions: string[];
  includeHidden: boolean;
  respectIgnoreFiles: boolean;
  showInRootSearch: boolean;
  /** Desktop / Documents / Downloads / iCloud Drive trigger a macOS privacy prompt; crawl them only after the user opts in. */
  allowProtectedFolders: boolean;
}

export const DEFAULT_FILEINDEX_SETTINGS: FileIndexSettings = {
  scopes: ["~", "/Applications"],
  exclusions: [...DEFAULT_USER_EXCLUSIONS],
  includeHidden: false,
  respectIgnoreFiles: true,
  showInRootSearch: true,
  allowProtectedFolders: false,
};

const strings = (v: unknown, fallback: string[]): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

export function normaliseSettings(raw: Record<string, unknown>): FileIndexSettings {
  const d = DEFAULT_FILEINDEX_SETTINGS;
  return {
    scopes: strings(raw.scopes, d.scopes),
    exclusions: strings(raw.exclusions, d.exclusions),
    includeHidden: bool(raw.includeHidden, d.includeHidden),
    respectIgnoreFiles: bool(raw.respectIgnoreFiles, d.respectIgnoreFiles),
    showInRootSearch: bool(raw.showInRootSearch, d.showInRootSearch),
    allowProtectedFolders: bool(raw.allowProtectedFolders, d.allowProtectedFolders),
  };
}

/** Only these settings change what a crawl produces. */
export function crawlKey(s: FileIndexSettings): string {
  return JSON.stringify([s.scopes, s.exclusions, s.includeHidden, s.respectIgnoreFiles, s.allowProtectedFolders]);
}
