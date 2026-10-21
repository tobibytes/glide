/**
 * Text transforms. Pure (no Electron/DOM/Node APIs beyond TextEncoder/atob/btoa/crypto), so the
 * renderer previews them live and main runs the same code for root-search commands.
 */
import { md5, sha1, sha256 } from "./hash";

export type TransformCategory = "Case" | "Lines" | "Inspect" | "Encode" | "Data" | "Generate";

export interface TransformOptions {
  /** Line width for "wrap" (default 80). */
  width?: number;
  now?: Date;
  uuid?: () => string;
}

export interface TransformDef {
  id: string;
  title: string;
  category: TransformCategory;
  keywords: string[];
  /** False for generators (UUID) that ignore the input. */
  usesInput: boolean;
  run(input: string, opts: TransformOptions): string;
}

export class TransformError extends Error {}

export type TransformResult = { ok: true; output: string } | { ok: false; error: string };

// --- helpers ------------------------------------------------------------------

/** "fooBar baz-qux_HTTPServer" → ["foo", "Bar", "baz", "qux", "HTTP", "Server"] */
export function splitWords(s: string): string[] {
  return (
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

const perLine = (input: string, fn: (line: string) => string) => input.split("\n").map(fn).join("\n");
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
const lines = (input: string) => input.replace(/\r\n?/g, "\n").split("\n");

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const clean = b64.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new TransformError("Not valid Base64");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new TransformError("Not valid Base64");
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TransformError("Decoded bytes are not UTF-8 text");
  }
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (err) {
    throw new TransformError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const HTML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function wrap(input: string, width: number): string {
  return perLine(input, (line) => {
    if (line.length <= width) return line;
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    const out: string[] = [];
    let cur = "";
    for (const word of line.trim().split(/\s+/)) {
      if (cur && cur.length + 1 + word.length > width - indent.length) {
        out.push(indent + cur);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(indent + cur);
    return out.join("\n");
  });
}

function timestamp(input: string, now: Date): string {
  const t = input.trim();
  if (!t) return `${Math.floor(now.getTime() / 1000)}\n${now.toISOString()}`;
  if (/^-?\d{1,16}(\.\d+)?$/.test(t)) {
    const n = Number(t);
    // 13+ digits is milliseconds; otherwise seconds.
    const ms = Math.abs(n) >= 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) throw new TransformError("Timestamp out of range");
    return d.toISOString();
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new TransformError("Not a unix timestamp or a date");
  return String(Math.floor(ms / 1000));
}

function jwtDecode(input: string): string {
  const parts = input.trim().split(".");
  if (parts.length < 2 || parts.length > 3) throw new TransformError("Not a JWT (expected header.payload.signature)");
  const part = (s: string, what: string) => {
    try {
      return JSON.parse(fromBase64(s)) as unknown;
    } catch {
      throw new TransformError(`JWT ${what} is not Base64URL JSON`);
    }
  };
  const header = part(parts[0], "header");
  const payload = part(parts[1], "payload");
  const notes: string[] = ["// Decoded only. The signature is NOT verified."];
  if (payload && typeof payload === "object") {
    for (const k of ["iat", "nbf", "exp"] as const) {
      const v = (payload as Record<string, unknown>)[k];
      if (typeof v === "number") notes.push(`// ${k}: ${new Date(v * 1000).toISOString()}`);
    }
  }
  return `${notes.join("\n")}\n${JSON.stringify({ header, payload }, null, 2)}`;
}

function markdownToPlain(md: string): string {
  return lines(md)
    .filter((l) => !/^\s*(```|~~~)/.test(l))
    .map((l) =>
      l
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, "")
        .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, "$1• ")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2")
        .replace(/~~(.+?)~~/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/<\/?[a-z][^>]*>/gi, ""),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function counts(input: string): string {
  const words = input.trim() ? input.trim().split(/\s+/).length : 0;
  const lineCount = input ? lines(input).length : 0;
  const paragraphs = input.trim() ? input.trim().split(/\n\s*\n/).length : 0;
  const chars = [...input].length;
  const noSpace = [...input.replace(/\s/g, "")].length;
  return [`Characters: ${chars}`, `Characters (no spaces): ${noSpace}`, `Words: ${words}`, `Lines: ${lineCount}`, `Paragraphs: ${paragraphs}`].join("\n");
}

const def = (id: string, title: string, category: TransformCategory, keywords: string[], run: TransformDef["run"], usesInput = true): TransformDef => ({ id, title, category, keywords, usesInput, run });

export const TRANSFORMS: TransformDef[] = [
  def("upper", "UPPERCASE", "Case", ["uppercase", "upper case", "caps"], (s) => s.toUpperCase()),
  def("lower", "lowercase", "Case", ["lowercase", "lower case"], (s) => s.toLowerCase()),
  def("title", "Title Case", "Case", ["title case", "capitalize"], (s) => s.replace(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu, cap)),
  def("sentence", "Sentence case", "Case", ["sentence case"], (s) => s.toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase())),
  def("camel", "camelCase", "Case", ["camel case", "camelcase"], (s) => perLine(s, (l) => splitWords(l).map((w, i) => (i ? cap(w) : w.toLowerCase())).join(""))),
  def("pascal", "PascalCase", "Case", ["pascal case", "upper camel"], (s) => perLine(s, (l) => splitWords(l).map(cap).join(""))),
  def("snake", "snake_case", "Case", ["snake case", "underscore"], (s) => perLine(s, (l) => splitWords(l).map((w) => w.toLowerCase()).join("_"))),
  def("constant", "CONSTANT_CASE", "Case", ["constant case", "screaming snake"], (s) => perLine(s, (l) => splitWords(l).map((w) => w.toUpperCase()).join("_"))),
  def("kebab", "kebab-case", "Case", ["kebab case", "dash case", "hyphen"], (s) => perLine(s, (l) => splitWords(l).map((w) => w.toLowerCase()).join("-"))),
  def("slugify", "Slugify", "Case", ["slug", "url slug", "permalink"], (s) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  ),
  def("trim", "Trim Whitespace", "Lines", ["trim", "strip", "whitespace"], (s) => perLine(s.trim(), (l) => l.trim())),
  def("sort", "Sort Lines", "Lines", ["sort lines", "alphabetical"], (s) => lines(s).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).join("\n")),
  def("dedupe", "Remove Duplicate Lines", "Lines", ["dedupe", "unique", "duplicates", "uniq"], (s) => [...new Set(lines(s))].join("\n")),
  def("reverse-lines", "Reverse Lines", "Lines", ["reverse lines", "flip"], (s) => lines(s).reverse().join("\n")),
  def("reverse", "Reverse Text", "Lines", ["reverse text", "backwards"], (s) => [...s].reverse().join("")),
  def("wrap", "Wrap Lines", "Lines", ["wrap", "hard wrap", "line width", "80 columns"], (s, o) => wrap(s, Math.max(10, o.width ?? 80))),
  def("count", "Count Words & Characters", "Inspect", ["count", "word count", "characters", "lines", "length"], counts),
  def("json-pretty", "JSON Pretty Print", "Data", ["json pretty", "format json", "beautify"], (s) => JSON.stringify(parseJson(s), null, 2)),
  def("json-minify", "JSON Minify", "Data", ["json minify", "compact json"], (s) => JSON.stringify(parseJson(s))),
  def("json-validate", "JSON Validate", "Data", ["json validate", "lint json", "check json"], (s) => {
    const v = parseJson(s);
    const kind = Array.isArray(v) ? `array of ${v.length}` : v === null ? "null" : typeof v === "object" ? `object with ${Object.keys(v as object).length} keys` : typeof v;
    return `✓ Valid JSON (${kind})`;
  }),
  def("markdown-plain", "Markdown to Plain Text", "Data", ["markdown", "strip markdown", "plain text"], markdownToPlain),
  def("jwt", "Decode JWT (unverified)", "Data", ["jwt", "json web token", "decode token", "bearer"], jwtDecode),
  def("timestamp", "Unix Timestamp ↔ ISO Date", "Data", ["timestamp", "epoch", "unix time", "iso date", "date"], (s, o) => timestamp(s, o.now ?? new Date())),
  def("base64-encode", "Base64 Encode", "Encode", ["base64 encode", "b64"], toBase64),
  def("base64-decode", "Base64 Decode", "Encode", ["base64 decode", "b64 decode"], fromBase64),
  def("url-encode", "URL Encode", "Encode", ["url encode", "percent encode", "uri"], (s) => encodeURIComponent(s)),
  def("url-decode", "URL Decode", "Encode", ["url decode", "percent decode"], (s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      throw new TransformError("Malformed percent-encoding");
    }
  }),
  def("html-escape", "HTML Escape", "Encode", ["html escape", "entities", "encode html"], (s) => s.replace(/[&<>"']/g, (c) => HTML_ESC[c])),
  def("html-unescape", "HTML Unescape", "Encode", ["html unescape", "decode entities"], (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[k] ?? m;
    }),
  ),
  def("md5", "MD5 Hash", "Encode", ["md5", "hash", "checksum"], md5),
  def("sha1", "SHA-1 Hash", "Encode", ["sha1", "hash", "checksum"], sha1),
  def("sha256", "SHA-256 Hash", "Encode", ["sha256", "hash", "checksum"], sha256),
  def("uuid", "Generate UUID", "Generate", ["uuid", "guid", "random id"], (_s, o) => (o.uuid ?? (() => globalThis.crypto.randomUUID()))(), false),
];

export const transformById = (id: string): TransformDef | undefined => TRANSFORMS.find((t) => t.id === id);

export function applyTransform(id: string, input: string, opts: TransformOptions = {}): TransformResult {
  const t = transformById(id);
  if (!t) return { ok: false, error: `Unknown transform ${id}` };
  if (t.usesInput && !input && t.id !== "timestamp") return { ok: false, error: "No input text — select some text or copy it first" };
  try {
    return { ok: true, output: t.run(input, opts) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** "wrap 60" → { query: "wrap", width: 60 }: a trailing number in the filter sets the wrap width. */
export function parseQuery(q: string): { query: string; width?: number } {
  const m = /^(.*?)\s*(\d{2,3})\s*$/.exec(q);
  return m && /wrap/i.test(m[1]) ? { query: m[1], width: Number(m[2]) } : { query: q };
}
