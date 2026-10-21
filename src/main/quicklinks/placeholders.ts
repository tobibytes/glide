/**
 * Placeholder templates shared by quicklinks and snippets (pure; no Electron imports).
 *
 * Grammar: `{name attr="value" attr2='v' | modifier | modifier}`. Anything that does not parse as a
 * known placeholder stays literal text, so JSON or code in a snippet survives untouched.
 *
 * Known names: query, argument, clipboard, selection, date, time, datetime, day, uuid, cursor, snippet.
 * Modifiers: raw, percent-encode, uppercase, lowercase, trim, json-stringify.
 */
import { applyDateOffset, formatDate } from "./dates";

export const PLACEHOLDER_NAMES = ["query", "argument", "clipboard", "selection", "date", "time", "datetime", "day", "uuid", "cursor", "snippet"] as const;
export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

export const MODIFIERS = ["raw", "percent-encode", "uppercase", "lowercase", "trim", "json-stringify"] as const;
export type Modifier = (typeof MODIFIERS)[number];

export interface Placeholder {
  type: "placeholder";
  name: PlaceholderName;
  attrs: Record<string, string>;
  modifiers: Modifier[];
  /** Exact source text, e.g. `{date format="yyyy"}`. */
  raw: string;
}
export interface Literal {
  type: "text";
  text: string;
}
export type Token = Literal | Placeholder;

const NAME_SET = new Set<string>(PLACEHOLDER_NAMES);
const MOD_SET = new Set<string>(MODIFIERS);

