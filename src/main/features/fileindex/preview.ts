/** Detail-pane data: metadata plus the first 4 KB of text files. */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classify, isTextual, KIND_LABELS } from "./kinds";
import type { PreviewDTO } from "./types";

const PREVIEW_BYTES = 4096;

export function displayFolder(p: string): string {
  const dir = path.dirname(p);
  const home = os.homedir();
  return dir === home ? "~" : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

/** Heuristic: NUL bytes or many control chars → binary. */
function looksBinary(buf: Buffer): boolean {
  let control = 0;
  for (const b of buf) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control > buf.length * 0.1;
}

export async function readPreview(p: string): Promise<PreviewDTO> {
  const name = path.basename(p);
  const base = { path: p, name, folder: displayFolder(p) };
  const st = await fsp.stat(p).catch(() => null);
  if (!st) return { ...base, exists: false, isDir: false, kind: "other", kindLabel: "Missing", size: 0, mtime: 0, birthtime: 0, image: false };
  const isDir = st.isDirectory();
  const kind = classify(name, isDir);
  const out: PreviewDTO = {
    ...base,
    exists: true,
    isDir,
    kind,
    kindLabel: KIND_LABELS[kind],
    size: isDir ? 0 : st.size,
    mtime: st.mtimeMs,
    birthtime: st.birthtimeMs,
    image: kind === "image" || kind === "pdf" || kind === "video" || kind === "app",
  };
  if (isDir && kind === "folder") {
    out.childCount = await fsp.readdir(p).then((n) => n.filter((x) => !x.startsWith(".")).length).catch(() => undefined);
  } else if (!isDir && (isTextual(kind) || (kind === "other" && st.size < 1_000_000))) {
    const fh = await fsp.open(p, "r").catch(() => null);
    if (fh) {
      try {
        const buf = Buffer.alloc(Math.min(PREVIEW_BYTES, st.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const slice = buf.subarray(0, bytesRead);
        if (!looksBinary(slice)) {
          out.text = slice.toString("utf8").replace(/�$/, "");
          out.truncated = st.size > PREVIEW_BYTES;
          if (out.kind === "other") out.kindLabel = "Plain Text";
        }
      } finally {
        await fh.close();
      }
    }
  }
  return out;
}
