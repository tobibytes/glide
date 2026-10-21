/** Extension → kind classification (subset of minidex's compiled-in tables, research/04 §2.2). */

export type FileKind = "folder" | "app" | "image" | "pdf" | "doc" | "code" | "audio" | "video" | "archive" | "text" | "other";

export const FILTER_KINDS = ["folder", "image", "pdf", "doc", "code", "audio", "video", "app"] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

const TABLE: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string) => {
  for (const e of exts.split(/\s+/)) if (e) TABLE[e] = kind;
};
add("image", "png jpg jpeg gif webp heic heif tif tiff bmp svg ico icns raw cr2 nef arw dng psd ai sketch fig avif jxl");
add("pdf", "pdf");
add("doc", "doc docx pages rtf rtfd odt ott xls xlsx numbers ods csv tsv ppt pptx key odp epub");
add(
  "code",
  "ts tsx js jsx mjs cjs json jsonc swift m mm h hpp c cc cpp cxx rs go py rb php java kt kts scala cs fs sh bash zsh fish ps1 lua pl r jl dart ex exs erl hs ml clj sql graphql proto vue svelte astro css scss sass less html htm xml yaml yml toml ini gradle cmake make mk dockerfile tf nix zig wasm ipynb",
);
add("text", "txt md markdown mdx log rst org tex adoc conf cfg env");
add("audio", "mp3 m4a aac wav aiff aif flac ogg opus wma alac caf mid midi");
add("video", "mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp mts");
add("archive", "zip tar gz tgz bz2 xz 7z rar dmg iso pkg jar zst");

const TEXT_NAMES = new Set(["makefile", "dockerfile", "license", "readme", "gemfile", "procfile", "brewfile", ".gitignore", ".zshrc", ".bashrc", ".env"]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function classify(name: string, isDir: boolean): FileKind {
  const ext = extensionOf(name);
  if (isDir) return ext === "app" ? "app" : "folder";
  const k = TABLE[ext];
  if (k) return k;
  if (TEXT_NAMES.has(name.toLowerCase())) return "text";
  return "other";
}

export function matchesKind(kind: FileKind, filter: FilterKind): boolean {
  if (filter === "doc") return kind === "doc" || kind === "pdf" || kind === "text";
  return kind === filter;
}

/** Kinds whose first bytes are worth showing as a text preview. */
export function isTextual(kind: FileKind): boolean {
  return kind === "code" || kind === "text";
}

export const KIND_LABELS: Record<FileKind, string> = {
  folder: "Folder",
  app: "Application",
  image: "Image",
  pdf: "PDF Document",
  doc: "Document",
  code: "Source Code",
  audio: "Audio",
  video: "Video",
  archive: "Archive",
  text: "Plain Text",
  other: "File",
};
