/** Temp images for OCR: interactive region capture via screencapture(1) and clipboard images. Callers delete them. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readImagePng, readSnapshot } from "../clipboard/pasteboard";

const IMAGE_EXT = /\.(png|jpe?g|heic|heif|tiff?|gif|bmp|webp)$/i;

export function tempDir(): string {
  const dir = path.join(os.tmpdir(), "glide-ocr");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const tempFile = () => path.join(tempDir(), `capture-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);

export function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Native region selection (drag; Space toggles window mode; Esc cancels). Resolves the PNG path, or null when the
 * user cancelled. -x: no shutter sound.
 */
export function captureRegion(timeoutMs = 120_000): Promise<string | null> {
  const file = tempFile();
  return new Promise((resolve) => {
    const child = spawn("/usr/sbin/screencapture", ["-i", "-x", file], { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      let ok = false;
      try {
        ok = fs.statSync(file).size > 0;
      } catch {
        ok = false;
      }
      if (!ok) removeQuietly(file);
      resolve(ok ? file : null);
    };
    child.on("error", done);
    child.on("close", done);
  });
}

/** The clipboard's image as a temp PNG (`temp: true`), or a copied image file used in place. */
export async function clipboardImage(): Promise<{ path: string; temp: boolean } | null> {
  const snap = await readSnapshot();
  const png = await readImagePng(snap);
  if (png) {
    const file = tempFile();
    fs.writeFileSync(file, png, { mode: 0o600 });
    return { path: file, temp: true };
  }
  // A Finder copy of an image file puts a file URL on the clipboard, not image data.
  for (const line of (snap.uriList ?? "").split(/\r?\n/)) {
    if (!line.startsWith("file://")) continue;
    try {
      const p = decodeURIComponent(new URL(line.trim()).pathname);
      if (IMAGE_EXT.test(p) && fs.existsSync(p)) return { path: p, temp: false };
    } catch {
      /* not a file URL */
    }
  }
  return null;
}