/** Parse the inside of `{…}`; undefined when it is not a placeholder. */
function parseInner(inner: string): Omit<Placeholder, "type" | "raw"> | undefined {
  const [head, ...pipes] = splitPipes(inner);
  const m = /^\s*([a-z]+)\b([\s\S]*)$/.exec(head ?? "");
  if (!m || !NAME_SET.has(m[1]!)) return undefined;
  const attrs: Record<string, string> = {};
  let rest = m[2]!.trim();
  while (rest) {
    const a = /^([a-zA-Z][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"']+))\s*/.exec(rest);
    if (!a) return undefined;
    attrs[a[1]!] = (a[2] ?? a[3] ?? a[4] ?? "").replace(/\\(["'\\])/g, "$1");
    rest = rest.slice(a[0].length);
  }
  const modifiers: Modifier[] = [];
  for (const p of pipes) {
    const mod = p.trim();
    if (!MOD_SET.has(mod)) return undefined;
    modifiers.push(mod as Modifier);
  }
  return { name: m[1] as PlaceholderName, attrs, modifiers };
}

/** Split on `|` outside quotes. */
function splitPipes(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < s.length) {
        cur += c + s[++i];
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "|") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseTemplate(template: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i]!;
    if (c === "{") {
      const end = findClose(template, i + 1);
      if (end > 0) {
        const raw = template.slice(i, end + 1);
        const parsed = parseInner(template.slice(i + 1, end));
        if (parsed) {
          if (text) tokens.push({ type: "text", text });
          text = "";
          tokens.push({ type: "placeholder", ...parsed, raw });
          i = end + 1;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  if (text) tokens.push({ type: "text", text });
  return tokens;
}

/** Index of the `}` closing a placeholder that starts at `from` (quotes may contain braces); -1 if none. */
function findClose(s: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "\n") return -1;
    else if (c === "}") return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface ArgumentDef {
  /** Key used in the values map. `{query}` is the argument "query". */
  name: string;
  /** Text shown in the launcher's argument field. */
  placeholder: string;
  default?: string;
  options?: string[];
  /** Arguments without a default (or with options) must be filled; "optional" is never enforced by the launcher. */
  optional: boolean;
}

const splitOptions = (s: string) =>
  s
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

/**
 * Arguments in the order they first appear. Placeholders that share a name share one argument;
 * each unnamed `{argument}` is its own ("argument", "argument 2", …).
 */
export function argumentsOf(template: string | Token[]): ArgumentDef[] {
  const tokens = typeof template === "string" ? parseTemplate(template) : template;
  const out: ArgumentDef[] = [];
  const byName = new Map<string, ArgumentDef>();
  let unnamed = 0;
  for (const t of tokens) {
    if (t.type !== "placeholder" || (t.name !== "argument" && t.name !== "query")) continue;
    let name = t.name === "query" ? "query" : t.attrs.name?.trim();
    if (!name) name = ++unnamed === 1 ? "argument" : `argument ${unnamed}`;
    const existing = byName.get(name);
    const options = t.attrs.options !== undefined ? splitOptions(t.attrs.options) : undefined;
    if (existing) {
      if (existing.default === undefined && t.attrs.default !== undefined) existing.default = t.attrs.default;
      if (!existing.options && options?.length) existing.options = options;
      continue;
    }
    const def: ArgumentDef = {
      name,
      placeholder: t.attrs.placeholder?.trim() || (name === "query" ? "Query" : name),
      ...(t.attrs.default !== undefined ? { default: t.attrs.default } : {}),
      ...(options?.length ? { options } : {}),
      optional: t.attrs.optional === "true" || t.attrs.default !== undefined,
    };
    byName.set(name, def);
    out.push(def);
  }
  return out;
}

/** Map the token to the argument name argumentsOf() assigned it. */
function argumentName(t: Placeholder, unnamedCounter: { n: number }): string {
  if (t.name === "query") return "query";
  const n = t.attrs.name?.trim();
  if (n) return n;
  return ++unnamedCounter.n === 1 ? "argument" : `argument ${unnamedCounter.n}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderEnv {
  now: Date;
  clipboard?: string;
  selection?: string;
  uuid(): string;
  /** Values typed in the launcher, keyed by ArgumentDef.name. */
  arguments?: Record<string, string>;
  /** Text of another snippet by name (snippets only); return undefined when unknown. */
  snippet?(name: string): string | undefined;
}

export interface RenderOptions {
  /** Percent-encode every value (quicklinks). `raw="true"` / `| raw` opt out per placeholder. */
  encode?: boolean;
  /** Escape values for HTML (rich-text snippets). */
  html?: boolean;
  /** Marker inserted where `{cursor}` was; the caller locates and removes it. Default "" (dropped). */
  cursorMarker?: string;
}

export const encodeValue = (s: string) => encodeURIComponent(s);
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function baseValue(t: Placeholder, env: RenderEnv, counter: { n: number }): string {
  switch (t.name) {
    case "query":
    case "argument": {
      const name = argumentName(t, counter);
      const v = env.arguments?.[name];
      return v !== undefined && v !== "" ? v : (t.attrs.default ?? "");
    }
    case "clipboard":
      return env.clipboard ?? "";
    case "selection":
      return env.selection ?? "";
    case "uuid":
      return env.uuid();
    case "date":
    case "time":
    case "datetime":
    case "day": {
      const d = t.attrs.offset ? applyDateOffset(env.now, t.attrs.offset) : env.now;
      const fallback = t.name === "date" ? "yyyy-MM-dd" : t.name === "time" ? "HH:mm" : t.name === "day" ? "EEEE" : "yyyy-MM-dd HH:mm";
      return formatDate(d, t.attrs.format || fallback);
    }
    case "snippet":
      return ""; // resolved by the caller (needs recursion control)
    case "cursor":
      return "";
  }
}

/** True when the placeholder sits where a URL's scheme/host would be (e.g. the whole quicklink is `{clipboard}`). */
function atUrlStart(tokens: Token[], index: number): boolean {
  for (let i = 0; i < index; i++) {
    const t = tokens[i]!;
    if (t.type === "text" && t.text.trim()) return false;
    if (t.type === "placeholder") return false;
  }
  return true;
}

export function applyModifiers(value: string, modifiers: Modifier[]): string {
  let v = value;
  for (const m of modifiers) {
    if (m === "uppercase") v = v.toUpperCase();
    else if (m === "lowercase") v = v.toLowerCase();
    else if (m === "trim") v = v.trim();
    else if (m === "json-stringify") v = JSON.stringify(v);
    else if (m === "percent-encode") v = encodeValue(v);
  }
  return v;
}

/**
 * Render tokens to a string. Snippet references are resolved through env.snippet with the SAME
 * options (so nested snippets are not double-encoded) and a depth guard against cycles.
 */
export function renderTokens(tokens: Token[], env: RenderEnv, opts: RenderOptions = {}, depth = 0, seen: ReadonlySet<string> = new Set()): string {
  const counter = { n: 0 };
  let out = "";
  tokens.forEach((t, i) => {
    if (t.type === "text") {
      out += t.text;
      return;
    }
    if (t.name === "cursor") {
      out += opts.cursorMarker ?? "";
      return;
    }
    let value: string;
    if (t.name === "snippet") {
      const name = t.attrs.name?.trim() ?? "";
      const body = name && depth < 5 && !seen.has(name.toLowerCase()) ? env.snippet?.(name) : undefined;
      // Nested snippet text is already in the target format; its own {cursor} markers are dropped.
      // Nested bodies are plain text: render them unescaped, then escape once for an HTML target.
      value = body === undefined ? "" : renderTokens(parseTemplate(body), env, { ...opts, html: false, cursorMarker: "" }, depth + 1, new Set([...seen, name.toLowerCase()]));
      value = applyModifiers(value, t.modifiers);
      out += opts.html ? escapeHtml(value).replace(/\n/g, "<br>") : value;
      return;
    }
    value = applyModifiers(baseValue(t, env, counter), t.modifiers.filter((m) => m !== "percent-encode"));
    const raw = t.attrs.raw === "true" || t.modifiers.includes("raw");
    const explicitEncode = t.modifiers.includes("percent-encode") || t.attrs.encode === "true";
    if (explicitEncode || (opts.encode && !raw && !atUrlStart(tokens, i))) value = encodeValue(value);
    if (opts.html) value = escapeHtml(value);
    out += value;
  });
  return out;
}

export function renderTemplate(template: string, env: RenderEnv, opts: RenderOptions = {}): string {
  return renderTokens(parseTemplate(template), env, opts);
}

/** True when rendering depends on time, clipboard, selection, uuid or other snippets. */
export function isDynamic(template: string): boolean {
  return parseTemplate(template).some((t) => t.type === "placeholder" && t.name !== "cursor" && t.name !== "argument" && t.name !== "query");
}

export function usesPlaceholder(template: string, name: PlaceholderName): boolean {
  return parseTemplate(template).some((t) => t.type === "placeholder" && t.name === name);
}
