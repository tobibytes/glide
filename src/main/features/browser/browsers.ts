/** Known browsers and profile discovery. Paths are relative to the home directory so tests can pass a fixture home. */
import fs from "node:fs";
import path from "node:path";

export type Engine = "chromium" | "firefox" | "safari";

export interface BrowserDef {
  id: string;
  name: string;
  bundleId: string;
  engine: Engine;
  /** Data root relative to $HOME. */
  root: string;
  /** App bundle names to look for in /Applications and ~/Applications. */
  app: string;
  /** Chromium browsers that honour --profile-directory when opening a URL. */
  profileArg?: boolean;
  /** Opera keeps the single profile in the root itself. */
  rootIsProfile?: boolean;
}

const AS = "Library/Application Support";

export const BROWSERS: readonly BrowserDef[] = [
  { id: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome", engine: "chromium", root: `${AS}/Google/Chrome`, app: "Google Chrome.app", profileArg: true },
  { id: "arc", name: "Arc", bundleId: "company.thebrowser.Browser", engine: "chromium", root: `${AS}/Arc/User Data`, app: "Arc.app" },
  { id: "brave", name: "Brave", bundleId: "com.brave.Browser", engine: "chromium", root: `${AS}/BraveSoftware/Brave-Browser`, app: "Brave Browser.app", profileArg: true },
  { id: "edge", name: "Microsoft Edge", bundleId: "com.microsoft.edgemac", engine: "chromium", root: `${AS}/Microsoft Edge`, app: "Microsoft Edge.app", profileArg: true },
  { id: "vivaldi", name: "Vivaldi", bundleId: "com.vivaldi.Vivaldi", engine: "chromium", root: `${AS}/Vivaldi`, app: "Vivaldi.app", profileArg: true },
  { id: "chromium", name: "Chromium", bundleId: "org.chromium.Chromium", engine: "chromium", root: `${AS}/Chromium`, app: "Chromium.app", profileArg: true },
  { id: "dia", name: "Dia", bundleId: "company.thebrowser.dia", engine: "chromium", root: `${AS}/Dia/User Data`, app: "Dia.app" },
  { id: "opera", name: "Opera", bundleId: "com.operasoftware.Opera", engine: "chromium", root: `${AS}/com.operasoftware.Opera`, app: "Opera.app", rootIsProfile: true },
  { id: "firefox", name: "Firefox", bundleId: "org.mozilla.firefox", engine: "firefox", root: `${AS}/Firefox`, app: "Firefox.app" },
  { id: "zen", name: "Zen", bundleId: "app.zen-browser.zen", engine: "firefox", root: `${AS}/zen`, app: "Zen.app" },
  { id: "safari", name: "Safari", bundleId: "com.apple.Safari", engine: "safari", root: "Library/Safari", app: "Safari.app" },
];

export interface Profile {
  /** "<browserId>:<dir>" — stable key used by settings. */
  key: string;
  browser: BrowserDef;
  /** Profile directory name ("Default", "Profile 5", "abcd.default-release", "Safari"). */
  dir: string;
  /** Human name from Local State / profiles.ini. */
  name: string;
  absDir: string;
  bookmarksFile?: string;
  historyFile?: string;
  faviconsFile?: string;
}

const exists = (p: string) => {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/** profile.info_cache names from Chromium's "Local State". */
export function chromiumProfileNames(localState: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const cache = (localState as { profile?: { info_cache?: Record<string, { name?: unknown }> } } | undefined)?.profile?.info_cache;
  if (cache && typeof cache === "object") for (const [dir, info] of Object.entries(cache)) if (typeof info?.name === "string" && info.name) out[dir] = info.name;
  return out;
}

/** Firefox profiles.ini → [{ name, path (absolute) }]. */
export function parseProfilesIni(ini: string, root: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  let cur: Record<string, string> | undefined;
  const flush = () => {
    if (cur?.Path) out.push({ name: cur.Name || path.basename(cur.Path), path: cur.IsRelative === "0" ? cur.Path : path.join(root, cur.Path) });
  };
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      flush();
      cur = /^\[Profile\d+\]$/i.test(line) ? {} : undefined;
      continue;
    }
    const eq = line.indexOf("=");
    if (cur && eq > 0) cur[line.slice(0, eq)] = line.slice(eq + 1);
  }
  flush();
  return out;
}

function chromiumProfiles(b: BrowserDef, root: string): Profile[] {
  const names = chromiumProfileNames(readJson(path.join(root, "Local State")));
  const dirs = b.rootIsProfile ? [""] : safeReaddir(root).filter((d) => d === "Default" || /^Profile \d+$/.test(d) || names[d] !== undefined);
  const out: Profile[] = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    const bookmarks = path.join(abs, "Bookmarks");
    const history = path.join(abs, "History");
    if (!exists(bookmarks) && !exists(history)) continue;
    const favicons = path.join(abs, "Favicons");
    out.push({
      key: `${b.id}:${dir || "Default"}`,
      browser: b,
      dir: dir || "Default",
      name: names[dir] ?? (dir || "Default"),
      absDir: abs,
      ...(exists(bookmarks) ? { bookmarksFile: bookmarks } : {}),
      ...(exists(history) ? { historyFile: history } : {}),
      ...(exists(favicons) ? { faviconsFile: favicons } : {}),
    });
  }
  return out;
}

function firefoxProfiles(b: BrowserDef, root: string): Profile[] {
  let entries: Array<{ name: string; path: string }> = [];
  try {
    entries = parseProfilesIni(fs.readFileSync(path.join(root, "profiles.ini"), "utf8"), root);
  } catch {
    entries = safeReaddir(path.join(root, "Profiles")).map((d) => ({ name: d, path: path.join(root, "Profiles", d) }));
  }
  const out: Profile[] = [];
  for (const e of entries) {
    const places = path.join(e.path, "places.sqlite");
    if (!exists(places)) continue;
    const dir = path.basename(e.path);
    const fav = path.join(e.path, "favicons.sqlite");
    out.push({ key: `${b.id}:${dir}`, browser: b, dir, name: e.name, absDir: e.path, bookmarksFile: places, historyFile: places, ...(exists(fav) ? { faviconsFile: fav } : {}) });
  }
  return out;
}

function safariProfiles(b: BrowserDef, root: string): Profile[] {
  if (!exists(root)) return [];
  const bookmarks = path.join(root, "Bookmarks.plist");
  const history = path.join(root, "History.db");
  return [{ key: `${b.id}:Safari`, browser: b, dir: "Safari", name: "Safari", absDir: root, bookmarksFile: bookmarks, historyFile: history }];
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

export function discoverProfiles(home: string, browsers: readonly BrowserDef[] = BROWSERS): Profile[] {
  return browsers.flatMap((b) => {
    const root = path.join(home, b.root);
    if (b.engine === "chromium") return chromiumProfiles(b, root);
    if (b.engine === "firefox") return firefoxProfiles(b, root);
    return safariProfiles(b, root);
  });
}

/** Safari's data is TCC-protected: readable only with Full Disk Access. Never triggers a prompt (plain open). */
export function safariAccess(home: string): "ok" | "denied" | "missing" {
  const f = path.join(home, "Library/Safari/Bookmarks.plist");
  try {
    fs.closeSync(fs.openSync(f, "r"));
    return "ok";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : "denied";
  }
}

export function findApp(home: string, b: BrowserDef): string | undefined {
  const candidates = [`/Applications/${b.app}`, path.join(home, "Applications", b.app)];
  if (b.id === "safari") candidates.unshift("/Applications/Safari.app", "/System/Cryptexes/App/System/Applications/Safari.app");
  return candidates.find(exists);
}
