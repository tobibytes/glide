/**
 * Translation of a Raycast extension's package.json (top-level `commands`, `preferences`, `icon`…)
 * into Glide's ExtensionManifest. Pure: file checks go through `exists`.
 */
import { isValidName, parseInterval, type ArgumentManifest, type CommandManifest, type ExtensionManifest, type ManifestResult, type PreferenceManifest, type PreferenceType } from "./manifest";

/** Where Glide writes each command's bundle when importing (relative to the installed extension). */
export const RAYCAST_BUILD_DIR = ".glide-build";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A Raycast manifest: no "glide" block, a top-level commands array, and a Raycast marker. */
export function isRaycastPackage(pkg: unknown): pkg is Record<string, unknown> {
  if (!isObj(pkg) || isObj(pkg.glide) || !Array.isArray(pkg.commands)) return false;
  const deps = { ...(isObj(pkg.dependencies) ? pkg.dependencies : {}), ...(isObj(pkg.devDependencies) ? pkg.devDependencies : {}) };
  return "@raycast/api" in deps || (typeof pkg.$schema === "string" && pkg.$schema.includes("raycast")) || pkg.commands.some((c) => isObj(c) && typeof c.mode === "string");
}

/** Source files Glide bundles for a command (Raycast convention: src/<command>.tsx). */
export function raycastSourceCandidates(command: string): string[] {
  return ["tsx", "ts", "jsx", "js"].map((ext) => `src/${command}.${ext}`);
}

/** Bundle produced on import, then a pre-built `ray build` output as fallback. */
export function raycastEntryCandidates(command: string): string[] {
  return [`${RAYCAST_BUILD_DIR}/${command}.cjs`, `dist/${command}.js`];
}

function preferenceType(t: unknown): { type: PreferenceType; note?: string } | null {
  switch (t) {
    case "textfield":
    case "password":
    case "checkbox":
    case "dropdown":
      return { type: t };
    case "appPicker":
      return { type: "textfield", note: "Application name or path" };
    case "file":
      return { type: "textfield", note: "File path" };
    case "directory":
      return { type: "textfield", note: "Folder path" };
    default:
      return null;
  }
}

function translatePreferences(list: unknown, at: string, errors: string[], command?: string): PreferenceManifest[] {
  const out: PreferenceManifest[] = [];
  if (list === undefined) return out;
  if (!Array.isArray(list)) {
    errors.push(`${at} must be an array`);
    return out;
  }
  list.forEach((p, i) => {
    if (!isObj(p) || !isValidName(p.name)) return void errors.push(`${at}[${i}].name is missing or invalid`);
    const t = preferenceType(p.type);
    if (!t) return void errors.push(`${at}[${i}].type "${String(p.type)}" is not supported`);
    const data = Array.isArray(p.data) ? p.data.filter(isObj).map((d) => ({ value: String(d.value ?? ""), title: String(d.title ?? d.value ?? "") })) : [];
    if (t.type === "dropdown" && data.length === 0) errors.push(`${at}[${i}]: dropdown preferences need "data" options`);
    const def = t.type === "checkbox" ? (typeof p.default === "boolean" ? p.default : undefined) : typeof p.default === "string" ? p.default : undefined;
    const description = [optStr(p.description), t.note].filter(Boolean).join(" — ") || undefined;
    const pref: PreferenceManifest = {
      name: p.name,
      // Raycast checkboxes show `label` next to the box and `title` as the row title.
      title: optStr(p.title) ?? optStr(p.label) ?? p.name,
      description: t.type === "checkbox" ? (optStr(p.label) ?? description) : description,
      type: t.type,
      default: def,
      required: p.required === true,
      data,
    };
    if (command) pref.command = command;
    out.push(pref);
  });
  return out;
}

