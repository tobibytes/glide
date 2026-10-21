/**
 * Script Command metadata parser (Raycast-compatible). Metadata lives in comment lines:
 *   # @raycast.title My Script        (also // and -- comment styles, and the @glide. prefix)
 */
export type ScriptMode = "fullOutput" | "compact" | "silent" | "inline";
export const SCRIPT_MODES: ScriptMode[] = ["fullOutput", "compact", "silent", "inline"];

export interface ScriptArgument {
  type: "text" | "password" | "dropdown";
  placeholder: string;
  optional: boolean;
  percentEncoded: boolean;
  data?: Array<{ title: string; value: string }>;
}

export interface ScriptMeta {
  title?: string;
  mode?: ScriptMode;
  icon?: string;
  packageName?: string;
  description?: string;
  author?: string;
  /** ms; only meaningful for inline mode */
  refreshTime?: number;
  needsConfirmation: boolean;
  currentDirectoryPath?: string;
  arguments: ScriptArgument[];
  errors: string[];
}

const LINE = /^\s*(?:#|\/\/|--)\s*@(?:raycast|glide)\.([A-Za-z]+\d*)\s*(.*?)\s*$/;
const MIN_REFRESH_MS = 10_000;

/** "10s" | "5m" | "1h" | "1d" → ms. */
export function parseDuration(text: string): number | null {
  const m = text.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (!m) return null;
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * mult);
}

function parseArgument(raw: string, n: number, errors: string[]): ScriptArgument | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    errors.push(`argument${n} is not valid JSON`);
    return null;
  }
  if (!obj || typeof obj !== "object") {
    errors.push(`argument${n} must be a JSON object`);
    return null;
  }
  const o = obj as Record<string, unknown>;
  const type = o.type ?? "text";
  if (type !== "text" && type !== "password" && type !== "dropdown") {
    errors.push(`argument${n} has unsupported type "${String(type)}"`);
    return null;
  }
  const arg: ScriptArgument = {
    type,
    placeholder: typeof o.placeholder === "string" ? o.placeholder : `Argument ${n}`,
    optional: o.optional === true,
    percentEncoded: o.percentEncoded === true,
  };
  if (type === "dropdown") {
    const data = Array.isArray(o.data) ? o.data : [];
    arg.data = data.flatMap((d) => (d && typeof d === "object" && typeof (d as Record<string, unknown>).value === "string" ? [{ title: String((d as Record<string, unknown>).title ?? (d as Record<string, unknown>).value), value: String((d as Record<string, unknown>).value) }] : []));
    if (!arg.data.length) errors.push(`argument${n} dropdown needs a non-empty "data" list`);
  }
  return arg;
}

export function parseScript(source: string): ScriptMeta {
  const meta: ScriptMeta = { needsConfirmation: false, arguments: [], errors: [] };
  const args = new Map<number, ScriptArgument>();
  for (const line of source.split(/\r?\n/).slice(0, 200)) {
    const m = line.match(LINE);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case "title":
        meta.title = value || undefined;
        break;
      case "mode":
        if ((SCRIPT_MODES as string[]).includes(value)) meta.mode = value as ScriptMode;
        else meta.errors.push(`Unknown mode "${value}" (use ${SCRIPT_MODES.join(", ")})`);
        break;
      case "icon":
        meta.icon = value || undefined;
        break;
      case "packageName":
        meta.packageName = value || undefined;
        break;
      case "description":
        meta.description = value || undefined;
        break;
      case "author":
        meta.author = value || undefined;
        break;
      case "needsConfirmation":
        meta.needsConfirmation = value === "true";
        break;
      case "currentDirectoryPath":
        meta.currentDirectoryPath = value || undefined;
        break;
      case "refreshTime": {
        const ms = parseDuration(value);
        if (ms === null) meta.errors.push(`Invalid refreshTime "${value}" (e.g. 30s, 5m, 1h, 1d)`);
        else meta.refreshTime = Math.max(MIN_REFRESH_MS, ms);
        break;
      }
      default: {
        const a = key.match(/^argument(\d)$/);
        if (a) {
          const n = Number(a[1]);
          if (n < 1 || n > 3) meta.errors.push(`Only argument1…argument3 are supported`);
          else {
            const arg = parseArgument(value, n, meta.errors);
            if (arg) args.set(n, arg);
          }
        }
      }
    }
  }
  if (!meta.title) meta.errors.push("Missing @raycast.title");
  if (!meta.mode) {
    if (!meta.errors.some((e) => e.startsWith("Unknown mode"))) meta.errors.push("Missing @raycast.mode");
  }
  for (let n = 1; n <= 3; n++) {
    const arg = args.get(n);
    if (!arg) {
      if ([...args.keys()].some((k) => k > n)) meta.errors.push(`argument${n} is missing but a later argument is declared`);
      break;
    }
    meta.arguments.push(arg);
  }
  return meta;
}

/** Split typed text into script arguments: shell-like quoting; the last argument takes the rest verbatim. */
export function splitArguments(text: string, count: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest && out.length < count - 1) {
    const m = rest.match(/^"((?:[^"\\]|\\.)*)"\s*|^'([^']*)'\s*|^(\S+)\s*/);
    if (!m) break;
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
    rest = rest.slice(m[0].length);
  }
  if (rest && out.length < count) {
    const q = rest.match(/^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/);
    out.push(q ? (q[1] !== undefined ? q[1].replace(/\\(.)/g, "$1") : q[2]) : rest);
  }
  return out;
}

export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}
