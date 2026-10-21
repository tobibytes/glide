/**
 * "snippets" feature module: Search Snippets view, Raycast/Glide import & export, snippet settings
 * (keyword prefix, case-adaptive, excluded apps) and the live inputs keyword expansion needs.
 * Registered from ../quicklinks/register.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { clipboard, dialog } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem, Snippet } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../features/types";
import { usesPlaceholder } from "../quicklinks/placeholders";
import { keywordWarning, needsFrontmost, needsRefresh, sanitizeSnippetSettings, SNIPPET_DEFAULTS, type SnippetSettings } from "./expansion";
import { exportSnippets, mergeImported, parseSnippetImport } from "./io";
import { notifyExpansionChange, setExpansionInputs } from "./live";
import { copySnippet, pasteSnippet, renderForUse, setSnippetHelper } from "./paste";
import { htmlToText, renderSnippet, sanitizeHtml, snippetLookup } from "./render";

export const SNIPPETS_FEATURE = "snippets";
const REFRESH_MS = 20_000;
const FRONTMOST_MS = 1500;

let ctx: FeatureContext | null = null;
let refreshTimer: NodeJS.Timeout | undefined;
let frontTimer: NodeJS.Timeout | undefined;
const offs: Array<() => void> = [];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const newId = () => `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function need(): FeatureContext {
  if (!ctx) throw new Error("Snippets are not ready yet");
  return ctx;
}

export const snippetSettings = (): SnippetSettings => sanitizeSnippetSettings(ctx?.settings(SNIPPET_DEFAULTS));
const snippets = (): Snippet[] => ctx?.getData().snippets ?? [];
const findSnippet = (id: string) => snippets().find((s) => s.id === id || `snippet:${s.id}` === id);

/** Called by execute.ts for the launcher's snippet rows. */
export function pasteSnippetById(id: string, hideLauncher: () => void): Promise<ExecuteResult> | undefined {
  const s = findSnippet(id);
  return s ? pasteSnippet(s, snippets(), hideLauncher) : undefined;
}
export function copySnippetById(id: string): Promise<ExecuteResult> | undefined {
  const s = findSnippet(id);
  return s ? copySnippet(s, snippets()) : undefined;
}

// --- live expansion inputs -----------------------------------------------------

async function refreshClipboardSnapshot(): Promise<void> {
  const list = snippets().filter((s) => s.keyword?.trim());
  if (!list.some((s) => usesPlaceholder(`${s.text}\n${s.html ?? ""}`, "clipboard"))) return;
  setExpansionInputs({ clipboard: await clipboard.readText().catch(() => "") });
}

function schedule(): void {
  const c = ctx;
  if (!c) return;
  setExpansionInputs({ settings: snippetSettings() });
  const list = snippets();
  const dynamic = needsRefresh(list);
  if (dynamic && !refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshClipboardSnapshot().finally(notifyExpansionChange);
    }, REFRESH_MS);
    refreshTimer.unref?.();
  } else if (!dynamic && refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  const tracking = needsFrontmost(list, snippetSettings());
  if (tracking && !frontTimer) {
    frontTimer = setInterval(() => {
      if (!c.helper.available()) return;
      void c.helper
        .call("app.frontmost")
        .then((app) => setExpansionInputs({ frontmostBundleId: app?.bundleId ?? null }))
        .catch(() => undefined);
    }, FRONTMOST_MS);
    frontTimer.unref?.();
  } else if (!tracking && frontTimer) {
    clearInterval(frontTimer);
    frontTimer = undefined;
    setExpansionInputs({ frontmostBundleId: null });
  }
}

// --- import / export -----------------------------------------------------------

export function importSnippetsJson(json: string): { added: number; duplicates: number; skipped: number; keywordConflicts: number; unsupported: string[] } {
  const c = need();
  const parsed = parseSnippetImport(json);
  const { add, duplicates, keywordConflicts } = mergeImported(parsed.snippets, c.getData().snippets);
  c.store.mutate((d) => {
    for (const s of add) d.snippets.push({ ...s, id: newId() });
  });
  return { added: add.length, duplicates, skipped: parsed.skipped, keywordConflicts, unsupported: parsed.unsupported };
}

const exportJson = () => JSON.stringify(exportSnippets(need().getData().snippets), null, 2);

