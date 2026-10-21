/**
 * Real AgentCapabilities: wires the agent's tools to the helper, the catalogue and other
 * features' public `methods` (the same calls their renderers make).
 */
import fs from "node:fs";
import { clipboard, shell } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { WindowAction } from "../../native/helper";
import { calculatorItems } from "../../sources/calculator";
import { expandHome, openApp, sleep } from "../../util/exec";
import type { FeatureContext, FeatureModule } from "../types";
import type { CatalogueSource } from "./catalogue";
import type { AgentCapabilities, OpResult } from "./tools";

const NEEDS_ACCESSIBILITY = "Glide needs Accessibility permission to move windows (System Settings → Privacy & Security → Accessibility).";

export interface CapabilityDeps {
  ctx: FeatureContext;
  catalogue: CatalogueSource;
  features(): Promise<FeatureModule[]>;
  /** Called when a tool hid the launcher, so the run can bring its view back afterwards. */
  onLauncherHidden(): void;
}

function asOp(r: unknown, fallback = "Done"): OpResult {
  const e = r as Partial<ExecuteResult> | null | undefined;
  if (!e || typeof e !== "object") return { ok: r !== false, message: fallback };
  return { ok: e.ok !== false, message: typeof e.message === "string" ? e.message : fallback, error: typeof e.error === "string" ? e.error : undefined };
}

export function createCapabilities(deps: CapabilityDeps): AgentCapabilities {
  const { ctx } = deps;

  const method = async (featureId: string, name: string, ...args: unknown[]): Promise<unknown> => {
    const m = (await deps.features()).find((f) => f.id === featureId)?.methods?.[name];
    if (!m) throw new Error(`The ${featureId} feature is not available`);
    return m(...args);
  };

  const hide = async (ms = 150) => {
    ctx.hideLauncher();
    deps.onLauncherHidden();
    await sleep(ms);
  };

  return {
    now: () => Date.now(),
    search: (q, limit) => deps.catalogue.search(q, limit),
    findItem: (id) => deps.catalogue.find(id),

    async executeItem(id, argument) {
      const r = await ctx.executeItem(id, argument);
      if (r.hide) {
        ctx.hideLauncher();
        deps.onLauncherHidden();
      }
      return { ok: r.ok, message: r.message ?? (r.navigate ? "Opened in Glide Settings" : "Done"), error: r.error };
    },

    listWorkflows: () => ctx.getData().workflows.map((w) => ({ id: w.id, name: w.name, description: w.description, acceptsInput: w.acceptsInput })),
    async runWorkflow(id, input) {
      const wf = ctx.getData().workflows.find((w) => w.id === id);
      if (!wf) return { ok: false, error: "Workflow not found" };
      const r = await ctx.runtime.run(wf, input);
      const failed = r.log.find((l) => l.status === "error");
      return { ok: r.ok, result: r.result, error: failed?.error ?? (r.ok ? undefined : "Workflow failed") };
    },

    async windowAction(action: WindowAction, app?: string) {
      if (!ctx.helper.available()) return { ok: false, error: "Window management needs the Glide helper, which is not running." };
      const perms = await ctx.helper.call("permissions.status").catch(() => null);
      if (perms && !perms.accessibility) return { ok: false, error: NEEDS_ACCESSIBILITY };
      await hide();
      if (app) {
        try {
          await openApp(app);
        } catch {
          return { ok: false, error: `Couldn't find an app named “${app}”` };
        }
        await sleep(450); // let the app activate and its window become main
      }
      const r = await ctx.helper.call("windows.apply", { action });
      return r.ok ? { ok: true, message: "Window moved" } : { ok: false, error: r.error === "Accessibility permission required" ? NEEDS_ACCESSIBILITY : r.error };
    },

    async openUrl(url) {
      deps.onLauncherHidden();
      await shell.openExternal(url);
      return { ok: true, message: `Opened ${url}` };
    },
    async openApp(name) {
      await hide(80);
      try {
        await openApp(name);
        return { ok: true, message: `Opened ${name}` };
      } catch {
        return { ok: false, error: `Couldn't find an app named “${name}”` };
      }
    },
    async openFile(p) {
      const full = expandHome(p);
      if (!fs.existsSync(full)) return { ok: false, error: `No file at ${p}` };
      deps.onLauncherHidden();
      const err = await shell.openPath(full);
      return err ? { ok: false, error: err } : { ok: true, message: `Opened ${p}` };
    },

    clipboardText: async () => clipboard.readText(),
    async copyText(text) {
      clipboard.writeText(text);
      return { ok: true, message: "Copied to the clipboard" };
    },
    async selectedText() {
      if (!ctx.helper.available()) return { text: null, error: "Reading the selection needs the Glide helper, which is not running." };
      try {
        const timeout = new Promise<{ text: null }>((r) => setTimeout(() => r({ text: null }), 1500));
        const r = await Promise.race([ctx.helper.call("selection.text"), timeout]);
        return { text: r.text };
      } catch (err) {
        return { text: null, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async startTimer(ms, name) {
      return asOp(await method("timers", "start", ms, name), "Timer started");
    },
    async createNote(text) {
      const note = (await method("notes", "create")) as { id?: unknown } | null;
      if (!note || typeof note.id !== "string") return { ok: false, error: "Could not create a note" };
      await method("notes", "save", note.id, text);
      return { ok: true, id: note.id };
    },
    async searchNotes(query) {
      const list = (await method("notes", "search", query)) as Array<{ id: string; title: string; preview?: string }>;
      return Array.isArray(list) ? list.map((n) => ({ id: n.id, title: n.title, preview: n.preview })) : [];
    },
    async openNote(id) {
      deps.onLauncherHidden();
      const ok = await method("notes", "open", id);
      return { ok: ok !== false, message: "Note opened" };
    },

    async convert(query) {
      const out = ((await method("convert", "preview", query).catch(() => [])) as Array<{ title: string; subtitle?: string }>) ?? [];
      if (out.length) return out;
      return calculatorItems(query).map((s) => ({ title: s.item.title, subtitle: "Calculator" }));
    },

    async calendarEvents(from, to) {
      if (!ctx.helper.available()) return { ok: false, error: "Calendar access needs the Glide helper, which is not running." };
      try {
        const perms = await ctx.helper.call("permissions.status");
        if (perms.calendar !== "authorized") return { ok: false, error: "Glide doesn't have calendar access. Grant it in Settings → Calendar (My Schedule)." };
        const events = await ctx.helper.call("calendar.events", { from, to });
        return { ok: true, events: events.map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, calendar: e.calendar })) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
