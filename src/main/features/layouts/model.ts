/** Saved window layouts and workspaces: types plus defensive (de)serialisation of layouts.json. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedDisplay {
  id: number;
  uuid: string | null;
  name: string;
  frame: Rect;
  visible: Rect;
  main: boolean;
}

export interface SavedWindow {
  bundleId: string;
  appName: string;
  appPath: string | null;
  title: string;
  /** AX coordinates at save time. */
  frame: Rect;
  /** Index into Layout.displays. */
  display: number;
  /** Position among this app's windows (front to back) at save time. */
  order: number;
}

export interface Layout {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  displays: SavedDisplay[];
  windows: SavedWindow[];
}

export interface AppRef {
  name: string;
  bundleId: string;
  path: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  /** Layout restored after launching apps. */
  layoutId: string | null;
  /** Launch apps of the layout that aren't running. */
  relaunchLayoutApps: boolean;
  launchApps: AppRef[];
  /** Asked to quit only after the user confirms. */
  quitApps: AppRef[];
  urls: string[];
  /** Glide Focus session to start. */
  focus: { goal: string; minutes: number } | null;
  /** macOS Shortcut to run (e.g. one that turns on a Focus mode). */
  shortcut: string | null;
  /** Glide note to open in Floating Notes. */
  noteId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LayoutsFile {
  version: 1;
  layouts: Layout[];
  workspaces: Workspace[];
}

export const EMPTY_FILE: LayoutsFile = { version: 1, layouts: [], workspaces: [] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseRect(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const r = { x: num(v.x, NaN), y: num(v.y, NaN), width: num(v.width, NaN), height: num(v.height, NaN) };
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return null;
  return r;
}

export function parseDisplay(v: unknown): SavedDisplay | null {
  if (!isObj(v)) return null;
  const frame = parseRect(v.frame);
  if (!frame) return null;
  return { id: num(v.id), uuid: strOrNull(v.uuid), name: str(v.name, "Display"), frame, visible: parseRect(v.visible) ?? frame, main: v.main === true };
}

export function parseWindow(v: unknown): SavedWindow | null {
  if (!isObj(v)) return null;
  const frame = parseRect(v.frame);
  const bundleId = str(v.bundleId);
  if (!frame || !bundleId) return null;
  return {
    bundleId,
    appName: str(v.appName, bundleId),
    appPath: strOrNull(v.appPath),
    title: str(v.title),
    frame,
    display: Math.max(0, Math.round(num(v.display))),
    order: Math.max(0, Math.round(num(v.order))),
  };
}

export function parseLayout(v: unknown): Layout | null {
  if (!isObj(v) || !str(v.id) || !str(v.name).trim()) return null;
  const displays = Array.isArray(v.displays) ? v.displays.map(parseDisplay).filter((d): d is SavedDisplay => !!d) : [];
  const windows = Array.isArray(v.windows) ? v.windows.map(parseWindow).filter((w): w is SavedWindow => !!w) : [];
  return {
    id: str(v.id),
    name: str(v.name).trim(),
    createdAt: num(v.createdAt),
    updatedAt: num(v.updatedAt, num(v.createdAt)),
    displays,
    windows: windows.map((w) => (w.display < displays.length ? w : { ...w, display: 0 })),
  };
}

export function parseAppRef(v: unknown): AppRef | null {
  if (!isObj(v) || !str(v.bundleId)) return null;
  return { name: str(v.name, str(v.bundleId)), bundleId: str(v.bundleId), path: strOrNull(v.path) };
}

const appRefs = (v: unknown): AppRef[] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  return v.map(parseAppRef).filter((a): a is AppRef => !!a && !seen.has(a.bundleId) && !!seen.add(a.bundleId));
};

export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (s.startsWith("/") || s.startsWith("~/")) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
  return null;
}

export function parseWorkspace(v: unknown): Workspace | null {
  if (!isObj(v) || !str(v.id) || !str(v.name).trim()) return null;
  const focus = isObj(v.focus) && num(v.focus.minutes) > 0 ? { goal: str(v.focus.goal), minutes: Math.round(num(v.focus.minutes)) } : null;
  return {
    id: str(v.id),
    name: str(v.name).trim(),
    layoutId: strOrNull(v.layoutId),
    relaunchLayoutApps: v.relaunchLayoutApps === true,
    launchApps: appRefs(v.launchApps),
    quitApps: appRefs(v.quitApps),
    urls: Array.isArray(v.urls) ? v.urls.map((u) => normalizeUrl(str(u))).filter((u): u is string => !!u) : [],
    focus,
    shortcut: strOrNull(typeof v.shortcut === "string" ? v.shortcut.trim() : null),
    noteId: strOrNull(v.noteId),
    createdAt: num(v.createdAt),
    updatedAt: num(v.updatedAt, num(v.createdAt)),
  };
}

export function parseFile(raw: string): LayoutsFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...EMPTY_FILE, layouts: [], workspaces: [] };
  }
  if (!isObj(json)) return { ...EMPTY_FILE, layouts: [], workspaces: [] };
  const layouts = Array.isArray(json.layouts) ? json.layouts.map(parseLayout).filter((l): l is Layout => !!l) : [];
  const ids = new Set(layouts.map((l) => l.id));
  const workspaces = (Array.isArray(json.workspaces) ? json.workspaces.map(parseWorkspace).filter((w): w is Workspace => !!w) : []).map((w) =>
    w.layoutId && !ids.has(w.layoutId) ? { ...w, layoutId: null } : w,
  );
  return { version: 1, layouts, workspaces };
}

export const serializeFile = (f: LayoutsFile): string => JSON.stringify(f, null, 2);

export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Live window as reported by the helper (subset of HelperWindow). */
export interface LiveWindow {
  ref: number;
  bundleId: string | null;
  appName: string;
  appPath: string | null;
  title: string;
  frame: Rect;
  display: number;
  order: number;
  fullScreen?: boolean;
}

export function layoutFromCapture(name: string, displays: SavedDisplay[], windows: LiveWindow[], now: number, id = newId("layout", now)): Layout {
  const saved = windows
    .filter((w) => !!w.bundleId && !w.fullScreen)
    .map((w): SavedWindow => ({ bundleId: w.bundleId!, appName: w.appName, appPath: w.appPath, title: w.title, frame: w.frame, display: w.display, order: w.order }));
  return { id, name: name.trim(), createdAt: now, updatedAt: now, displays, windows: saved };
}

/** Distinct apps of a layout, in first-seen order. */
export function layoutApps(layout: Layout): AppRef[] {
  const seen = new Map<string, AppRef>();
  for (const w of layout.windows) if (!seen.has(w.bundleId)) seen.set(w.bundleId, { name: w.appName, bundleId: w.bundleId, path: w.appPath });
  return [...seen.values()];
}

export function describeLayout(layout: Layout): string {
  const apps = layoutApps(layout).length;
  const n = layout.windows.length;
  const d = layout.displays.length;
  return `${n} window${n === 1 ? "" : "s"} · ${apps} app${apps === 1 ? "" : "s"}${d > 1 ? ` · ${d} displays` : ""}`;
}
