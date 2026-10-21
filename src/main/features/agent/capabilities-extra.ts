/**
 * Real ExtraCapabilities: other features' public `methods` (the same calls their renderers make),
 * the Store for snippets/quicklinks and the `shortcuts` CLI. In headless test mode, killing a
 * process and running a shortcut are recorded as "[headless] …" lines instead of performed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExecuteResult } from "@shared/ipc";
import { HEADLESS } from "../../headless";
import { applyTransform, TRANSFORMS } from "../transforms/transforms";
import type { FeatureContext } from "../types";
import { asOp } from "./tooling";
import { isProtectedProcess } from "./safety";
import type { AppearanceInfo, ExtraCapabilities, ProcessRow } from "./tools-extra";

export interface ExtraDeps {
  ctx: FeatureContext;
  method(featureId: string, name: string, ...args: unknown[]): Promise<unknown>;
  featureIds: ReadonlySet<string>;
  onLauncherHidden(): void;
}

const SHORTCUT_TIMEOUT_MS = 120_000;

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const newId = (prefix: string) => `${prefix}-agent-${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;

function headless(kind: string, detail: unknown): void {
  console.log(`[headless] ${kind} ${JSON.stringify(detail)}`);
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function createExtraCapabilities(deps: ExtraDeps): ExtraCapabilities {
  const { ctx, method } = deps;

  const tryMethods = async (featureId: string, names: string[], ...args: unknown[]): Promise<unknown> => {
    let last: unknown = new Error(`The ${featureId} feature is not available`);
    for (const name of names) {
      try {
        return await method(featureId, name, ...args);
      } catch (err) {
        last = err;
        if (!(err instanceof Error) || !/not available/.test(err.message)) throw err;
      }
    }
    throw last;
  };

  const listProcesses = async (): Promise<ProcessRow[]> => {
    const r = obj(await method("processes", "list"));
    const list = Array.isArray(r.processes) ? r.processes : [];
    return list.map((p) => {
      const o = obj(p);
      return { pid: n(o.pid), name: s(o.name), cpu: n(o.cpu), rssKb: n(o.rssKb), user: s(o.user), command: s(o.command) };
    });
  };

  return {
    hasFeature: (id) => deps.featureIds.has(id),

    async listAutomations() {
      const st = obj(await method("automations", "state"));
      const list = Array.isArray(st.automations) ? st.automations : [];
      return list.map((a) => {
        const o = obj(a);
        return { id: s(o.id), name: s(o.name), enabled: o.enabled !== false, trigger: s(o.triggerText), target: s(o.targetText) };
      });
    },
    async createAutomation(spec) {
      const r = obj(await method("automations", "save", { name: spec.name, trigger: spec.trigger, target: spec.target, askBeforeRunning: spec.askBeforeRunning, enabled: true }));
      if (r.ok !== true) return { ok: false, error: s(r.error) || "Could not save the automation" };
      return { ok: true, id: s(obj(r.automation).id) };
    },
    async deleteAutomation(id) {
      return asOp(await method("automations", "remove", id), "Automation deleted");
    },
    async runAutomation(id) {
      return asOp(await method("automations", "runNow", id), "Automation ran");
    },

    async listLayouts() {
      const st = obj(await method("layouts", "state"));
      const list = Array.isArray(st.layouts) ? st.layouts : [];
      return list.map((l) => {
        const o = obj(l);
        return { id: s(o.id), name: s(o.name), summary: s(o.summary) };
      });
    },
    async restoreLayout(id) {
      const r = (await method("layouts", "restore", id)) as ExecuteResult;
      if (r?.hide) deps.onLauncherHidden();
      return asOp(r, "Layout restored");
    },
    async saveLayout(name) {
      try {
        const l = obj(await method("layouts", "save", name));
        const windows = Array.isArray(l.windows) ? l.windows.length : 0;
        return { ok: true, id: s(l.id), summary: `${windows} window${windows === 1 ? "" : "s"}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async deleteLayout(id) {
      return asOp(await method("layouts", "deleteLayout", id), "Layout deleted");
    },

    listTransforms: () => TRANSFORMS.map((t) => ({ id: t.id, title: t.title, category: t.category })),
    applyTransform: (id, input) => applyTransform(id, input),

    async searchBookmarks(query, limit) {
      try {
        const rows = await method("browser", "search", query, "bookmark", limit);
        const list = Array.isArray(rows) ? rows : [];
        return { ok: true, items: list.slice(0, limit).map((r) => ({ title: s(obj(r).title), url: s(obj(r).url), folder: s(obj(r).folder) || undefined, browser: s(obj(r).browserName) || undefined })) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    listProcesses,
    async checkProcess(pid) {
      const p = (await listProcesses()).find((x) => x.pid === pid) as (ProcessRow & { command?: string }) | undefined;
      if (!p) return { exists: false, name: "", command: "", protected: false };
      const command = p.command ?? p.name;
      if (isProtectedProcess(p.name, command)) return { exists: true, name: p.name, command, protected: true, reason: `${p.name} is a protected system or Glide process` };
      const risk = obj(await method("processes", "risk", pid).catch(() => null));
      if (risk.level === "warn") return { exists: true, name: p.name, command, protected: true, reason: s(risk.reason) };
      return { exists: true, name: p.name, command, protected: false };
    },
    async killProcess(pid, force, expectedCommand) {
      if (HEADLESS) {
        headless("agent.kill_process", { pid, force });
        return { ok: true, message: `Headless: would ${force ? "force quit" : "quit"} PID ${pid}` };
      }
      return asOp(await method("processes", "signal", pid, force ? "SIGKILL" : "SIGTERM", { confirmed: true, expectedCommand }), "Signal sent");
    },

    async systemStatus() {
      const st = obj(await method("sysmon", "sample"));
      const smp = obj(st.sample ?? st);
      const cpu = obj(smp.cpu);
      const mem = obj(smp.memory);
      const disk = obj(smp.disk);
      const bat = obj(smp.battery);
      const net = obj(smp.net);
      const lines = [
        `CPU ${Math.round(n(cpu.total) * (n(cpu.total) <= 1 ? 100 : 1))}% · load ${Array.isArray(cpu.load) ? cpu.load.map((x) => n(x).toFixed(2)).join(" ") : "?"}`,
        smp.memory ? `Memory ${gb(n(mem.usedBytes))} of ${gb(n(mem.totalBytes))} used` : "",
        smp.disk ? `Disk ${gb(n(disk.availableBytes))} free of ${gb(n(disk.totalBytes))}` : "",
        smp.battery ? `Battery ${n(bat.percent)}% (${s(bat.state)}${bat.remainingMin ? `, ${n(bat.remainingMin)} min left` : ""})` : "",
        `Network ↓${Math.round(n(net.rxPerSec) / 1024)} KB/s ↑${Math.round(n(net.txPerSec) / 1024)} KB/s`,
        `Uptime ${Math.round(n(smp.uptimeSec) / 3600)} h`,
        Array.isArray(smp.top) && smp.top.length ? `Busiest: ${smp.top.map((p) => `${s(obj(p).name)} (PID ${n(obj(p).pid)}, ${n(obj(p).cpu).toFixed(0)}% CPU)`).join(", ")}` : "",
      ];
      return lines.filter(Boolean).join("\n");
    },

    async createReminder(r) {
      const due = r.due ? Date.parse(r.due) : undefined;
      // The reminders feature takes an ISO `due`; the model may send any parseable date.
      const iso = due !== undefined && Number.isFinite(due) ? new Date(due).toISOString() : undefined;
      const res = await tryMethods("reminders", ["create", "add"], { title: r.title, notes: r.notes, ...(iso ? { due: iso } : {}) });
      const o = obj(res);
      if (res === false || o.ok === false) return { ok: false, error: s(o.error) || "Could not create the reminder" };
      const id = s(o.id) || s(obj(o.reminder).id);
      return { ok: true, id: id || undefined, message: s(o.message) || "Reminder created" };
    },
    async deleteReminder(id) {
      // Reminders has no delete; undo marks the reminder completed instead.
      try {
        return asOp(await tryMethods("reminders", ["delete", "remove"], id), "Reminder deleted");
      } catch {
        return asOp(await tryMethods("reminders", ["complete"], id, true), "Reminder marked completed");
      }
    },

    async clipboardHistory(query, limit) {
      const list = await method("clipboard", "list", { query, limit });
      return (Array.isArray(list) ? list : []).map((e) => {
        const o = obj(e);
        return { type: s(o.type), title: s(o.title), preview: s(o.preview), copiedAt: n(o.lastCopiedAt) };
      });
    },

    async createSnippet(sn) {
      const data = ctx.getData();
      if (sn.keyword && data.snippets.some((x) => x.keyword === sn.keyword)) return { ok: false, error: `The keyword ${sn.keyword} is already used by another snippet` };
      const id = newId("sn");
      ctx.store.saveSnippet({ id, name: sn.name, text: sn.text, ...(sn.keyword ? { keyword: sn.keyword } : {}) });
      return { ok: true, id };
    },
    async deleteSnippet(id) {
      if (!ctx.getData().snippets.some((x) => x.id === id)) return { ok: false, error: "That snippet no longer exists" };
      ctx.store.deleteSnippet(id);
      return { ok: true, message: "Snippet deleted" };
    },
    async createQuicklink(q) {
      const id = newId("ql");
      ctx.store.saveQuicklink({ id, name: q.name, url: q.url });
      return { ok: true, id };
    },
    async deleteQuicklink(id) {
      if (!ctx.getData().quicklinks.some((x) => x.id === id)) return { ok: false, error: "That quicklink no longer exists" };
      ctx.store.deleteQuicklink(id);
      return { ok: true, message: "Quicklink deleted" };
    },

    async runShortcut(name, input) {
      if (HEADLESS) {
        headless("agent.run_shortcut", { name, input: input ? "(text)" : undefined });
        return { ok: true, message: `Headless: would run the shortcut “${name}”` };
      }
      const dir = fs.mkdtempSync(path.join(ctx.dataDir(), "shortcut-"));
      const out = path.join(dir, "out.txt");
      const args = ["run", name, "--output-path", out];
      if (input !== undefined) {
        const inFile = path.join(dir, "in.txt");
        fs.writeFileSync(inFile, input);
        args.push("--input-path", inFile);
      }
      try {
        const err = await new Promise<string | null>((resolve) =>
          execFile("/usr/bin/shortcuts", args, { timeout: SHORTCUT_TIMEOUT_MS }, (e, _stdout, stderr) => resolve(e ? String(stderr || e.message).trim() : null)),
        );
        if (err) return { ok: false, error: /couldn.t find|not found/i.test(err) ? `No shortcut named “${name}”` : err };
        const output = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
        return { ok: true, output, message: "Shortcut finished" };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    async appearance(): Promise<AppearanceInfo> {
      const g = obj(await method("appearance", "get"));
      const st = obj(g.settings);
      const mode = g.mode === "dark" || g.mode === "light" ? g.mode : "system";
      const presets = (Array.isArray(g.presets) ? g.presets : []).map((p) => ({ id: s(obj(p).id), name: s(obj(p).name), scheme: obj(p).scheme === "light" ? ("light" as const) : ("dark" as const) }));
      return { mode, darkTheme: s(st.darkTheme), lightTheme: s(st.lightTheme), presets };
    },
    async setAppearance(p) {
      if (p.preset) {
        const r = obj(await method("appearance", "applyPreset", p.preset));
        if (r.ok !== true) return { ok: false, error: `Unknown theme ${p.preset}` };
      }
      if (p.mode) await method("appearance", "setMode", p.mode);
      return { ok: true, message: "Theme changed" };
    },
    async restoreAppearance(prev) {
      await method("appearance", "set", { darkTheme: prev.darkTheme, lightTheme: prev.lightTheme });
      await method("appearance", "setMode", prev.mode);
      return { ok: true, message: "Theme restored" };
    },
  };
}