function translateArguments(list: unknown, at: string, errors: string[]): ArgumentManifest[] {
  const out: ArgumentManifest[] = [];
  if (list === undefined) return out;
  if (!Array.isArray(list)) {
    errors.push(`${at} must be an array`);
    return out;
  }
  list.forEach((a, j) => {
    if (!isObj(a) || !isValidName(a.name)) return void errors.push(`${at}[${j}].name is missing or invalid`);
    const type = a.type === "password" || a.type === "dropdown" ? a.type : "text";
    const arg: ArgumentManifest = { name: a.name, placeholder: optStr(a.placeholder), required: a.required === true, type };
    if (type === "dropdown" && Array.isArray(a.data)) arg.data = a.data.filter(isObj).map((d) => ({ value: String(d.value ?? ""), title: String(d.title ?? d.value ?? "") }));
    out.push(arg);
  });
  return out;
}

/**
 * Translate a Raycast package.json. `exists` resolves command entries (built bundles); pass
 * `() => true` to validate a source folder before building it.
 */
export function translateRaycastManifest(pkg: unknown, exists: (relPath: string) => boolean = () => true): ManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(pkg)) return { ok: false, errors: ["package.json must be a JSON object"] };
  if (!isValidName(pkg.name)) errors.push(`"name" must be 1–64 letters, digits, ".", "_" or "-" (got ${JSON.stringify(pkg.name)})`);
  const title = optStr(pkg.title) ?? (typeof pkg.name === "string" ? pkg.name : undefined);
  if (!title) errors.push('"title" is required');

  const preferences = translatePreferences(pkg.preferences, "preferences", errors);
  const commands: CommandManifest[] = [];
  const names = new Set<string>();
  (pkg.commands as unknown[]).forEach((c, i) => {
    const at = `commands[${i}]`;
    if (!isObj(c)) return void errors.push(`${at} must be an object`);
    if (!isValidName(c.name)) return void errors.push(`${at}.name is missing or invalid`);
    if (names.has(c.name)) errors.push(`${at}.name "${c.name}" is duplicated`);
    names.add(c.name);
    const mode = c.mode ?? "view";
    if (mode !== "view" && mode !== "no-view" && mode !== "menu-bar") return void errors.push(`${at}.mode must be "view", "no-view" or "menu-bar"`);
    const entry = raycastEntryCandidates(c.name).find(exists);
    if (!entry) errors.push(`${at}: "${c.name}" has not been built (re-import the extension folder)`);
    const cmd: CommandManifest = {
      name: c.name,
      title: optStr(c.title) ?? c.name,
      subtitle: optStr(c.subtitle),
      description: optStr(c.description),
      mode,
      arguments: translateArguments(c.arguments, `${at}.arguments`, errors),
      keywords: Array.isArray(c.keywords) ? c.keywords.filter((k): k is string => typeof k === "string") : [],
      entry: entry ?? "",
    };
    if (optStr(c.icon)) cmd.icon = optStr(c.icon);
    if (c.interval !== undefined) {
      const ms = parseInterval(c.interval);
      if (ms === null) warnings.push(`"${c.name}": interval ${JSON.stringify(c.interval)} is not valid (use e.g. "10s", "5m", "1h", "1d"; at least 10s); background refresh is off.`);
      else if (mode === "view") warnings.push(`"${c.name}": interval only applies to no-view and menu-bar commands; it was ignored.`);
      else {
        cmd.intervalMs = ms;
        cmd.interval = String(c.interval).trim();
      }
    }
    preferences.push(...translatePreferences(c.preferences, `${at}.preferences`, errors, c.name));
    commands.push(cmd);
  });
  if (!commands.length && !errors.length) errors.push("This extension has no commands Glide can run");

  if (errors.length) return { ok: false, errors };
  const author = typeof pkg.author === "string" ? pkg.author : isObj(pkg.author) ? optStr(pkg.author.name) : undefined;
  const manifest: ExtensionManifest = {
    name: pkg.name as string,
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    title: title as string,
    description: optStr(pkg.description) ?? "",
    author,
    icon: optStr(pkg.icon),
    commands,
    preferences,
    runtime: "raycast",
  };
  if (warnings.length) manifest.warnings = warnings;
  return { ok: true, manifest };
}
