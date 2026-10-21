/** Map an extension IconSource string to Glide's ItemIcon (shared by main and renderer; no Node imports). */
import type { ItemIcon } from "@shared/types";

export function iconFor(src: string | undefined, assetsPath?: string): ItemIcon | undefined {
  if (!src) return undefined;
  const v = src.trim();
  if (!v) return undefined;
  if (/^https?:\/\//i.test(v) || /^data:image\//i.test(v)) return { kind: "url", value: v };
  // Raycast { fileIcon } / absolute image paths: the file's Finder icon or thumbnail.
  if (/^file:\/\//i.test(v)) {
    let p = v.slice(7);
    try {
      p = decodeURI(p);
    } catch {
      /* keep it raw */
    }
    return p.startsWith("/") && !p.split("/").includes("..") ? { kind: "file", value: p } : undefined;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return { kind: "color", value: v };
  const looksLikeFile = /\.(png|jpe?g|gif|svg|webp|icns|tiff?)$/i.test(v);
  if (looksLikeFile) {
    if (!assetsPath || v.split(/[\\/]/).includes("..") || v.startsWith("/")) return undefined;
    return { kind: "file", value: `${assetsPath.replace(/\/+$/, "")}/${v.replace(/^\.?\/+/, "")}` };
  }
  return { kind: "emoji", value: v.length <= 16 ? v : Array.from(v).slice(0, 2).join("") };
}
