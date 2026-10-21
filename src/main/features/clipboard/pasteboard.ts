/**
 * Electron 44 clipboard access (Promise-based W3C-style API: read()/write() with ClipboardItem).
 * Raw macOS pasteboard types appear as `electron application/osclipboard;format="<UTI>"`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clipboard, ClipboardItem, nativeImage } from "electron";
import { fileUrl, type ClipEntry, type ClipImage } from "./model";

export interface Snapshot {
  types: string[];
  /** Cheap change signature: types + text + uri list (images are compared by hash separately). */
  sig: string;
  text: string | null;
  uriList: string | null;
  imageType: string | null;
  items: Electron.ClipboardItem[];
}

const blobText = async (item: Electron.ClipboardItem, type: string): Promise<string | null> => {
  try {
    const v = await item.getType(type);
    return v instanceof Blob ? await v.text() : null;
  } catch {
    return null;
  }
};

export async function readSnapshot(): Promise<Snapshot> {
  const items = await clipboard.read();
  const types = items.flatMap((i) => i.types);
  const first = items[0];
  const text = types.includes("text/plain") ? await clipboard.readText() : null;
  const uriList = first && types.includes("text/uri-list") ? await blobText(first, "text/uri-list") : null;
  const imageType = types.includes("image/png") ? "image/png" : (types.find((t) => /tiff/i.test(t)) ?? null);
  const sig = `${types.join("|")}\u0000${text ?? ""}\u0000${uriList ?? ""}`;
  return { types, sig, text, uriList, imageType, items };
}

/** Read the image on the clipboard as PNG bytes. */
export async function readImagePng(snap: Snapshot): Promise<Buffer | null> {
  const item = snap.items.find((i) => snap.imageType && i.types.includes(snap.imageType));
  if (!item || !snap.imageType) return null;
  try {
    const blob = await item.getType(snap.imageType);
    if (!(blob instanceof Blob)) return null;
    const buf = Buffer.from(await blob.arrayBuffer());
    if (snap.imageType === "image/png") return buf;
    const img = nativeImage.createFromBuffer(buf);
    return img.isEmpty() ? null : img.toPNG();
  } catch {
    return null;
  }
}

export const sha1 = (data: Buffer | string) => crypto.createHash("sha1").update(data).digest("hex");

export function imagePaths(dataDir: string, hash: string) {
  const dir = path.join(dataDir, "images");
  return { dir, full: path.join(dir, `${hash}.png`), thumb: path.join(dir, `${hash}.thumb.png`) };
}

/** Store the PNG and a ≤256 px thumbnail; returns image metadata. */
export function saveImage(dataDir: string, png: Buffer, hash = sha1(png)): ClipImage | null {
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const p = imagePaths(dataDir, hash);
  fs.mkdirSync(p.dir, { recursive: true });
  if (!fs.existsSync(p.full)) fs.writeFileSync(p.full, png, { mode: 0o600 });
  if (!fs.existsSync(p.thumb)) {
    const scale = Math.min(1, 256 / Math.max(width, height));
    const thumb = scale < 1 ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" }) : img;
    fs.writeFileSync(p.thumb, thumb.toPNG(), { mode: 0o600 });
  }
  return { sha1: hash, width, height, bytes: png.length };
}

export function deleteImage(dataDir: string, hash: string): void {
  const p = imagePaths(dataDir, hash);
  for (const f of [p.full, p.thumb]) fs.rmSync(f, { force: true });
}

/** Put an entry back on the clipboard. `plain` turns file references into their paths as text (images stay images). */
export async function writeEntry(e: ClipEntry, dataDir: string, plain: boolean): Promise<void> {
  if (e.type === "image" && e.image) {
    const png = fs.readFileSync(imagePaths(dataDir, e.image.sha1).full);
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
    return;
  }
  if (e.type === "file" && e.files?.length) {
    if (plain) await clipboard.writeText(e.files.join("\n"));
    else await clipboard.write([new ClipboardItem({ "text/uri-list": e.files.map(fileUrl).join("\r\n"), "text/plain": e.files.join("\n") })]);
    return;
  }
  await clipboard.writeText(e.text ?? "");
}
