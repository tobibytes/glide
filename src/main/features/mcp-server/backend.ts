/**
 * The real MCP backend: agent-backed tools run through the Glide Agent's tool implementations
 * (createCapabilities over FeatureContext: ctx.search, ctx.executeItem, other features' methods),
 * and the few MCP-only tools are implemented here with ctx.callFeature / ctx.helper.
 */
import fs from "node:fs";
import path from "node:path";
import { createCapabilities } from "../agent/capabilities";
import { createCatalogueSource } from "../agent/catalogue";
import { asOp, clip, ToolFailure } from "../agent/tooling";
import { TOOLS as AGENT_TOOLS } from "../agent/tools";
import { assembleText } from "../ocr/text";
import { timerRemaining, type Timer } from "../timers/model";
import type { FeatureContext, FeatureModule } from "../types";
import { expandHome } from "../../util/exec";
import type { McpBackend, PreparedCall } from "./calls";
import type { ResourceSource } from "./resources";
import type { McpToolDef } from "./tools";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp", ".webp"]);

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const q = (s: string) => `“${s.length > 80 ? `${s.slice(0, 80)}…` : s}”`;

function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60 ? `${s % 60} s` : ""}`.trim() : `${s} s`;
}

export function createBackend(ctx: FeatureContext, features: () => Promise<FeatureModule[]>, featureIds: () => ReadonlySet<string>): McpBackend & { resources: ResourceSource } {
  const catalogue = createCatalogueSource(ctx, features);
  let caps: ReturnType<typeof createCapabilities> | null = null;
  const capabilities = () =>
    (caps ??= createCapabilities({ ctx, catalogue, features, featureIds: featureIds(), onLauncherHidden: () => undefined }));

  const timers = async (): Promise<Timer[]> => {
    const st = obj(await ctx.callFeature("timers", "state"));
    return Array.isArray(st.timers) ? (st.timers as Timer[]) : [];
  };

  const own: Record<string, (args: Record<string, unknown>) => PreparedCall | { error: string }> = {
    list_timers: () => ({
      describe: async () => "List timers",
      async run() {
        const st = obj(await ctx.callFeature("timers", "state"));
        const now = Date.now();
        const list = (Array.isArray(st.timers) ? (st.timers as Timer[]) : []).map((t) => ({ id: t.id, name: t.name || "Timer", durationMs: t.durationMs, remainingMs: timerRemaining(t, now), paused: t.pausedAt !== null }));
        const sw = (Array.isArray(st.stopwatches) ? st.stopwatches : []).map((x) => {
          const o = obj(x);
          const started = Number(o.startedAt) || now;
          const pausedAt = typeof o.pausedAt === "number" ? o.pausedAt : null;
          return { id: String(o.id), name: String(o.name || "Stopwatch"), elapsedMs: Math.max(0, (pausedAt ?? now) - started - (Number(o.pausedMs) || 0)), paused: pausedAt !== null };
        });
        return list.length || sw.length ? JSON.stringify({ timers: list, stopwatches: sw }) : "No timers are running.";
      },
    }),
    stop_timer: (a) => {
      const id = typeof a.id === "string" ? a.id.trim() : "";
      if (!id) return { error: '"id" is required' };
      return {
        async describe() {
          const t = (await timers()).find((x) => x.id === id);
          return t ? `Stop the timer ${q(t.name || "Timer")} (${minutes(timerRemaining(t, Date.now()))} left)` : `Stop timer ${id}`;
        },
        async run() {
          if (!(await timers()).some((x) => x.id === id)) throw new ToolFailure(`No timer with id ${id}. Use list_timers.`);
          const r = asOp(await ctx.callFeature("timers", "stop", id), "Timer stopped");
          if (!r.ok) throw new ToolFailure(r.error || "Could not stop the timer");
          return r.message || "Timer stopped";
        },
      };
    },
    list_reminders: (a) => {
      const query = typeof a.query === "string" ? a.query.trim().toLowerCase() : "";
      const limit = typeof a.limit === "number" && Number.isFinite(a.limit) ? Math.max(1, Math.min(100, Math.round(a.limit))) : 30;
      return {
        describe: async () => (query ? `List reminders matching ${q(query)}` : "List reminders"),
        async run() {
          const st = obj(await ctx.callFeature("reminders", "state"));
          if (st.status !== "ok") throw new ToolFailure(typeof st.message === "string" && st.message ? st.message : `Reminders unavailable (${String(st.status)}). Grant access in Glide → Reminders.`);
          const rows = (Array.isArray(st.reminders) ? st.reminders : [])
            .map(obj)
            .filter((r) => !query || String(r.title ?? "").toLowerCase().includes(query))
            .slice(0, limit)
            .map((r) => ({ id: r.id, title: r.title, due: r.due, allDay: r.dueAllDay || undefined, list: r.listTitle, completed: r.completed === true }));
          return rows.length ? clip(JSON.stringify(rows)) : "No reminders.";
        },
      };
    },
    capture_text_from_image: (a) => {
      const raw = typeof a.path === "string" ? a.path.trim() : "";
      if (!raw.startsWith("/") && !raw.startsWith("~/")) return { error: '"path" must be an absolute path or start with ~/' };
      const file = path.resolve(expandHome(raw));
      if (!IMAGE_EXT.has(path.extname(file).toLowerCase())) return { error: "Only image files (png, jpg, heic, tiff, gif, bmp, webp) can be read" };
      return {
        describe: async () => `Recognize text in ${raw}`,
        async run() {
          const st = fs.statSync(file, { throwIfNoEntry: false });
          if (!st?.isFile()) throw new ToolFailure(`No image file at ${raw}`);
          if (!ctx.helper.available()) throw new ToolFailure("Text recognition needs the Glide helper, which is not running.");
          const s = obj(await ctx.callFeature("ocr", "settings").catch(() => ({})));
          const languages = Array.isArray(s.languages) ? s.languages.filter((l): l is string => typeof l === "string") : undefined;
          // Called directly (not ocr.recognizeImage) so the OCR "auto copy" setting never touches the clipboard.
          const r = await ctx.helper.call("ocr.recognize", { path: file, languages: languages?.length ? languages : undefined, fast: s.fast === true, languageCorrection: s.languageCorrection !== false });
          const text = assembleText(r.lines);
          return text ? clip(text, 20_000) : "No text found in the image.";
        },
      };
    },
  };

  return {
    available: (t: McpToolDef) => !t.requires || featureIds().has(t.requires),
    prepare(t, args) {
      if (t.agentTool) {
        const at = AGENT_TOOLS.find((x) => x.name === t.agentTool);
        if (!at) return { error: `${t.name} is not available in this Glide build` };
        if (t.name === "run_command" && typeof args.id === "string" && args.id.startsWith("mcp-server:")) return { error: "MCP clients cannot run the MCP server's own commands" };
        const p = at.prepare(args, capabilities());
        if ("error" in p) return p;
        return { describe: p.describe, run: async () => (await p.run()).text };
      }
      const impl = own[t.name];
      return impl ? impl(args) : { error: `No implementation for ${t.name}` };
    },
    resources: {
      async notes() {
        const list = await ctx.callFeature<unknown>("notes", "search", "");
        return (Array.isArray(list) ? list : []).map(obj).map((n) => ({ id: String(n.id), title: String(n.title ?? ""), updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : undefined }));
      },
      async note(id) {
        const n = obj(await ctx.callFeature<unknown>("notes", "get", id));
        return typeof n.id === "string" && n.id === id && typeof n.body === "string" ? { id: n.id, body: n.body } : null;
      },
      clipboardRecent: (limit) => capabilities().clipboardHistory("", limit),
    },
  };
}
