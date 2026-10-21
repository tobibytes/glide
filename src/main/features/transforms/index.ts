/**
 * Text Transforms: "Transform Text" (a launcher view previewing every transform of the selected
 * text, else the clipboard) plus one root-search command per transform ("uppercase", "json pretty").
 * The transforms are pure (./transforms.ts) so the view previews them in the renderer.
 */
import { clipboard } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import { hud } from "../app/hud";
import { pasteText as clipboardPaste } from "../convert/output";
import type { FeatureContext, FeatureModule } from "../types";
import { applyTransform, TRANSFORMS, transformById } from "./transforms";

const SELECTION_TIMEOUT_MS = 1200;

export interface TransformInput {
  text: string;
  source: "selection" | "clipboard" | "none";
}

let ctx: FeatureContext | undefined;

/** Selected text in the app behind Glide (Accessibility via the helper), else the clipboard. */
async function readInput(): Promise<TransformInput> {
  if (ctx?.helper.available()) {
    try {
      const timeout = new Promise<{ text: null }>((resolve) => setTimeout(() => resolve({ text: null }), SELECTION_TIMEOUT_MS));
      const res = await Promise.race([ctx.helper.call("selection.text"), timeout]);
      if (res.text && res.text.trim()) return { text: res.text, source: "selection" };
    } catch {
      /* helper failed: fall back to the clipboard */
    }
  }
  const clip = await clipboard.readText();
  return clip ? { text: clip, source: "clipboard" } : { text: "", source: "none" };
}

/** Type the result into the app behind Glide: the helper's paste when available, else clipboard + ⌘V. */
async function paste(text: unknown): Promise<ExecuteResult> {
  if (typeof text !== "string" || !text) return { ok: false, error: "Nothing to paste" };
  if (ctx?.helper.available()) {
    ctx.hideLauncher();
    await new Promise((r) => setTimeout(r, 120)); // let the previous app regain focus
    try {
      const res = await ctx.helper.call("keys.paste", { text });
      if (res.ok) return { ok: true, hide: true, message: "Pasted" };
    } catch {
      /* fall back below */
    }
  }
  return clipboardPaste(ctx, text);
}

function copy(text: unknown): ExecuteResult {
  if (typeof text !== "string" || !text) return { ok: false, error: "Nothing to copy" };
  clipboard.writeText(text);
  hud("Copied to Clipboard");
  return { ok: true, hide: true, message: "Copied" };
}

async function runOne(id: string, verb: "paste" | "copy"): Promise<ExecuteResult> {
  const t = transformById(id);
  if (!t) return { ok: false, error: `Unknown transform ${id}` };
  const input = t.usesInput ? await readInput() : { text: "", source: "none" as const };
  const res = applyTransform(id, input.text);
  if (!res.ok) return { ok: false, error: res.error };
  return verb === "paste" ? paste(res.output) : copy(res.output);
}

export const feature: FeatureModule = {
  id: "transforms",
  start(c) {
    ctx = c;
  },
  items: (): SearchItem[] => [
    {
      id: "transforms:open",
      kind: "command",
      kindLabel: "Transform",
      title: "Transform Text",
      subtitle: "Selection or clipboard → case, JSON, Base64, hashes…",
      icon: { kind: "emoji", value: "🔀" },
      keywords: ["transform", "convert text", "case", "encode", "decode", "format", "text tools"],
      feature: "transforms",
      data: { action: "open" },
    },
    ...TRANSFORMS.map(
      (t): SearchItem => ({
        id: `transforms:${t.id}`,
        kind: "command",
        kindLabel: "Transform",
        title: t.title,
        subtitle: t.usesInput ? "Transform selection or clipboard" : "Text transform",
        icon: { kind: "emoji", value: "🔀" },
        keywords: [...t.keywords, "transform", t.category.toLowerCase()],
        feature: "transforms",
        data: { action: "one", transform: t.id },
      }),
    ),
  ],
  actions(item): ItemAction[] {
    if (item.data?.action === "open") return [{ id: "open", title: "Transform Text", shortcut: "⏎" }];
    if (item.data?.action === "one")
      return [
        { id: "preview", title: "Preview Transform", shortcut: "⏎", icon: "👁" },
        { id: "paste", title: "Paste Result", shortcut: "⌘⏎", icon: "📥" },
        { id: "copy", title: "Copy Result", shortcut: "⇧⌘C", icon: "📋" },
      ];
    return [];
  },
  async runAction(scored, actionId) {
    const id = typeof scored.item.data?.transform === "string" ? scored.item.data.transform : "";
    if (actionId === "open") return { ok: true, view: { id: "transforms.transform", props: { title: "Transform Text" } } };
    if (actionId === "preview") return { ok: true, view: { id: "transforms.transform", props: { title: "Transform Text", transform: id } } };
    if (actionId === "paste" || actionId === "copy") return runOne(id, actionId);
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    input: () => readInput(),
    clipboard: async (): Promise<TransformInput> => {
      const text = await clipboard.readText();
      return { text, source: text ? "clipboard" : "none" };
    },
    paste: (text) => paste(text),
    copy: (text) => copy(text),
  },
};
