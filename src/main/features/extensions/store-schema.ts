/**
 * The Glide extension store index (store/index.json): types, validation and version helpers.
 * Pure (no fs / Electron), so it is shared by the store client, scripts/store-pack.mjs and tests.
 */

export const STORE_SCHEMA_VERSION = 1;
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const STORE_KINDS = ["glide", "raycast"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export interface StoreCommand {
  name: string;
  title: string;
  description?: string;
  mode?: "view" | "no-view" | "menu-bar";
}

export interface StoreDownload {
  /** Absolute https URL, or relative to the index URL. http is accepted only for 127.0.0.1/localhost. */
  url: string;
  /** Lower-case hex SHA-256 of the .tgz. */
  sha256: string;
  /** Exact byte size of the .tgz. */
  size: number;
}

export interface StoreChange {
  version: string;
  date?: string;
  notes: string;
}

export interface StoreIndexEntry {
  id: string;
  /** package.json "name"; the install folder. */
  name: string;
  title: string;
  description: string;
  author: string;
  version: string;
  categories: string[];
  /** Emoji or https image URL. */
  icon?: string;
  commands: StoreCommand[];
  kind: StoreKind;
  minGlideVersion: string;
  download?: StoreDownload;
  /** Ships with Glide in extensions-examples/<path>: installs by copying, no network. */
  source?: { bundled: true; path: string };
  screenshots: string[];
  changelog: StoreChange[];
  homepage?: string;
  license?: string;
}

export interface StoreIndex {
  schemaVersion: number;
  updatedAt?: string;
  extensions: StoreIndexEntry[];
}

export interface IndexValidation {
  index: StoreIndex;
  /** Problems with individual entries (those entries are dropped). */
  errors: string[];
}

export class StoreIndexError extends Error {}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);

export const isSemver = (v: unknown): v is string => typeof v === "string" && SEMVER_RE.test(v.trim());

/** Semver precedence (build metadata ignored; a pre-release sorts before its release). Invalid versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a.trim());
  const pb = SEMVER_RE.exec(b.trim());
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (!ra || !rb) return ra ? -1 : rb ? 1 : 0;
  const sa = ra.split(".");
  const sb = rb.split(".");
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const isNewer = (candidate: string, installed: string) => compareVersions(candidate, installed) > 0;

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/** https anywhere, http only on loopback (local testing / self-hosting on this Mac). */
export function isAllowedRemoteUrl(u: URL): boolean {
  return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
}

/** Resolve an index-relative URL and check its scheme; throws StoreIndexError. */
export function resolveStoreUrl(raw: string, base?: string): URL {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new StoreIndexError(`Invalid URL: ${raw}`);
  }
  if (u.username || u.password) throw new StoreIndexError("URLs with credentials are not allowed");
  if (!isAllowedRemoteUrl(u)) throw new StoreIndexError(`Only https:// URLs are allowed (http only for 127.0.0.1): ${u.href}`);
  return u;
}

function urlField(v: unknown, at: string, errors: string[]): string | undefined {
  const s = str(v, 2048);
  if (!s) return undefined;
  if (/^(javascript|data|file|vbscript):/i.test(s)) {
    errors.push(`${at}: unsupported URL scheme`);
    return undefined;
  }
  return s;
}

