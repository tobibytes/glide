/**
 * A tiny, strict tar(.gz) reader/writer for store packages. Only regular files and directories are
 * accepted; links, devices, absolute paths and ".." traversal are rejected before anything is written.
 * Node built-ins only and erasable TypeScript syntax, so scripts/store-pack.mjs can import it directly.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface TarFile {
  path: string;
  type: "file" | "dir";
  mode: number;
  data: Buffer;
}

export interface TarLimits {
  maxEntries: number;
  /** Total uncompressed bytes of file data. */
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = { maxEntries: 5000, maxTotalBytes: 100 * 1024 * 1024, maxFileBytes: 50 * 1024 * 1024 };

export class TarError extends Error {}

const BLOCK = 512;

function cstr(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
}

function octal(buf: Buffer, start: number, len: number, what: string): number {
  const field = buf.subarray(start, start + len);
  if (field[0]! & 0x80) throw new TarError(`Unsupported base-256 ${what} field`);
  const s = cstr(buf, start, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError(`Corrupt ${what} field`);
  return parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  const stored = octal(h, 148, 8, "checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === stored;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const len = Number(data.subarray(off, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || off + len > data.length) throw new TarError("Corrupt pax header");
    const rec = data.subarray(sp + 1, off + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

/** Normalise an archive path; throws for anything that could escape the destination. */
export function safeEntryPath(raw: string): string {
  if (raw.includes("\0")) throw new TarError(`Illegal NUL in path`);
  if (raw.includes("\\")) throw new TarError(`Backslashes are not allowed in paths: ${raw}`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new TarError(`Absolute path in archive: ${raw}`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new TarError(`Path traversal in archive: ${raw}`);
  if (!parts.length) throw new TarError(`Empty path in archive`);
  const out = parts.join("/");
  if (out.length > 1024 || parts.length > 32) throw new TarError(`Path too long: ${raw.slice(0, 80)}…`);
  return out;
}

/** Parse an uncompressed tar archive into its entries (validated, nothing written). */
export function readTar(buf: Buffer, limits: TarLimits = DEFAULT_TAR_LIMITS): TarFile[] {
  const out: TarFile[] = [];
  const seen = new Map<string, "file" | "dir">();
  let off = 0;
  let total = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw new TarError("Corrupt tar header (bad checksum)");
    const type = String.fromCharCode(h[156]!) || "0";
    let size = octal(h, 124, 12, "size");
    if (pax.size !== undefined) size = Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new TarError("Corrupt entry size");
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError("Truncated tar archive");
    const data = buf.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      if (size > 64 * 1024) throw new TarError("pax header too large");
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      if (size > 4096) throw new TarError("GNU long name too large");
      longName = cstr(data, 0, data.length);
      continue;
    }
    const magic = cstr(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? cstr(h, 345, 155) : "";
    const rawName = pax.path ?? longName ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    pax = {};
    longName = null;

    let kind: "file" | "dir";
    if (type === "0" || type === "\0") kind = "file";
    else if (type === "5") kind = "dir";
    else {
      const what = type === "1" ? "hard link" : type === "2" ? "symbolic link" : type === "3" || type === "4" ? "device" : type === "6" ? "FIFO" : `entry type "${type}"`;
      throw new TarError(`Archive contains a ${what} (${rawName}); only files and folders are allowed`);
    }
    const p = safeEntryPath(rawName);
    if (kind === "file") {
      if (size > limits.maxFileBytes) throw new TarError(`${p} is too large`);
      total += size;
      if (total > limits.maxTotalBytes) throw new TarError("Archive is too large when extracted");
    }
    const prev = seen.get(p);
    if (prev && !(prev === "dir" && kind === "dir")) throw new TarError(`Duplicate path in archive: ${p}`);
    // A path may not live below something that is a file.
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) if (seen.get(segs.slice(0, i).join("/")) === "file") throw new TarError(`${p} is inside a file`);
    seen.set(p, kind);
    if (!prev) out.push({ path: p, type: kind, mode: octal(h, 100, 8, "mode"), data: kind === "file" ? Buffer.from(data) : Buffer.alloc(0) });
    if (out.length > limits.maxEntries) throw new TarError("Archive has too many entries");
  }
  for (const f of out) if (f.type === "file") for (let i = 1, s = f.path.split("/"); i < s.length; i++) if (seen.get(s.slice(0, i).join("/")) === "file") throw new TarError(`${f.path} is inside a file`);
  return out;
}

export function gunzipLimited(gz: Buffer, maxBytes: number = DEFAULT_TAR_LIMITS.maxTotalBytes + 2 * 1024 * 1024): Buffer {
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large/i.test(e.message ?? "")) throw new TarError("Archive is too large when decompressed");
    throw new TarError(`Not a valid .tgz: ${e.message ?? String(err)}`);
  }
}

/** Strip a single common top-level folder (npm's "package/") when there is no package.json at the root. */
export function stripCommonRoot(files: TarFile[]): TarFile[] {
  if (files.some((f) => f.path === "package.json")) return files;
  const first = files[0]?.path.split("/")[0];
  if (!first || !files.every((f) => f.path === first || f.path.startsWith(`${first}/`))) return files;
  return files.filter((f) => f.path !== first).map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

/**
 * Extract validated entries into `dest`, which must not exist yet (it is created). Files are created
 * exclusively (never through an existing path) with 0644/0755 permissions.
 */
export function writeEntries(files: TarFile[], dest: string): void {
  const root = path.resolve(dest);
  if (fs.existsSync(root)) throw new TarError(`Destination already exists: ${root}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const f of files) {
    const target = path.resolve(root, ...f.path.split("/"));
    if (target !== root && !target.startsWith(root + path.sep)) throw new TarError(`Path escapes destination: ${f.path}`);
    if (f.type === "dir") {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, f.data, { flag: "wx", mode: f.mode & 0o111 ? 0o755 : 0o644 });
  }
}

/** gunzip + validate + extract a store package into `dest` (created). Returns the extracted paths. */
export function extractTgz(gz: Buffer, dest: string, limits: TarLimits = DEFAULT_TAR_LIMITS): string[] {
  const files = stripCommonRoot(readTar(gunzipLimited(gz, limits.maxTotalBytes + 2 * 1024 * 1024), limits));
  if (!files.length) throw new TarError("Archive is empty");
  writeEntries(files, dest);
  return files.map((f) => f.path);
}

// --- writer (store-pack and tests) ----------------------------------------------------------------

function header(name: string, size: number, type: "0" | "5" | "2" | "1", mode: number, linkname = ""): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new TarError(`Path too long for ustar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

export interface TarInput {
  path: string;
  /** Omit for a directory. */
  data?: Buffer | string;
  mode?: number;
  /** Test-only: write a raw link entry. */
  link?: { type: "symlink" | "hardlink"; target: string };
}

/** Build an uncompressed ustar archive. Paths are written verbatim (tests use this for hostile fixtures). */
export function createTar(entries: TarInput[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    if (e.link) {
      chunks.push(header(e.path, 0, e.link.type === "symlink" ? "2" : "1", 0o777, e.link.target));
      continue;
    }
    if (e.data === undefined) {
      chunks.push(header(e.path.endsWith("/") ? e.path : `${e.path}/`, 0, "5", e.mode ?? 0o755));
      continue;
    }
    const data = typeof e.data === "string" ? Buffer.from(e.data) : e.data;
    chunks.push(header(e.path, data.length, "0", e.mode ?? 0o644), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

export function createTgz(entries: TarInput[]): Buffer {
  return zlib.gzipSync(createTar(entries), { level: 9 });
}
