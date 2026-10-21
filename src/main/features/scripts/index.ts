import fs from "node:fs";
import path from "node:path";
import { dialog, Notification, clipboard, shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ItemIcon, ScoredItem, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { expandHome } from "../../util/exec";
import { EXAMPLE_SCRIPTS, NEW_SCRIPT_TEMPLATE } from "./examples";
import { firstLine, lastLine, parseScript, splitArguments } from "./parse";
import { resolveLoginPath, runScriptFile, type RunHandle } from "./runner";
import type { OutputChunk, RunExit, RunSnapshot, ScriptInfo, ScriptsState } from "./types";

const DEFAULTS = { directory: "~/Glide Scripts" };
const TIMEOUT_MS = 60_000;
const MAX_RUNS = 12;
const SKIP = /^\.|\.(md|txt|json|png|jpe?g|gif|svg|icns|template)$/i;

let ctx: FeatureContext | undefined;
let scripts: ScriptInfo[] = [];
let watcher: fs.FSWatcher | undefined;
let watchedDir = "";
let scanTimer: NodeJS.Timeout | undefined;
const inline = new Map<string, { line: string; at: number; error?: boolean }>();
const inlineTimers = new Map<string, NodeJS.Timeout>();
const runs = new Map<string, RunSnapshot & { handle?: RunHandle }>();

const directory = (): string => {
  const d = ctx?.settings(DEFAULTS).directory;
  return expandHome(typeof d === "string" && d.trim() ? d.trim() : DEFAULTS.directory);
};

function scan(): void {
  const dir = directory();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => !SKIP.test(f));
  } catch {
    files = [];
  }
  const next: ScriptInfo[] = [];
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const full = path.join(dir, file);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(Math.min(st.size, 16 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const meta = parseScript(buf.toString("utf8"));
      next.push({ id: `scripts:${file}`, file, path: full, title: meta.title, mode: meta.mode, icon: meta.icon, packageName: meta.packageName, description: meta.description, arguments: meta.arguments, refreshTime: meta.refreshTime, errors: meta.errors });
    } catch (err) {
      next.push({ id: `scripts:${file}`, file, path: full, arguments: [], errors: [`Could not read: ${err instanceof Error ? err.message : String(err)}`] });
    }
  }
  scripts = next;
  scheduleInline();
  ctx?.refreshCatalogue();
  ctx?.emit("changed", state());
}

function watch(): void {
  const dir = directory();
  if (watcher && watchedDir === dir) return;
  watcher?.close();
  watcher = undefined;
  watchedDir = dir;
  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 300);
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    // Folder does not exist yet; created on first use.
  }
}

function state(): ScriptsState {
  return { directory: directory(), exists: fs.existsSync(directory()), scripts };
}

/** Create the folder with examples the first time the user asks for it. */
function ensureFolder(): string {
  const dir = directory();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    for (const ex of EXAMPLE_SCRIPTS) fs.writeFileSync(path.join(dir, ex.file), ex.source, { mode: 0o755 });
  }
  watch();
  scan();
  return dir;
}

const valid = (s: ScriptInfo) => s.errors.length === 0 && !!s.title && !!s.mode;

