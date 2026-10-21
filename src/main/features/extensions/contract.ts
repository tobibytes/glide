/** Types shared by the extensions feature's main-process methods and its renderer views. */
import type { ItemIcon } from "@shared/types";
import type { ViewModel } from "../../../extension-api/types";
import type { CommandManifest, PreferenceManifest } from "./manifest";
import type { InstallSource } from "./registry";
import type { SessionInfo } from "./sessions";

export interface ExtensionSummary {
  name: string;
  title: string;
  description: string;
  version: string;
  author?: string;
  icon?: ItemIcon;
  enabled: boolean;
  source?: InstallSource;
  dir: string;
  errors?: string[];
  commands: CommandManifest[];
  preferences: PreferenceManifest[];
  /** Required preferences that have no value yet. */
  missingPreferences: string[];
  isGit: boolean;
  /** "raycast" for imported Raycast extensions. */
  runtime: "glide" | "raycast";
  warnings?: string[];
}

/** What the Raycast importer can do in this build. */
export interface RaycastSupport {
  /** esbuild is available, so TypeScript/JSX sources can be built. */
  canBuild: boolean;
  storeUrl: string;
}

export interface StoreListing {
  name: string;
  title: string;
  description: string;
  author?: string;
  icon?: ItemIcon;
  version?: string;
  repo?: string;
  origin: "bundled" | "remote";
  commands: Array<{ name: string; title: string; description?: string }>;
  installed: boolean;
}

export interface StoreResponse {
  entries: StoreListing[];
  remoteUrl: string;
  remoteError?: string;
}

export interface RunViewState {
  info: SessionInfo & { assetsPath: string };
  view: ViewModel | null;
}

export interface ExtensionSettings extends Record<string, unknown> {
  storeUrl: string;
}

export type InstallRequest = { kind: "store"; name: string } | { kind: "folder"; path: string } | { kind: "git"; url: string } | { kind: "raycast-folder"; path: string };

export interface PreferencesState {
  name: string;
  title: string;
  preferences: PreferenceManifest[];
  /** Values keyed by prefKey (command-scoped preferences are "<command>/<name>"). */
  values: Record<string, string | boolean>;
  commands?: Array<{ name: string; title: string }>;
}

/** Event payloads (window.glide.onFeatureEvent with feature "extensions"). */
export const EXT_EVENTS = {
  session: "session", // SessionEvent
  changed: "changed", // installed set changed
} as const;
