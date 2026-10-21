import type { WifiInfo } from "../../native/helper";
import type { PathFormat, TerminalApp } from "./paths";

export type FinderSettings = {
  terminal: TerminalApp;
  pathFormat: PathFormat;
  /** Fall back to asking Finder over Apple Events (shows the Automation prompt once). Off by default. */
  automation: boolean;
  recentDestinations: string[];
};

export interface SelectionState {
  paths: string[];
  folder: string | null;
  error?: string;
}

export interface FinderSettingsState {
  settings: FinderSettings;
  helper: boolean;
  accessibility: boolean | null;
  wifi: WifiInfo | null;
}

export interface DestinationRow {
  path: string;
  name: string;
  kind: "typed" | "recent" | "place" | "child";
}
