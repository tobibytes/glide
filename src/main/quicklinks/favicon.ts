/**
 * Favicons for quicklinks: `<origin>/favicon.ico`, fetched only when the user saves a quicklink
 * (never on search or launch), cached as data URLs in <userData>/features/quicklinks/favicons.json.
 */
import fs from "node:fs";
import path from "node:path";
import { faviconOrigin } from "./core";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4000;
/** Failed lookups are retried after a day, not on every save. */
const NEGATIVE_TTL_MS = 86_400_000;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
interface CacheEntry {
  icon: string | null;
  at: number;
}

/** Sniff the image type from magic bytes; servers often send favicons as text/plain or octet-stream. */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0 && b(1) === 0 && (b(2) === 1 || b(2) === 2) && b(3) === 0) return "image/x-icon";
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "image/png";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return "image/gif";
  if (b(0) === 0xff && b(1) === 0xd8) return "image/jpeg";
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45) return "image/webp";
  const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return undefined;
}

export class FaviconCache {
  private cache = new Map<string, CacheEntry>();
  private loaded = false;

  constructor(
    private readonly file: () => string,
    private readonly fetchFn: FetchFn,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) if (v && typeof v.at === "number") this.cache.set(k, { icon: typeof v.icon === "string" ? v.icon : null, at: v.at });
    } catch {
      // first run or unreadable cache: start empty
    }
  }

  private persist(): void {
    try {
      const f = this.file();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(Object.fromEntries(this.cache)), "utf8");
    } catch {
      // cache is an optimisation only
    }
  }

  /** Data URL of the site's favicon, or null when there is none (or the URL has no concrete host). */
  async get(url: string, now = Date.now()): Promise<string | null> {
    const origin = faviconOrigin(url);
    if (!origin) return null;
    this.load();
    const hit = this.cache.get(origin);
    if (hit && (hit.icon || now - hit.at < NEGATIVE_TTL_MS)) return hit.icon;
    const icon = await this.fetchIcon(`${origin}/favicon.ico`);
    this.cache.set(origin, { icon, at: now });
    this.persist();
    return icon;
  }

  private async fetchIcon(url: string): Promise<string | null> {
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow", credentials: "omit" } as RequestInit);
      if (!res.ok) return null;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BYTES) return null;
      const type = sniffImage(bytes);
      if (!type) return null;
      return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      return null;
    }
  }
}
