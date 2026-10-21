/**
 * Workflow actions for existing features, registered by the host on behalf of those features
 * (each runs with the owning feature's FeatureContext and calls its public methods, so the
 * feature's own state — timers, layouts, automations — stays authoritative).
 */
import type { ExecuteResult } from "@shared/ipc";
import type { FeatureContext } from "../features/types";
import { applyTransform, TRANSFORMS } from "../features/transforms/transforms";
import { parseDurationAndName } from "../features/timers/model";
import { HEADLESS } from "../headless";
import type { FeatureWorkflowAction } from "./feature-actions";

export interface BuiltinFeatureAction {
  feature: string;
  def: FeatureWorkflowAction<FeatureContext>;
}

const emoji = (value: string) => ({ kind: "emoji" as const, value });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Interprets an ExecuteResult returned by a feature method: throws on failure, returns its message. */
function unwrap(res: unknown, fallback: string): string {
  if (isRecord(res) && res.ok === false) throw new Error(typeof res.error === "string" ? res.error : "The action failed");
  const r = res as ExecuteResult | undefined;
  return (isRecord(r) && typeof r.message === "string" && r.message) || fallback;
}

/** Find a named entity by id, else exact (case-insensitive) name, else unique name prefix. */
export function pickByName<T extends { id: string; name: string }>(list: readonly T[], wanted: string): T | undefined {
  const w = wanted.trim().toLowerCase();
  if (!w) return undefined;
  const byId = list.find((x) => x.id === wanted.trim());
  if (byId) return byId;
  const exact = list.find((x) => x.name.toLowerCase() === w);
  if (exact) return exact;
  const prefix = list.filter((x) => x.name.toLowerCase().startsWith(w));
  return prefix.length === 1 ? prefix[0] : undefined;
}

const listOf = (state: unknown, key: string): Array<{ id: string; name: string }> => {
  const raw = isRecord(state) ? state[key] : undefined;
  return Array.isArray(raw) ? raw.filter((x): x is { id: string; name: string } => isRecord(x) && typeof x.id === "string" && typeof x.name === "string") : [];
};

export function transformActions(): BuiltinFeatureAction[] {
  return TRANSFORMS.map((t) => ({
    feature: "transforms",
    def: {
      id: t.id,
      title: `Transform: ${t.title}`,
      description: t.usesInput ? `${t.category} transform of the text; the output becomes {{result}}` : "Generates a value into {{result}}",
      icon: emoji("🔀"),
      category: "text",
      params: [
        ...(t.usesInput ? [{ key: "text", label: "Text", kind: "multiline" as const, placeholder: "{{result}}", default: "{{result}}" }] : []),
        ...(t.id === "wrap" ? [{ key: "width", label: "Line width", kind: "number" as const, default: "80" }] : []),
      ],
      run: (_ctx, p) => {
        const res = applyTransform(t.id, p.text ?? "", { width: p.width ? Number(p.width) || undefined : undefined });
        if (!res.ok) throw new Error(res.error);
        return res.output;
      },
    },
  }));
}

const startTimer: BuiltinFeatureAction = {
  feature: "timers",
  def: {
    id: "start",
    title: "Start Timer",
    description: "Start a countdown timer (e.g. 25m, 1h30m, 5:00)",
    icon: emoji("⏱️"),
    category: "system",
    params: [
      { key: "duration", label: "Duration", kind: "text", placeholder: "25m", required: true },
      { key: "name", label: "Name", kind: "text", placeholder: "Focus" },
    ],
    run: async (ctx, p) => {
      const parsed = parseDurationAndName(p.duration ?? "");
      if (!parsed || !(parsed.ms > 0)) throw new Error(`Not a duration: “${p.duration ?? ""}” (try 25m, 1h30m or 5:00)`);
      const name = (p.name ?? "").trim() || parsed.name;
      return unwrap(await ctx.callFeature("timers", "start", parsed.ms, name), "Timer started");
    },
  },
};

