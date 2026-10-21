/** The extension store: a bundled index of extensions-examples/ plus an optional remote registry JSON. */
import fs from "node:fs";
import path from "node:path";
import { isValidName } from "./manifest";
import { isValidGitUrl, readManifest } from "./registry";

export interface StoreEntry {
  name: string;
  title: string;
  description: string;
  author?: string;
  icon?: string;
  repo?: string;
  version?: string;
  commands: Array<{ name: string; title: string; description?: string }>;
  /** Folder to copy from for bundled entries. */
  bundledDir?: string;
  origin: "bundled" | "remote";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Validate a remote registry index: an array (or { extensions: [...] }) of entries; invalid entries are dropped. */
export function parseIndex(json: unknown): StoreEntry[] {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.extensions) ? json.extensions : null;
  if (!list) throw new Error("Store index must be a JSON array of extensions");
  const out: StoreEntry[] = [];
  for (const raw of list) {
    if (!isObj(raw) || !isValidName(raw.name)) continue;
    const repo = s(raw.repo);
    if (!repo || !isValidGitUrl(repo)) continue;
    const commands = (Array.isArray(raw.commands) ? raw.commands : [])
      .map((c) => (typeof c === "string" ? { name: c, title: c } : isObj(c) && typeof c.name === "string" ? { name: c.name, title: s(c.title) ?? c.name, description: s(c.description) } : null))
      .filter((c): c is NonNullable<typeof c> => !!c);
    out.push({
      name: raw.name,
      title: s(raw.title) ?? raw.name,
      description: s(raw.description) ?? "",
      author: s(raw.author),
      icon: s(raw.icon),
      repo,
      version: s(raw.version),
      commands,
      origin: "remote",
    });
  }
  return out;
}

export function bundledIndex(examplesDir: string | undefined): StoreEntry[] {
  if (!examplesDir) return [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(examplesDir).filter((d) => !d.startsWith("."));
  } catch {
    return [];
  }
  const out: StoreEntry[] = [];
  for (const d of dirs.sort()) {
    const dir = path.join(examplesDir, d);
    const { manifest } = readManifest(dir);
    if (!manifest) continue;
    out.push({
      name: manifest.name,
      title: manifest.title,
      description: manifest.description,
      author: manifest.author,
      icon: manifest.icon && !manifest.icon.includes(".") ? manifest.icon : undefined,
      version: manifest.version,
      commands: manifest.commands.map((c) => ({ name: c.name, title: c.title, description: c.description })),
      bundledDir: dir,
      origin: "bundled",
    });
  }
  return out;
}

export async function fetchIndex(url: string, timeoutMs = 8000): Promise<StoreEntry[]> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Store index URL must start with http:// or https://");
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Store index request failed: HTTP ${res.status}`);
  return parseIndex(await res.json());
}
