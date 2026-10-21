import { realpath } from "node:fs/promises";
import { nativeImage, protocol } from "electron";

/**
 * Custom scheme that serves PNG icons for app bundles and files:
 *   glide-icon://icon/?path=<encodeURIComponent(absolute path)>
 * The renderer maps ItemIcon {kind:"app"|"file"} to this URL; emoji, symbol,
 * url and color icons need nothing from main and are rendered directly.
 */
export const ICON_SCHEME = "glide-icon";
const CACHE_LIMIT = 600;

/** Must run before app.whenReady(). */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
  ]);
}

export function iconUrlFor(filePath: string): string {
  return `${ICON_SCHEME}://icon/?path=${encodeURIComponent(filePath)}`;
}

/** Must run after app.whenReady(). */
export function installIconProtocol(): void {
  const cache = new Map<string, Buffer>();
  protocol.handle(ICON_SCHEME, async (request) => {
    const filePath = new URL(request.url).searchParams.get("path");
    if (!filePath) return new Response("missing path", { status: 400 });
    let png = cache.get(filePath);
    if (!png) {
      try {
        // app.getFileIcon aborts the process (SIGTRAP on a thread-pool worker) under
        // Electron 44 on macOS 26, even for a single call; Quick Look thumbnails are stable.
        // 96 px renders crisply at the launcher's 32 px icon size on Retina displays.
        // Resolve links first: Safari and other cryptex apps sit behind /Applications
        // entries that Quick Look renders as a generic document.
        const target = await realpath(filePath).catch(() => filePath);
        const image = await nativeImage.createThumbnailFromPath(target, { width: 96, height: 96 });
        if (image.isEmpty()) return new Response("icon unavailable", { status: 404 });
        png = image.toPNG();
      } catch {
        return new Response("icon unavailable", { status: 404 });
      }
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(filePath, png);
    }
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
  });
}
