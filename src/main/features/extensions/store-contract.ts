/** Types shared by the store's main-process methods and the renderer's Store views (type-only). */
import type { ItemIcon } from "@shared/types";
import type { StoreChange, StoreCommand, StoreKind } from "./store-schema";

export interface StoreItem {
  id: string;
  name: string;
  title: string;
  description: string;
  author: string;
  version: string;
  categories: string[];
  icon: ItemIcon;
  commands: StoreCommand[];
  kind: StoreKind;
  minGlideVersion: string;
  screenshots: string[];
  changelog: StoreChange[];
  homepage?: string;
  license?: string;
  /** "bundled": ships with Glide (installs by copying, no network). */
  origin: "bundled" | "remote";
  /** How Install would get the files right now. */
  via: "bundled" | "download" | null;
  /** Download size in bytes (via === "download"). */
  size?: number;
  /** Why it cannot be installed (incompatible Glide version, missing bundled files…). */
  unavailable?: string;
  installed: boolean;
  installedVersion?: string;
  /** Installed through the store (otherwise a folder/git install of the same name). */
  installedFromStore: boolean;
  updateAvailable: boolean;
}

export interface StoreState {
  items: StoreItem[];
  categories: string[];
  indexUrl: string;
  /** When the remote index was fetched (ms epoch), if ever. */
  fetchedAt?: number;
  /** The remote part comes from the on-disk cache (offline or not refreshed). */
  fromCache: boolean;
  /** Remote index problem (bundled entries are still listed). */
  error?: string;
  /** Entries of the index that were dropped as invalid. */
  warnings: string[];
}

export interface StoreInstallResult {
  name: string;
  title: string;
  version: string;
  firstCommand?: string;
}
