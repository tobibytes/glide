/** Validation of an extension's package.json ("glide" block). Pure: no fs access except through `exists`. */

export type PreferenceType = "textfield" | "password" | "checkbox" | "dropdown";

export interface ArgumentManifest {
  name: string;
  placeholder?: string;
  required: boolean;
  /** Raycast argument types (default "text"). */
  type?: "text" | "password" | "dropdown";
  data?: Array<{ value: string; title: string }>;
}

export interface CommandManifest {
  name: string;
  title: string;
  subtitle?: string;
  description?: string;
  /** "menu-bar": a Raycast MenuBarExtra command shown as a status item instead of a launcher view. */
  mode: CommandMode;
  arguments: ArgumentManifest[];
  keywords: string[];
  /** Entry file relative to the extension root. */
  entry: string;
  /** Command icon (Raycast commands may have their own). */
  icon?: string;
  /** Raycast `interval` (e.g. "1m"): background refresh period of no-view and menu-bar commands, in ms. */
  intervalMs?: number;
  /** The manifest's interval text, for display. */
  interval?: string;
}

export type CommandMode = "view" | "no-view" | "menu-bar";

export interface PreferenceManifest {
  name: string;
  title: string;
  description?: string;
  type: PreferenceType;
  default?: string | boolean;
  required: boolean;
  data: Array<{ value: string; title: string }>;
  /** Set for Raycast command-scoped preferences: only that command sees the value. */
  command?: string;
}

export interface ExtensionManifest {
  name: string;
  version: string;
  title: string;
  description: string;
  author?: string;
  icon?: string;
  commands: CommandManifest[];
  preferences: PreferenceManifest[];
  /** "raycast": commands are React components written against @raycast/api (built by Glide on import). */
  runtime?: "glide" | "raycast";
  /** Non-fatal notes (e.g. unsupported Raycast command modes that were skipped). */
  warnings?: string[];
}

export type ManifestResult = { ok: true; manifest: ExtensionManifest } | { ok: false; errors: string[] };

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PREF_TYPES: PreferenceType[] = ["textfield", "password", "checkbox", "dropdown"];

/** Candidate entry files for a command, in priority order. */
export function entryCandidates(command: string): string[] {
  return [`dist/${command}.js`, `dist/${command}.cjs`, `${command}.js`, `${command}.cjs`, `src/${command}.js`, `src/${command}.cjs`];
}

export function isValidName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name) && name !== "." && name !== "..";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function validateManifest(pkg: unknown, exists: (relPath: string) => boolean = () => true): ManifestResult {
  const errors: string[] = [];
  if (!isObj(pkg)) return { ok: false, errors: ["package.json must be a JSON object"] };
  if (!isValidName(pkg.name)) errors.push(`"name" must be 1–64 letters, digits, ".", "_" or "-" (got ${JSON.stringify(pkg.name)})`);
  const g = pkg.glide;
  if (!isObj(g)) return { ok: false, errors: [...errors, 'package.json needs a "glide" object with title, description and commands'] };

  const title = optStr(g.title);
  if (!title) errors.push('"glide.title" is required');
  if (g.icon !== undefined && typeof g.icon !== "string") errors.push('"glide.icon" must be a string');

  const commands: CommandManifest[] = [];
  if (!Array.isArray(g.commands) || g.commands.length === 0) errors.push('"glide.commands" must be a non-empty array');
  else {
    const names = new Set<string>();
    g.commands.forEach((c, i) => {
      const at = `glide.commands[${i}]`;
      if (!isObj(c)) return void errors.push(`${at} must be an object`);
      if (!isValidName(c.name)) return void errors.push(`${at}.name is missing or invalid`);
      if (names.has(c.name)) errors.push(`${at}.name "${c.name}" is duplicated`);
      names.add(c.name);
      const ctitle = optStr(c.title);
      if (!ctitle) errors.push(`${at}.title is required`);
      const mode = c.mode ?? "view";
      if (mode !== "view" && mode !== "no-view") errors.push(`${at}.mode must be "view" or "no-view"`);
      const args: ArgumentManifest[] = [];
      if (c.arguments !== undefined) {
        if (!Array.isArray(c.arguments)) errors.push(`${at}.arguments must be an array`);
        else
          c.arguments.forEach((a, j) => {
            if (!isObj(a) || !isValidName(a.name)) return void errors.push(`${at}.arguments[${j}].name is missing or invalid`);
            args.push({ name: a.name, placeholder: optStr(a.placeholder), required: a.required === true });
          });
      }
      const keywords = Array.isArray(c.keywords) ? c.keywords.filter((k): k is string => typeof k === "string") : [];
      const entry = entryCandidates(c.name).find(exists);
      if (!entry) errors.push(`${at}: no entry file found (expected one of ${entryCandidates(c.name).join(", ")})`);
      commands.push({ name: c.name, title: ctitle ?? c.name, subtitle: optStr(c.subtitle), description: optStr(c.description), mode: mode === "no-view" ? "no-view" : "view", arguments: args, keywords, entry: entry ?? "" });
    });
  }

  const preferences: PreferenceManifest[] = [];
  if (g.preferences !== undefined) {
    if (!Array.isArray(g.preferences)) errors.push('"glide.preferences" must be an array');
    else
      g.preferences.forEach((p, i) => {
        const at = `glide.preferences[${i}]`;
        if (!isObj(p) || !isValidName(p.name)) return void errors.push(`${at}.name is missing or invalid`);
        const type = p.type as PreferenceType;
        if (!PREF_TYPES.includes(type)) return void errors.push(`${at}.type must be one of ${PREF_TYPES.join(", ")}`);
        const data = Array.isArray(p.data) ? p.data.filter(isObj).map((d) => ({ value: String(d.value ?? ""), title: String(d.title ?? d.value ?? "") })) : [];
        if (type === "dropdown" && data.length === 0) errors.push(`${at}: dropdown preferences need "data" options`);
        const def = type === "checkbox" ? (typeof p.default === "boolean" ? p.default : undefined) : typeof p.default === "string" ? p.default : undefined;
        preferences.push({ name: p.name, title: optStr(p.title) ?? p.name, description: optStr(p.description), type, default: def, required: p.required === true, data });
      });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      name: pkg.name as string,
      version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
      title: title as string,
      description: optStr(g.description) ?? optStr(pkg.description) ?? "",
      author: optStr(g.author) ?? (typeof pkg.author === "string" ? pkg.author : isObj(pkg.author) ? optStr(pkg.author.name) : undefined),
      icon: optStr(g.icon),
      commands,
      preferences,
    },
  };
}

