/**
 * Colors: "Pick Color" (system color sampler via the Swift helper), "Color History",
 * and colors typed in the root search ("#ff8800", "rgb(…)", "hsl(…)") shown as a swatch with conversions.
 */
import fs from "node:fs";
import path from "node:path";
import { clipboard } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { hud } from "../app/hud";
import { copyText, pasteText } from "../convert/output";
import type { FeatureContext, FeatureModule } from "../types";
import { sleep } from "../../util/exec";
import { ALL_FORMATS, FORMAT_TITLES, formatColor, hexOf, parseColor, rgbToHsl, type ColorFormat, type RGBA } from "./colors";

export interface ColorEntry {
  hex: string; // "#RRGGBB"
  rgba: RGBA;
  at: number;
  source: "picker" | "search";
}

export interface ColorSettings {
  /** Format copied after picking. */
  pickFormat: ColorFormat;
}

const MAX_HISTORY = 60;
const DEFAULT_SETTINGS: ColorSettings = { pickFormat: "hex" };

let ctx: FeatureContext | undefined;
let history: ColorEntry[] = [];
let picking = false;

const file = () => (ctx ? path.join(ctx.dataDir(), "history.json") : "");

function settings(): ColorSettings {
  const s = ctx?.settings(DEFAULT_SETTINGS as unknown as Record<string, unknown>) ?? {};
  return { pickFormat: typeof s.pickFormat === "string" && s.pickFormat in FORMAT_TITLES ? (s.pickFormat as ColorFormat) : "hex" };
}

function load() {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
    history = Array.isArray(raw) ? raw.filter((e): e is ColorEntry => !!e && typeof e.hex === "string" && !!e.rgba && typeof e.at === "number") : [];
  } catch {
    history = [];
  }
}

function save() {
  if (!ctx) return;
  try {
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(history));
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    ctx.log("could not save color history", err);
  }
}

function changed() {
  save();
  ctx?.refreshCatalogue(); // "Color History" subtitle shows the count
  ctx?.emit("history", history);
}

export function addToHistory(list: ColorEntry[], rgba: RGBA, source: ColorEntry["source"], now: number): ColorEntry[] {
  const hex = formatColor(rgba, "hex");
  return [{ hex, rgba, at: now, source }, ...list.filter((e) => e.hex !== hex)].slice(0, MAX_HISTORY);
}