function iconFor(s: ScriptInfo): ItemIcon {
  const i = s.icon;
  if (!i) return { kind: "emoji", value: "📜" };
  if (/^https?:\/\//.test(i)) return { kind: "url", value: i };
  if (/\.(png|jpe?g|icns|svg|gif)$/i.test(i)) return { kind: "file", value: path.isAbsolute(i) ? i : path.join(path.dirname(s.path), i) };
  return { kind: "emoji", value: i };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function snapshot(r: RunSnapshot & { handle?: RunHandle }): RunSnapshot {
  const { handle: _h, ...rest } = r;
  void _h;
  return rest;
}

async function start(s: ScriptInfo, args: string[], onChunk?: (c: OutputChunk) => void): Promise<{ runId: string; handle: RunHandle }> {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const envPath = await resolveLoginPath();
  const encoded = args.map((a, i) => (s.arguments[i]?.percentEncoded ? encodeURIComponent(a) : a));
  const record: RunSnapshot & { handle?: RunHandle } = { runId, scriptId: s.id, title: s.title ?? s.file, icon: s.icon, chunks: [], done: false, code: null, startedAt: Date.now() };
  runs.set(runId, record);
  while (runs.size > MAX_RUNS) {
    const oldest = [...runs.values()].find((r) => r.done);
    if (!oldest) break;
    runs.delete(oldest.runId);
  }
  let seq = 0;
  const handle = runScriptFile(s.path, encoded, {
    timeoutMs: TIMEOUT_MS,
    envPath,
    onChunk: (stream, text) => {
      const chunk: OutputChunk = { runId, seq: seq++, stream, text };
      if (record.chunks.length < 5_000) record.chunks.push(chunk);
      onChunk?.(chunk);
    },
  });
  record.handle = handle;
  void handle.done.then((out) => {
    record.done = true;
    record.code = out.code;
    record.error = out.error;
    record.endedAt = Date.now();
    record.handle = undefined;
    const exit: RunExit = { runId, code: out.code, error: out.error, endedAt: record.endedAt };
    ctx?.emit("exit", exit);
  });
  return { runId, handle };
}

function failureText(out: { code: number | null; stdout: string; stderr: string; error?: string }): string {
  return out.error ?? (lastLine(out.stderr) || lastLine(out.stdout) || `Exited with code ${out.code}`);
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

async function runInline(s: ScriptInfo): Promise<void> {
  try {
    const { handle } = await start(s, []);
    const out = await handle.done;
    const ok = out.code === 0 && !out.error;
    inline.set(s.id, { line: ok ? firstLine(out.stdout) || "(no output)" : `⚠ ${failureText(out)}`, at: Date.now(), error: !ok });
  } catch (err) {
    inline.set(s.id, { line: `⚠ ${err instanceof Error ? err.message : String(err)}`, at: Date.now(), error: true });
  }
  ctx?.refreshCatalogue();
}

function scheduleInline(): void {
  for (const t of inlineTimers.values()) clearInterval(t);
  inlineTimers.clear();
  const live = new Set<string>();
  scripts.filter((s) => valid(s) && s.mode === "inline" && s.arguments.every((a) => a.optional)).forEach((s, i) => {
    live.add(s.id);
    // Stagger first runs so a folder full of inline scripts does not fork everything at once.
    if (!inline.has(s.id)) setTimeout(() => void runInline(s), 300 + i * 250);
    if (s.refreshTime) inlineTimers.set(s.id, setInterval(() => void runInline(s), s.refreshTime));
  });
  for (const id of inline.keys()) if (!live.has(id)) inline.delete(id);
}

async function confirmRun(s: ScriptInfo): Promise<boolean> {
  ctx?.hideLauncher();
  const { response } = await dialog.showMessageBox({ type: "question", buttons: ["Cancel", "Run"], defaultId: 1, cancelId: 0, message: `Run “${s.title}”?`, detail: s.path });
  return response === 1;
}

async function run(s: ScriptInfo, args: string[]): Promise<ExecuteResult> {
  const missing = s.arguments.findIndex((a, i) => !a.optional && !args[i]?.trim());
  if (missing >= 0) return { ok: true, view: { id: "scripts.arguments", props: { scriptId: s.id, values: args } } };
  if (needsConfirmation(s) && !(await confirmRun(s))) return { ok: true, hide: true };

  switch (s.mode) {
    case "fullOutput": {
      const { runId } = await start(s, args, (c) => ctx?.emit("output", c));
      return { ok: true, view: { id: "scripts.output", props: { runId } } };
    }
    case "silent": {
      ctx?.hideLauncher();
      const { handle } = await start(s, args);
      void handle.done.then((out) => {
        if (out.code === 0 && !out.error) {
          const line = lastLine(out.stdout);
          if (line) notify(s.title ?? s.file, line);
        } else notify(`${s.title ?? s.file} failed`, failureText(out));
      });
      return { ok: true, hide: true };
    }
    case "inline": {
      await runInline(s);
      const cur = inline.get(s.id);
      return cur?.error ? { ok: false, error: cur.line.replace(/^⚠ /, "") } : { ok: true, message: cur?.line ?? "Refreshed" };
    }
    case "compact":
    default: {
      const { handle } = await start(s, args);
      const out = await handle.done;
      if (out.code === 0 && !out.error) return { ok: true, message: lastLine(out.stdout) || "Done" };
      return { ok: false, error: failureText(out) };
    }
  }
}

function needsConfirmation(s: ScriptInfo): boolean {
  try {
    return parseScript(fs.readFileSync(s.path, "utf8").slice(0, 16 * 1024)).needsConfirmation;
  } catch {
    return false;
  }
}

const byId = (id: unknown) => (typeof id === "string" ? scripts.find((s) => s.id === id) : undefined);

function createScript(): ExecuteResult {
  const dir = ensureFolder();
  let n = 1;
  let file = path.join(dir, "new-script.sh");
  while (fs.existsSync(file)) file = path.join(dir, `new-script-${++n}.sh`);
  fs.writeFileSync(file, NEW_SCRIPT_TEMPLATE(n === 1 ? "New Script" : `New Script ${n}`), { mode: 0o755 });
  void shell.openPath(file);
  scan();
  return { ok: true, hide: true, message: `Created ${path.basename(file)}` };
}

// ---------------------------------------------------------------------------

export const feature: FeatureModule = {
  id: "scripts",
  start(c) {
    ctx = c;
    void resolveLoginPath();
    watch();
    scan();
  },
  stop() {
    watcher?.close();
    for (const t of inlineTimers.values()) clearInterval(t);
    for (const r of runs.values()) r.handle?.stop();
  },
  items(): SearchItem[] {
    const scriptItems = scripts.filter(valid).map((s): SearchItem => {
      const live = s.mode === "inline" ? inline.get(s.id) : undefined;
      return {
        id: s.id,
        kind: "command",
        kindLabel: "Script",
        title: s.title ?? s.file,
        subtitle: live ? live.line : (s.packageName ?? s.description),
        icon: iconFor(s),
        keywords: [s.file, s.packageName ?? "", s.description ?? "", "script"].filter(Boolean),
        acceptsArgument: s.arguments.length > 0,
        feature: "scripts",
        data: { action: "run", scriptId: s.id },
      };
    });
    const cmd = (id: string, title: string, subtitle: string, icon: string, keywords: string[]): SearchItem => ({ id: `scripts:cmd:${id}`, kind: "command", kindLabel: "Command", title, subtitle, icon: { kind: "emoji", value: icon }, keywords, feature: "scripts", data: { action: id } });
    return [
      ...scriptItems,
      cmd("create", "Create Script Command", "Script Commands", "📝", ["new", "script", "raycast"]),
      cmd("openFolder", "Open Script Commands Folder", "Script Commands", "📂", ["scripts", "folder", "directory"]),
      cmd("reload", "Reload Script Commands", "Script Commands", "🔄", ["scripts", "refresh", "rescan"]),
    ];
  },
  actions(item): ItemAction[] {
    const action = item.data?.action;
    if (action === "create") return [{ id: "create", title: "Create Script", shortcut: "⏎" }];
    if (action === "openFolder") return [{ id: "openFolder", title: "Open Folder", shortcut: "⏎" }];
    if (action === "reload") return [{ id: "reload", title: "Reload", shortcut: "⏎" }];
    return [
      { id: "run", title: "Run Script", shortcut: "⏎" },
      { id: "edit", title: "Open in Editor", shortcut: "⌘E" },
      { id: "reveal", title: "Show in Finder", shortcut: "⌘⏎" },
      { id: "copyPath", title: "Copy Path", shortcut: "⇧⌘C" },
      { id: "settings", title: "Manage Script Commands", shortcut: "⌘," },
    ];
  },
  async runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
    switch (actionId) {
      case "create":
        return createScript();
      case "openFolder": {
        const dir = ensureFolder();
        const err = await shell.openPath(dir);
        return err ? { ok: false, error: err } : { ok: true, hide: true };
      }
      case "reload":
        watch();
        scan();
        return { ok: true, message: `${scripts.filter(valid).length} script commands` };
      case "settings":
        return { ok: true, navigate: "settings/scripts" };
    }
    const s = byId(scored.item.data?.scriptId);
    if (!s) return { ok: false, error: "Script not found (was it moved?)" };
    if (actionId === "edit") {
      const err = await shell.openPath(s.path);
      return err ? { ok: false, error: err } : { ok: true, hide: true };
    }
    if (actionId === "reveal") {
      shell.showItemInFolder(s.path);
      return { ok: true, hide: true };
    }
    if (actionId === "copyPath") {
      clipboard.writeText(s.path);
      return { ok: true, message: "Path copied" };
    }
    if (actionId === "run") return run(s, splitArguments(scored.argument ?? "", s.arguments.length));
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => state(),
    getRun: (runId: unknown) => {
      const r = typeof runId === "string" ? runs.get(runId) : undefined;
      return r ? snapshot(r) : null;
    },
    stopRun: (runId: unknown) => {
      if (typeof runId === "string") runs.get(runId)?.handle?.stop();
      return true;
    },
    rerun: async (runId: unknown) => {
      const r = typeof runId === "string" ? runs.get(runId) : undefined;
      const s = r && byId(r.scriptId);
      if (!s) return { ok: false, error: "Script not found" };
      const { runId: next } = await start(s, [], (c) => ctx?.emit("output", c));
      return { ok: true, runId: next };
    },
    run: async (scriptId: unknown, args: unknown) => {
      const s = byId(scriptId);
      if (!s) return { ok: false, error: "Script not found" };
      return run(s, Array.isArray(args) ? args.map((a) => String(a ?? "")) : []);
    },
    setDirectory: (dir: unknown) => {
      if (typeof dir === "string" && dir.trim()) ctx?.setSettings({ directory: dir.trim() });
      watch();
      scan();
      return state();
    },
    chooseDirectory: async () => {
      const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], defaultPath: fs.existsSync(directory()) ? directory() : undefined });
      if (!res.canceled && res.filePaths[0]) ctx?.setSettings({ directory: res.filePaths[0] });
      watch();
      scan();
      return state();
    },
    createFolder: () => {
      ensureFolder();
      return state();
    },
    openFolder: async () => {
      await shell.openPath(ensureFolder());
      return state();
    },
    openScript: async (scriptId: unknown) => {
      const s = byId(scriptId);
      if (s) await shell.openPath(s.path);
      return true;
    },
    createScript: () => createScript(),
    reload: () => {
      watch();
      scan();
      return state();
    },
  },
};
