import fs from "node:fs";
import path from "node:path";
import { clipboard } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { ScoredItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { pasteFromClipboard } from "../../workflows/runtime";
import { sleep } from "../../util/exec";
import { findEmoji, searchEmoji, usageSections, withTone, type UsageEntry } from "../../../renderer/features/emoji/model";

let ctx: FeatureContext | undefined;
let usage: Record<string, UsageEntry> = {};
let saveTimer: NodeJS.Timeout | undefined;

const usageFile = () => (ctx ? path.join(ctx.dataDir(), "usage.json") : "");
const skinTone = (): number => {
  const t = ctx?.settings({ skinTone: 0 }).skinTone;
  return typeof t === "number" && t >= 0 && t <= 5 ? t : 0;
};

function loadUsage() {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(usageFile(), "utf8"));
    if (raw && typeof raw === "object") usage = raw as Record<string, UsageEntry>;
  } catch {
    usage = {};
  }
}

function saveUsage() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(usageFile(), JSON.stringify(usage));
    } catch (err) {
      ctx?.log("could not save usage", err);
    }
  }, 500);
}

/** Usage is keyed by the base emoji so a later skin-tone change still applies. */
function recordUse(base: string) {
  const prev = usage[base];
  usage[base] = { count: (prev?.count ?? 0) + 1, last: Date.now() };
  saveUsage();
}

const toneFor = (base: string): string => {
  const e = findEmoji(base);
  return e ? withTone(e, skinTone()) : base;
};

async function paste(base: string): Promise<ExecuteResult> {
  if (!ctx) return { ok: false, error: "Not ready" };
  const text = toneFor(base);
  recordUse(base);
  ctx.hideLauncher();
  await sleep(120); // let the previous app regain focus
  if (ctx.helper.available()) {
    try {
      const res = await ctx.helper.call("keys.paste", { text });
      if (res.ok) return { ok: true, hide: true };
    } catch {
      // fall through to the clipboard path
    }
  }
  clipboard.writeText(text);
  try {
    await pasteFromClipboard();
    return { ok: true, hide: true };
  } catch (err) {
    return { ok: true, hide: true, message: `Copied ${text} — ${err instanceof Error ? err.message : String(err)}` };
  }
}

function copy(base: string): ExecuteResult {
  const text = toneFor(base);
  clipboard.writeText(text);
  recordUse(base);
  return { ok: true, hide: true, message: `Copied ${text}` };
}

export const feature: FeatureModule = {
  id: "emoji",
  start(c) {
    ctx = c;
    loadUsage();
  },
  stop() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      try {
        fs.writeFileSync(usageFile(), JSON.stringify(usage));
      } catch {
        /* best effort */
      }
    }
  },
  items: () => [
    {
      id: "emoji:picker",
      kind: "command",
      kindLabel: "Command",
      title: "Search Emoji & Symbols",
      subtitle: "Emoji",
      icon: { kind: "emoji", value: "😀" },
      keywords: ["emoji", "emoticon", "symbols", "smiley", "picker", "character"],
      feature: "emoji",
      data: { action: "picker" },
    },
  ],
  dynamicItems(query): ScoredItem[] {
    const q = query.trim();
    if (!q.startsWith(":") || q.length < 3 || /\s/.test(q)) return [];
    return searchEmoji(q, undefined, 5).map((e, i) => {
      const shown = withTone(e, skinTone());
      return {
        item: {
          id: `emoji:char:${e.char}`,
          kind: "command",
          kindLabel: "Emoji",
          title: e.name.replace(/^./, (c) => c.toUpperCase()),
          subtitle: `:${e.name.replace(/\s+/g, "_")}:`,
          icon: { kind: "emoji", value: shown },
          keywords: [q, ...e.keywords],
          feature: "emoji",
          data: { action: "char", char: e.char, noUsage: true },
        },
        score: 100 - i,
        matchScore: 100 - i,
        matchKind: "keyword",
        frecency: 0,
        ranges: [],
      };
    });
  },
  actions(item) {
    if (item.data?.action === "char")
      return [
        { id: "paste", title: "Paste Emoji", shortcut: "⏎" },
        { id: "copy", title: "Copy Emoji", shortcut: "⌘⏎" },
      ];
    return [{ id: "open", title: "Open Emoji Picker", shortcut: "⏎" }];
  },
  async runAction(scored, actionId) {
    const char = typeof scored.item.data?.char === "string" ? scored.item.data.char : undefined;
    if (actionId === "open") return { ok: true, view: { id: "emoji.picker", props: { query: scored.argument ?? "" } } };
    if (!char) return { ok: false, error: "No emoji" };
    if (actionId === "paste") return paste(char);
    if (actionId === "copy") return copy(char);
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    state: () => ({ ...usageSections(usage), skinTone: skinTone() }),
    paste: (base: unknown) => (typeof base === "string" ? paste(base) : { ok: false, error: "Invalid emoji" }),
    copy: (base: unknown) => (typeof base === "string" ? copy(base) : { ok: false, error: "Invalid emoji" }),
    setSkinTone: (tone: unknown) => {
      if (typeof tone === "number" && tone >= 0 && tone <= 5) ctx?.setSettings({ skinTone: tone });
      return skinTone();
    },
    clearUsage: () => {
      usage = {};
      saveUsage();
      return usageSections(usage);
    },
  },
};
