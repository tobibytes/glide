/** Shapes exchanged with the renderer (window.glide.feature("fileindex", …)). */
import type { MatchRange } from "@shared/types";
import type { FileKind } from "./kinds";

export interface FileHitDTO {
  path: string;
  name: string;
  /** Parent folder for display ("~/Documents"). */
  folder: string;
  isDir: boolean;
  size: number;
  mtime: number;
  kind: FileKind;
  kindLabel: string;
  ranges: MatchRange[];
}

export interface SearchResultDTO {
  source: "index" | "spotlight" | "content";
  hits: FileHitDTO[];
  tookMs: number;
}

export interface PreviewDTO {
  path: string;
  name: string;
  folder: string;
  exists: boolean;
  isDir: boolean;
  kind: FileKind;
  kindLabel: string;
  size: number;
  mtime: number;
  birthtime: number;
  /** First 4 KB for text-like files. */
  text?: string;
  truncated?: boolean;
  image: boolean;
  childCount?: number;
}

export interface AppDTO {
  name: string;
  path: string;
}