async function importFile() {
  const r = await dialog.showOpenDialog({ title: "Import Snippets (Raycast or Glide JSON)", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return importSnippetsJson(await fs.readFile(r.filePaths[0], "utf8"));
}

async function exportFile(): Promise<string | null> {
  const r = await dialog.showSaveDialog({ title: "Export Snippets", defaultPath: "Glide Snippets.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, exportJson(), "utf8");
  return r.filePath;
}

function cleanSnippet(raw: unknown): Snippet {
  if (!isRecord(raw) || !str(raw.name).trim()) throw new Error("Name is required");
  const html = str(raw.html).trim() ? sanitizeHtml(str(raw.html)) : "";
  const text = str(raw.text) || (html ? htmlToText(html) : "");
  if (!text) throw new Error("Text is required");
  const s: Snippet = { id: str(raw.id) || newId(), name: str(raw.name).trim(), text };
  if (str(raw.keyword).trim()) s.keyword = str(raw.keyword).trim();
  if (str(raw.alias).trim()) s.alias = str(raw.alias).trim();
  if (html) s.html = html;
  if (Array.isArray(raw.excludedApps)) {
    const apps = raw.excludedApps.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
    if (apps.length) s.excludedApps = apps;
  }
  return s;
}

const report = (r: ReturnType<typeof importSnippetsJson> | null): ExecuteResult =>
  r
    ? {
        ok: true,
        message: [`Imported ${r.added} snippet${r.added === 1 ? "" : "s"}`, r.duplicates ? `${r.duplicates} duplicates skipped` : "", r.keywordConflicts ? `${r.keywordConflicts} keywords already in use` : "", r.unsupported.length ? `unsupported: ${r.unsupported.join(" ")}` : ""]
          .filter(Boolean)
          .join(" · "),
      }
    : { ok: true };

const cmd = (id: string, title: string, subtitle: string, icon: string, keywords: string[]): SearchItem => ({
  id: `snippets.${id}`,
  kind: "command",
  kindLabel: "Snippets",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: SNIPPETS_FEATURE,
});

export const snippetsFeature: FeatureModule = {
  id: SNIPPETS_FEATURE,
  start(c) {
    ctx = c;
    setSnippetHelper(c.helper);
    const onChange = () => schedule();
    c.store.on("change", onChange);
    offs.push(() => c.store.off("change", onChange));
    // A fresh {uuid}/{time}/{clipboard} for the next expansion.
    offs.push(c.helper.on("snippet.expanded", () => setTimeout(() => void refreshClipboardSnapshot().finally(notifyExpansionChange), 400)));
    void refreshClipboardSnapshot();
    schedule();
  },
  stop() {
    for (const off of offs.splice(0)) off();
    if (refreshTimer) clearInterval(refreshTimer);
    if (frontTimer) clearInterval(frontTimer);
    refreshTimer = frontTimer = undefined;
    setSnippetHelper(null);
    ctx = null;
  },
  items: () => [
    { ...cmd("search", "Search Snippets", "Browse, preview and paste snippets", "✂️", ["snippet", "paste", "text", "expand", "template"]), acceptsArgument: true },
    cmd("import", "Import Snippets…", "From Raycast's snippet export or a Glide JSON file", "📥", ["import", "raycast", "json", "snippets"]),
    cmd("export", "Export Snippets…", "Save all snippets as JSON", "📤", ["export", "json", "backup", "snippets"]),
  ],
  actions(item): ItemAction[] {
    if (item.id === "snippets.import") return [{ id: "importFile", title: "Import from File…", shortcut: "⏎" }, { id: "importClipboard", title: "Import JSON from Clipboard", shortcut: "⌘⏎" }];
    if (item.id === "snippets.export") return [{ id: "exportFile", title: "Export to File…", shortcut: "⏎" }, { id: "exportCopy", title: "Copy JSON", shortcut: "⌘⏎" }];
    return [{ id: "open", title: "Open", shortcut: "⏎" }, { id: "settings", title: "Open Snippets Settings", shortcut: "⌘⏎" }];
  },
  async runAction(scored, actionId) {
    const c = need();
    try {
      switch (actionId) {
        case "open":
          return { ok: true, view: { id: "snippets.search", props: { title: "Search Snippets", ...(scored.argument ? { query: scored.argument } : {}) } } };
        case "settings":
          c.openSettings("snippets");
          return { ok: true, hide: true };
        case "importFile":
          return report(await importFile());
        case "importClipboard":
          return report(importSnippetsJson(await clipboard.readText()));
        case "exportFile": {
          const f = await exportFile();
          return f ? { ok: true, message: `Exported to ${path.basename(f)}` } : { ok: true };
        }
        case "exportCopy":
          await clipboard.writeText(exportJson());
          return { ok: true, message: "Snippets JSON copied" };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    getSettings: () => snippetSettings(),
    setSettings: (patch: unknown) => {
      const next = sanitizeSnippetSettings({ ...snippetSettings(), ...(isRecord(patch) ? patch : {}) });
      need().setSettings(next);
      schedule();
      return next;
    },
    list: () => snippets(),
    save: (raw: unknown) => need().store.saveSnippet(cleanSnippet(raw)),
    delete: (id: unknown) => need().store.deleteSnippet(str(id)),
    /** Preview without reading the real clipboard/selection (shown as placeholders). */
    preview: (text: unknown, html: unknown) =>
      renderSnippet({ text: str(text), ...(str(html) ? { html: sanitizeHtml(str(html)) } : {}) }, { now: new Date(), clipboard: "‹clipboard›", selection: "‹selection›", uuid: () => crypto.randomUUID(), snippet: snippetLookup(snippets()) }),
    /** Render one snippet with live values (Search Snippets preview pane). */
    render: async (id: unknown) => {
      const s = findSnippet(str(id));
      return s ? renderForUse(s, snippets()) : null;
    },
    paste: (id: unknown) => pasteSnippetById(str(id), () => ctx?.hideLauncher()) ?? { ok: false, error: "Snippet not found" },
    copy: (id: unknown) => copySnippetById(str(id)) ?? { ok: false, error: "Snippet not found" },
    keywordWarning: (keyword: unknown) => keywordWarning(str(keyword), snippetSettings().keywordPrefix),
    importJson: (json: unknown) => importSnippetsJson(str(json)),
    exportJson: () => exportJson(),
    importFile: () => importFile(),
    exportFile: () => exportFile(),
    /** Running apps for the exclusion picker (read-only helper call). */
    runningApps: async () => {
      const c = need();
      if (!c.helper.available()) return [];
      const apps = await c.helper.call("layouts.apps").catch(() => []);
      return apps.filter((a) => a.bundleId).map((a) => ({ name: a.name, bundleId: a.bundleId! }));
    },
  },
};
