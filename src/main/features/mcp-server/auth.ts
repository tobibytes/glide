/**
 * Bearer token and discovery file for Glide's MCP server, shared by the server (main process) and
 * the glide-mcp stdio bridge. Plain Node (no Electron) so the bridge can bundle it.
 *
 * Files in <userData>/features/mcp-server/ (mode 0600):
 *   token        random 256-bit token, generated the first time the server is enabled
 *   server.json  { port, pid, url, version, startedAt } while the server is listening
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOKEN_FILE = "token";
export const DISCOVERY_FILE = "server.json";
export const MCP_PATH = "/mcp";

export interface Discovery {
  port: number;
  pid: number;
  url: string;
  version: string;
  startedAt: number;
}

function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const validToken = (t: string) => /^[A-Za-z0-9_-]{32,}$/.test(t);

export function readToken(dir: string): string | null {
  try {
    const t = fs.readFileSync(path.join(dir, TOKEN_FILE), "utf8").trim();
    return validToken(t) ? t : null;
  } catch {
    return null;
  }
}

export function loadOrCreateToken(dir: string): string {
  const existing = readToken(dir);
  if (existing) {
    try {
      fs.chmodSync(path.join(dir, TOKEN_FILE), 0o600);
    } catch {
      // read-only fs: keep going
    }
    return existing;
  }
  return regenerateToken(dir);
}

export function regenerateToken(dir: string): string {
  const t = randomBytes(32).toString("base64url");
  writePrivate(path.join(dir, TOKEN_FILE), `${t}\n`);
  return t;
}

/** Constant-time check of an Authorization header against the token. */
export function authorized(header: string | string[] | undefined, token: string): boolean {
  const h = Array.isArray(header) ? header[0] : header;
  const m = typeof h === "string" ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  if (!m || !token) return false;
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export function writeDiscovery(dir: string, d: Discovery): void {
  writePrivate(path.join(dir, DISCOVERY_FILE), `${JSON.stringify(d, null, 2)}\n`);
}

export function readDiscovery(dir: string): Discovery | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, DISCOVERY_FILE), "utf8")) as Partial<Discovery>;
    if (typeof d.port !== "number" || typeof d.url !== "string") return null;
    return { port: d.port, pid: typeof d.pid === "number" ? d.pid : 0, url: d.url, version: typeof d.version === "string" ? d.version : "", startedAt: typeof d.startedAt === "number" ? d.startedAt : 0 };
  } catch {
    return null;
  }
}

/** Remove server.json, but only if it still describes this process. */
export function removeDiscovery(dir: string, pid: number): void {
  const d = readDiscovery(dir);
  if (d && d.pid !== pid) return;
  try {
    fs.unlinkSync(path.join(dir, DISCOVERY_FILE));
  } catch {
    // already gone
  }
}

/** Where the bridge looks for token/server.json (mirrors app.getPath("userData") + features/mcp-server). */
export function defaultServerDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (env.GLIDE_MCP_DIR) return env.GLIDE_MCP_DIR;
  const userData = env.GLIDE_USER_DATA || path.join(home, "Library", "Application Support", "Glide");
  return path.join(userData, "features", "mcp-server");
}