function parseEntry(raw: unknown, i: number, errors: string[]): StoreIndexEntry | null {
  const at = `extensions[${i}]`;
  if (!isObj(raw)) return errors.push(`${at}: must be an object`), null;
  const label = typeof raw.id === "string" ? `${at} (${raw.id})` : at;
  const errs: string[] = [];
  const id = str(raw.id, 64);
  if (!id || !ID_RE.test(id)) errs.push('"id" must be 1–64 lower-case letters, digits, ".", "_" or "-"');
  const name = str(raw.name, 64);
  if (!name || !NAME_RE.test(name) || name === "." || name === "..") errs.push('"name" must be a valid extension (package) name');
  const title = str(raw.title, 120);
  if (!title) errs.push('"title" is required');
  const description = str(raw.description, 4000);
  if (!description) errs.push('"description" is required');
  const author = str(raw.author, 120);
  if (!author) errs.push('"author" is required');
  if (!isSemver(raw.version)) errs.push('"version" must be semver (1.2.3)');
  if (!isSemver(raw.minGlideVersion)) errs.push('"minGlideVersion" must be semver (0.2.0)');
  const kind = raw.kind;
  if (kind !== "glide" && kind !== "raycast") errs.push('"kind" must be "glide" or "raycast"');

  const categories = Array.isArray(raw.categories) ? raw.categories.map((c) => str(c, 40)).filter((c): c is string => !!c).slice(0, 8) : [];
  if (raw.categories !== undefined && !Array.isArray(raw.categories)) errs.push('"categories" must be an array of strings');

  const commands: StoreCommand[] = [];
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) errs.push('"commands" must list at least one command');
  else
    for (const c of raw.commands) {
      if (!isObj(c) || !str(c.name, 64) || !str(c.title, 120)) {
        errs.push('every command needs "name" and "title"');
        break;
      }
      const mode = c.mode === "view" || c.mode === "no-view" || c.mode === "menu-bar" ? c.mode : undefined;
      commands.push({ name: String(c.name).trim(), title: String(c.title).trim(), description: str(c.description, 500), mode });
    }

  let download: StoreDownload | undefined;
  if (raw.download !== undefined && raw.download !== null) {
    const d = raw.download;
    if (!isObj(d)) errs.push('"download" must be { url, sha256, size }');
    else {
      const url = urlField(d.url, `${label}.download.url`, errs);
      const sha = typeof d.sha256 === "string" ? d.sha256.toLowerCase() : "";
      const size = d.size;
      if (!url) errs.push('"download.url" is required');
      if (!SHA_RE.test(sha)) errs.push('"download.sha256" must be 64 hex characters');
      if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_DOWNLOAD_BYTES) errs.push(`"download.size" must be an integer between 1 and ${MAX_DOWNLOAD_BYTES}`);
      if (url && SHA_RE.test(sha) && typeof size === "number") download = { url, sha256: sha, size };
    }
  }
  let source: StoreIndexEntry["source"];
  if (raw.source !== undefined && raw.source !== null) {
    const s = raw.source;
    const p = isObj(s) ? str(s.path, 64) : undefined;
    if (!isObj(s) || s.bundled !== true || !p || !NAME_RE.test(p)) errs.push('"source" must be { "bundled": true, "path": "<folder in extensions-examples>" }');
    else source = { bundled: true, path: p };
  }
  if (!download && !source && !errs.some((e) => e.includes("download") || e.includes("source"))) errs.push('needs a "download" { url, sha256, size } or a bundled "source"');

  const screenshots = Array.isArray(raw.screenshots) ? raw.screenshots.map((u, k) => urlField(u, `${label}.screenshots[${k}]`, errs)).filter((u): u is string => !!u).slice(0, 10) : [];
  const changelog: StoreChange[] = [];
  if (Array.isArray(raw.changelog))
    for (const c of raw.changelog) {
      if (isObj(c) && isSemver(c.version) && str(c.notes, 4000)) changelog.push({ version: String(c.version).trim(), date: str(c.date, 40), notes: String(c.notes).trim() });
    }
  else if (raw.changelog !== undefined) errs.push('"changelog" must be an array of { version, notes }');

  const icon = str(raw.icon, 2048);
  if (icon && /^(javascript|file|vbscript):/i.test(icon)) errs.push('"icon" must be an emoji or an https URL');

  if (errs.length) {
    errors.push(...errs.map((e) => `${label}: ${e}`));
    return null;
  }
  return {
    id: id!,
    name: name!,
    title: title!,
    description: description!,
    author: author!,
    version: String(raw.version).trim(),
    categories,
    icon,
    commands,
    kind: kind as StoreKind,
    minGlideVersion: String(raw.minGlideVersion).trim(),
    download,
    source,
    screenshots,
    changelog: changelog.sort((a, b) => compareVersions(b.version, a.version)),
    homepage: urlField(raw.homepage, `${label}.homepage`, []),
    license: str(raw.license, 60),
  };
}

/** Validate a store index document. Throws StoreIndexError when the document itself is unusable. */
export function validateIndex(json: unknown): IndexValidation {
  if (!isObj(json)) throw new StoreIndexError("Store index must be a JSON object { schemaVersion, extensions }");
  const v = json.schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new StoreIndexError('Store index needs an integer "schemaVersion"');
  if (v > STORE_SCHEMA_VERSION) throw new StoreIndexError(`Store index uses schema v${v}; this Glide understands v${STORE_SCHEMA_VERSION} — update Glide`);
  if (!Array.isArray(json.extensions)) throw new StoreIndexError('Store index needs an "extensions" array');
  const errors: string[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  const extensions: StoreIndexEntry[] = [];
  json.extensions.forEach((raw, i) => {
    const e = parseEntry(raw, i, errors);
    if (!e) return;
    if (seen.has(e.id) || names.has(e.name)) return void errors.push(`extensions[${i}] (${e.id}): duplicate id or name`);
    seen.add(e.id);
    names.add(e.name);
    extensions.push(e);
  });
  return { index: { schemaVersion: v, updatedAt: str(json.updatedAt, 40), extensions }, errors };
}