async function pick(): Promise<ExecuteResult> {
  if (!ctx) return { ok: false, error: "Not ready" };
  if (picking) return { ok: false, error: "The color picker is already open" };
  if (!ctx.helper.available()) return { ok: false, error: "Pick Color needs the Glide helper (run `node scripts/build-helper.mjs`)" };
  picking = true;
  try {
    ctx.hideLauncher();
    await sleep(250); // let the panel fade before the loupe appears
    const res = await ctx.helper.call("color.pick", {});
    if (!res.hex) return { ok: true, hide: true, message: res.reason === "timeout" ? "Color picker timed out" : "Cancelled" };
    const rgba = parseColor(res.hex)!;
    history = addToHistory(history, rgba, "picker", Date.now());
    changed();
    const text = formatColor(rgba, settings().pickFormat);
    clipboard.writeText(text);
    hud(`Copied ${text}`);
    // Come back to the history (the new color is listed first) so the result can be checked.
    ctx.openView({ id: "color.history", props: {} });
    return { ok: true, message: `Copied ${text}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    picking = false;
  }
}

function swatchItem(query: string, c: RGBA): ScoredItem {
  const hsl = rgbToHsl(c);
  const item: SearchItem = {
    id: `color:swatch:${query.trim().toLowerCase()}`,
    kind: "calculator",
    title: formatColor(c, "hex"),
    subtitle: `${formatColor(c, "rgb")} · hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%) · ⌘K for more formats`,
    icon: { kind: "color", value: c.a < 1 ? formatColor(c, "rgb") : hexOf(c) },
    feature: "color",
    kindLabel: "Color",
    data: { rgba: { ...c }, noUsage: true },
  };
  return { item, score: 999, matchScore: 999, matchKind: "exact", frecency: 0, ranges: [] };
}

const rgbaOf = (item: SearchItem): RGBA | undefined => {
  const v = item.data?.rgba as Partial<RGBA> | undefined;
  return v && typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number" ? { r: v.r, g: v.g, b: v.b, a: typeof v.a === "number" ? v.a : 1 } : undefined;
};

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[]): SearchItem => ({
  id: `color:${id}`,
  kind: "command",
  kindLabel: "Color",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "color",
  data: { action: id },
});

export const feature: FeatureModule = {
  id: "color",
  start(c) {
    ctx = c;
    load();
  },
  items: () => [
    item("pick", "Pick Color", "Color Picker", "🎨", ["color", "colour", "picker", "eyedropper", "sample", "screen", "hex"]),
    item("history", "Color History", `${history.length} color${history.length === 1 ? "" : "s"}`, "🌈", ["color", "colour", "picked", "palette", "hex", "recent"]),
  ],
  dynamicItems(query) {
    const q = query.trim();
    if (q.length < 4 || !/^(#|rgb|hsl)/i.test(q)) return [];
    const c = parseColor(q);
    return c ? [swatchItem(q, c)] : [];
  },
  actions(i): ItemAction[] {
    if (i.data?.action === "pick") return [{ id: "pick", title: "Pick Color", shortcut: "⏎" }, { id: "history", title: "Show Color History", shortcut: "⌘⏎" }];
    if (i.data?.action === "history") return [{ id: "history", title: "Show Color History", shortcut: "⏎" }, { id: "pick", title: "Pick Color", shortcut: "⌘⏎" }];
    if (rgbaOf(i))
      return [
        { id: "copy:hex", title: "Copy HEX", shortcut: "⏎", icon: "📋" },
        { id: "paste:hex", title: "Paste HEX", shortcut: "⌘⏎", icon: "📥" },
        ...ALL_FORMATS.filter((f) => f !== "hex").map((f) => ({ id: `copy:${f}`, title: `Copy ${FORMAT_TITLES[f]}`, icon: "📋" })),
        { id: "save", title: "Save to Color History", shortcut: "⌘S", icon: "🌈" },
      ];
    return [];
  },
  async runAction(scored, actionId) {
    if (actionId === "pick") return pick();
    if (actionId === "history") return { ok: true, view: { id: "color.history" } };
    const c = rgbaOf(scored.item);
    if (!c) return { ok: false, error: "Not a color" };
    const [verb, fmt] = actionId.split(":") as [string, ColorFormat | undefined];
    if (verb === "save") {
      history = addToHistory(history, c, "search", Date.now());
      changed();
      return { ok: true, message: "Saved to Color History" };
    }
    if (fmt && fmt in FORMAT_TITLES) {
      const text = formatColor(c, fmt);
      return verb === "paste" ? pasteText(ctx, text) : copyText(text);
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    history: () => history,
    pick: () => pick(),
    settings: () => settings(),
    setSettings: (patch: unknown) => {
      const f = (patch as Partial<ColorSettings> | null)?.pickFormat;
      if (typeof f === "string" && f in FORMAT_TITLES) ctx?.setSettings({ pickFormat: f });
      return settings();
    },
    copy: (hex: unknown, format: unknown) => {
      const c = typeof hex === "string" ? parseColor(hex) : undefined;
      if (!c || typeof format !== "string" || !(format in FORMAT_TITLES)) return null;
      const text = formatColor(c, format as ColorFormat);
      clipboard.writeText(text);
      return text;
    },
    paste: async (hex: unknown, format: unknown) => {
      const c = typeof hex === "string" ? parseColor(hex) : undefined;
      if (!c || typeof format !== "string" || !(format in FORMAT_TITLES)) return { ok: false, error: "Invalid color" };
      return pasteText(ctx, formatColor(c, format as ColorFormat));
    },
    add: (text: unknown) => {
      const c = typeof text === "string" ? parseColor(text) : undefined;
      if (!c) return history;
      history = addToHistory(history, c, "search", Date.now());
      changed();
      return history;
    },
    remove: (hex: unknown) => {
      history = history.filter((e) => e.hex !== hex);
      changed();
      return history;
    },
    clear: () => {
      history = [];
      changed();
      return history;
    },
    /** Test hook: whether the helper binary is running (the picker itself is interactive). */
    helperAvailable: () => ctx?.helper.available() ?? false,
  },
};
