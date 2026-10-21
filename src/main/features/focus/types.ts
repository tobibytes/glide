import type { BlockedApp, FocusRecord, FocusSession, FocusStats } from "./machine";

export interface FocusSettings extends Record<string, unknown> {
  defaultMinutes: number;
  blockedApps: BlockedApp[];
  blockedSites: string[];
  /** Names of user Shortcuts to run on start/stop (e.g. to toggle Do Not Disturb). Empty = off. */
  dndOnShortcut: string;
  dndOffShortcut: string;
  /** Ask blocked apps to quit (true) or only notify (false). */
  quitBlockedApps: boolean;
}

export const DEFAULT_FOCUS_SETTINGS: FocusSettings = { defaultMinutes: 25, blockedApps: [], blockedSites: [], dndOnShortcut: "", dndOffShortcut: "", quitBlockedApps: true };

export interface FocusState {
  session: FocusSession | null;
  remainingMs: number;
  elapsedMs: number;
  stats: FocusStats;
  settings: FocusSettings;
  recent: FocusRecord[];
}

export interface BlockedInfo {
  site: string;
  url: string;
  goal: string;
  remainingMs: number;
}