/** Preferences visible to a command: extension-wide ones plus those scoped to it (all when no command is given). */
export function preferencesFor(manifest: ExtensionManifest, command?: string): PreferenceManifest[] {
  return command === undefined ? manifest.preferences : manifest.preferences.filter((p) => !p.command || p.command === command);
}

/**
 * Storage key of a preference. Command-scoped preferences are namespaced ("<command>/<name>") so two
 * commands (or a command and the extension) can declare the same name without sharing a value.
 */
export function prefKey(p: Pick<PreferenceManifest, "name" | "command">): string {
  return p.command ? `${p.command}/${p.name}` : p.name;
}

/** Saved value of a preference; command-scoped values saved before namespacing are still read. */
function savedValue(p: PreferenceManifest, saved: Record<string, unknown>): unknown {
  const v = saved[prefKey(p)];
  return v === undefined && p.command ? saved[p.name] : v;
}

function valueOf(p: PreferenceManifest, saved: Record<string, unknown>): string | boolean {
  const v = savedValue(p, saved);
  if (p.type === "checkbox") return typeof v === "boolean" ? v : ((p.default as boolean | undefined) ?? false);
  return typeof v === "string" ? v : ((p.default as string | undefined) ?? "");
}

/** Required preferences with no saved value and no default. */
export function missingPreferences(manifest: ExtensionManifest, saved: Record<string, unknown>, command?: string): PreferenceManifest[] {
  return preferencesFor(manifest, command).filter((p) => {
    if (!p.required) return false;
    const v = savedValue(p, saved) ?? p.default;
    return v === undefined || v === "";
  });
}

/**
 * What a command sees (getPreferenceValues): saved values over defaults, keyed by preference name;
 * a command-scoped preference wins over an extension preference with the same name.
 * Without a command, every preference keyed by prefKey (the preferences form).
 */
export function resolvePreferences(manifest: ExtensionManifest, saved: Record<string, unknown>, command?: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (command === undefined) {
    for (const p of manifest.preferences) out[prefKey(p)] = valueOf(p, saved);
    return out;
  }
  const visible = preferencesFor(manifest, command);
  for (const p of visible.filter((x) => !x.command)) out[p.name] = valueOf(p, saved);
  for (const p of visible.filter((x) => x.command)) out[p.name] = valueOf(p, saved);
  return out;
}

const INTERVAL_RE = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Raycast's lower bound for `interval`. */
export const MIN_INTERVAL_MS = 10_000;

/** Raycast `interval` ("90s", "5m", "12h", "1d") → ms; null when malformed or below 10 s. */
export function parseInterval(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = INTERVAL_RE.exec(v.trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  return ms >= MIN_INTERVAL_MS ? ms : null;
}

/** Map the launcher's single argument string onto declared arguments: one per word, the last takes the rest. */
export function splitArguments(args: ArgumentManifest[], text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const rest = (text ?? "").trim();
  if (args.length === 1) {
    out[args[0].name] = rest;
    return out;
  }
  const words = rest ? rest.split(/\s+/) : [];
  args.forEach((a, i) => {
    out[a.name] = i === args.length - 1 ? words.slice(i).join(" ") : (words[i] ?? "");
  });
  return out;
}
