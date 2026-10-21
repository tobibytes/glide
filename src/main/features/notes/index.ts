import fs from "node:fs";
import path from "node:path";
import { app, screen, type BrowserWindow } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { addNote, cycle, deleteNote, newNote, sanitize, searchNotes, summarize, updateNote, type Note, type NotesFile, type NotesState } from "./model";

let ctx: FeatureContext | undefined;
let data: NotesFile = { notes: [], currentId: null };
let win: BrowserWindow | undefined;
let writeTimer: NodeJS.Timeout | undefined;
let boundsTimer: NodeJS.Timeout | undefined;
let quitting = false;

const file = () => (ctx ? path.join(ctx.dataDir(), "notes.json") : "");

function load() {
  try {
    data = sanitize(JSON.parse(fs.readFileSync(file(), "utf8")));
  } catch {
    data = sanitize(null);
  }
}

function writeNow() {
  clearTimeout(writeTimer);
  writeTimer = undefined;
  if (!ctx) return;
  const target = file();
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, target);
  } catch (err) {
    ctx.log("could not save notes", err);
  }
}

function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeNow, 300);
}

const stateOf = (): NotesState => ({ notes: data.notes.map(summarize), currentId: data.currentId });

function changed(source?: string) {
  persist();
  ctx?.emit("changed", { ...stateOf(), source });
}

function ensureNote(): Note {
  const cur = data.notes.find((n) => n.id === data.currentId);
  if (cur) return cur;
  if (data.notes[0]) {
    data = { ...data, currentId: data.notes[0].id };
    return data.notes[0];
  }
  const n = newNote(Date.now());
  data = addNote(data, n);
  changed();
  return n;
}

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return { width: 360, height: 420, x: workArea.x + workArea.width - 360 - 24, y: workArea.y + 24 };
}

/** Keep remembered bounds only if they are still on a connected display. */
function restoredBounds() {
  const b = data.bounds;
  if (!b) return defaultBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
  });
  return visible ? b : defaultBounds();
}

function getWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  if (!ctx) throw new Error("Notes not started");
  const w = ctx.createWindow("notes/float", {
    ...restoredBounds(),
    minWidth: 240,
    minHeight: 200,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    vibrancy: "hud",
    visualEffectState: "active",
    skipTaskbar: true,
    resizable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: true,
    roundedCorners: true,
    title: "Floating Notes",
  });
  w.setAlwaysOnTop(true, "floating");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (w.isDestroyed()) return;
      data = { ...data, bounds: w.getBounds() };
      persist();
    }, 400);
  };
  w.on("moved", saveBounds);
  w.on("resized", saveBounds);
  w.on("close", (e) => {
    // ⌘W hides; the window (and its unsaved text) survives until quit.
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on("closed", () => {
    if (win === w) win = undefined;
  });
  win = w;
  return w;
}

function show(noteId?: string) {
  ensureNote();
  if (noteId && data.notes.some((n) => n.id === noteId)) data = { ...data, currentId: noteId };
  const w = getWindow();
  const reveal = () => {
    w.show();
    w.focus();
    ctx?.emit("focus", { currentId: data.currentId });
  };
  if (w.webContents.isLoading()) w.once("ready-to-show", reveal);
  else reveal();
  changed("show");
}

function toggle(): ExecuteResult {
  const w = win && !win.isDestroyed() ? win : undefined;
  if (w?.isVisible() && w.isFocused()) {
    w.hide();
    return { ok: true, hide: true };
  }
  ctx?.hideLauncher();
  show();
  return { ok: true, hide: true };
}

function createAndShow(body = ""): Note {
  const n = newNote(Date.now(), body);
  data = addNote(data, n);
  changed("create");
  return n;
}

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[]): SearchItem => ({
  id: `notes:${id}`,
  kind: "command",
  kindLabel: "Notes",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "notes",
  data: { action: id },
});

export const feature: FeatureModule = {
  id: "notes",
  start(c) {
    ctx = c;
    load();
    app.on("before-quit", () => {
      quitting = true;
      if (win && !win.isDestroyed()) data = { ...data, bounds: win.getBounds() };
      writeNow();
    });
  },
  stop() {
    writeNow();
  },
  items: () => [
    item("toggle", "Toggle Floating Notes", "Floating Notes", "🗒️", ["notes", "sticky", "scratchpad", "float"]),
    item("new", "New Note", "Floating Notes", "📝", ["notes", "create", "sticky"]),
    item("search", "Search Notes", `${data.notes.length} note${data.notes.length === 1 ? "" : "s"}`, "🔎", ["notes", "find", "floating"]),
  ],
  actions(i) {
    const a = i.data?.action;
    if (a === "toggle") return [{ id: "toggle", title: "Toggle Floating Notes", shortcut: "⏎" }];
    if (a === "new") return [{ id: "new", title: "Create Note", shortcut: "⏎" }];
    return [{ id: "search", title: "Search Notes", shortcut: "⏎" }];
  },
  async runAction(scored, actionId) {
    if (actionId === "toggle") return toggle();
    if (actionId === "new") {
      const n = createAndShow(scored.argument ?? "");
      ctx?.hideLauncher();
      show(n.id);
      return { ok: true, hide: true };
    }
    if (actionId === "search") return { ok: true, view: { id: "notes.search" } };
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => stateOf(),
    get: (id: unknown) => (typeof id === "string" ? (data.notes.find((n) => n.id === id) ?? null) : (data.notes.find((n) => n.id === data.currentId) ?? null)),
    current: () => ensureNote(),
    save: (id: unknown, body: unknown) => {
      if (typeof id !== "string" || typeof body !== "string") return false;
      if (!data.notes.some((n) => n.id === id)) return false;
      data = updateNote(data, id, body, Date.now());
      changed("save");
      return true;
    },
    create: () => createAndShow(),
    remove: (id: unknown) => {
      if (typeof id !== "string") return stateOf();
      data = deleteNote(data, id);
      if (!data.notes.length && win?.isVisible()) createAndShow();
      changed("delete");
      return stateOf();
    },
    select: (id: unknown) => {
      if (typeof id === "string" && data.notes.some((n) => n.id === id)) data = { ...data, currentId: id };
      changed("select");
      return ensureNote();
    },
    cycle: (delta: unknown) => {
      const id = cycle(data, typeof delta === "number" ? delta : 1);
      if (id) data = { ...data, currentId: id };
      changed("select");
      return ensureNote();
    },
    search: (query: unknown) => searchNotes(data.notes, typeof query === "string" ? query : "").map(summarize),
    open: (id: unknown) => {
      ctx?.hideLauncher();
      show(typeof id === "string" ? id : undefined);
      return true;
    },
    hide: () => {
      win?.hide();
      return true;
    },
  },
};