const restoreLayout: BuiltinFeatureAction = {
  feature: "layouts",
  def: {
    id: "restore",
    title: "Restore Window Layout",
    description: "Move windows back to a saved layout",
    icon: emoji("🪟"),
    category: "apps",
    params: [{ key: "layout", label: "Layout (name or id)", kind: "text", placeholder: "Coding", required: true }],
    run: async (ctx, p) => {
      const layout = pickByName(listOf(await ctx.callFeature("layouts", "state"), "layouts"), p.layout ?? "");
      if (!layout) throw new Error(`No saved layout called “${p.layout ?? ""}”`);
      return unwrap(await ctx.callFeature("layouts", "restore", layout.id), `Restored “${layout.name}”`);
    },
  },
};

const captureText: BuiltinFeatureAction = {
  feature: "ocr",
  def: {
    id: "captureText",
    title: "Capture Text (OCR)",
    description: "Recognise text in a screen region you select, or in an image file; the text becomes {{result}}",
    icon: emoji("🔍"),
    category: "text",
    params: [
      { key: "source", label: "Source", kind: "select", options: ["screen", "file"], default: "screen", required: true },
      { key: "path", label: "Image file (source = file)", kind: "file", placeholder: "~/Desktop/shot.png" },
    ],
    outputVar: "ocrText",
    run: async (_ctx, p) => {
      const ocr = await import("../features/ocr/index");
      if ((p.source || "screen") === "file") {
        const file = (p.path ?? "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        if (!file) throw new Error("Choose an image file");
        return (await ocr.recognizeFile(file, "file")).text;
      }
      // Interactive region capture puts UI on screen: never in headless/test runs.
      if (HEADLESS || process.env.VITEST) throw new Error("Interactive screen capture is disabled in headless mode");
      const { captureRegion, removeQuietly } = await import("../features/ocr/capture");
      const shot = await captureRegion();
      if (!shot) throw new Error("Cancelled");
      try {
        return (await ocr.recognizeFile(shot, "screen")).text;
      } finally {
        removeQuietly(shot);
      }
    },
  },
};

const runAutomation: BuiltinFeatureAction = {
  feature: "automations",
  def: {
    id: "runNow",
    title: "Run Automation Now",
    description: "Run an automation immediately, ignoring its trigger",
    icon: emoji("⚡"),
    category: "control",
    params: [{ key: "automation", label: "Automation (name or id)", kind: "text", placeholder: "Morning routine", required: true }],
    run: async (ctx, p) => {
      const a = pickByName(listOf(await ctx.callFeature("automations", "state"), "automations"), p.automation ?? "");
      if (!a) throw new Error(`No automation called “${p.automation ?? ""}”`);
      return unwrap(await ctx.callFeature("automations", "runNow", a.id), `Ran “${a.name}”`);
    },
  },
};

const convert: BuiltinFeatureAction = {
  feature: "convert",
  def: {
    id: "convert",
    title: "Convert Units / Currency",
    description: "Evaluate a conversion like “10 km in mi” or “25 usd to eur”; the answer becomes {{result}}",
    icon: emoji("📐"),
    category: "text",
    params: [{ key: "query", label: "Conversion", kind: "text", placeholder: "{{input}} usd to eur", required: true }],
    outputVar: "converted",
    run: async (ctx, p) => {
      const q = (p.query ?? "").trim();
      if (!q) throw new Error("Nothing to convert");
      const [hit] = await ctx.search(q, { feature: "convert", limit: 1 });
      const text = hit?.item.text ?? (typeof hit?.item.data?.copy === "string" ? hit.item.data.copy : undefined);
      if (!text) throw new Error(`Can't convert “${q}”`);
      return text;
    },
  },
};

export function builtinFeatureActions(): BuiltinFeatureAction[] {
  return [...transformActions(), startTimer, restoreLayout, captureText, runAutomation, convert];
}
