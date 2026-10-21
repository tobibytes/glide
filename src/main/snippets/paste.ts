/** Rendering a snippet for the launcher's Paste/Copy actions and putting it on the clipboard. */
import { randomUUID } from "node:crypto";
import { clipboard, ClipboardItem } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { Snippet } from "@shared/types";
import { HEADLESS } from "../headless";
import type { NativeHelper } from "../native/helper";
import { sleep, osascript } from "../util/exec";
import { pasteFromClipboard } from "../workflows/runtime";
import { renderSnippet, sanitizeHtml, snippetLookup, type RenderedSnippet } from "./render";
import { usesPlaceholder } from "../quicklinks/placeholders";

let helper: NativeHelper | null = null;
export function setSnippetHelper(h: NativeHelper | null): void {
  helper = h;
}

const headlessLog = (kind: string, detail: unknown) => {
  (globalThis as { __glideHeadlessLog?: Array<{ at: number; kind: string; detail: unknown }> }).__glideHeadlessLog?.push({ at: Date.now(), kind, detail });
  console.log(`[headless] ${kind} ${JSON.stringify(detail)}`);
};

async function selection(): Promise<string> {
  if (!helper?.available()) return "";
  try {
    return (await helper.call("selection.text")).text ?? "";
  } catch {
    return "";
  }
}

/** Render with the live clipboard/selection (read before Glide writes anything) and nested snippets. */
export async function renderForUse(snippet: Snippet, all: Snippet[]): Promise<RenderedSnippet> {
  const src = `${snippet.text}\n${snippet.html ?? ""}`;
  const [clip, sel] = await Promise.all([usesPlaceholder(src, "clipboard") ? clipboard.readText().catch(() => "") : "", usesPlaceholder(src, "selection") ? selection() : ""]);
  const r = renderSnippet(snippet, { now: new Date(), clipboard: clip, selection: sel, uuid: randomUUID, snippet: snippetLookup(all) });
  return r.html ? { ...r, html: sanitizeHtml(r.html) } : r;
}

export async function writeRendered(r: RenderedSnippet): Promise<void> {
  if (r.html) await clipboard.write([new ClipboardItem({ "text/plain": r.text, "text/html": r.html })]);
  else await clipboard.writeText(r.text);
}

export async function copySnippet(snippet: Snippet, all: Snippet[]): Promise<ExecuteResult> {
  await writeRendered(await renderForUse(snippet, all));
  return { ok: true, hide: true, message: "Snippet copied" };
}

/** Paste into the frontmost app, then press ← cursorLeft times so the caret lands on {cursor}. */
export async function pasteSnippet(snippet: Snippet, all: Snippet[], hideLauncher: () => void): Promise<ExecuteResult> {
  const r = await renderForUse(snippet, all);
  await writeRendered(r);
  hideLauncher();
  await sleep(150);
  if (HEADLESS) {
    headlessLog("snippet.paste", { name: snippet.name, text: r.text, html: !!r.html, cursorLeft: r.cursorLeft });
    return { ok: true, hide: true, message: "Pasted" };
  }
  try {
    await pasteFromClipboard();
    if (r.cursorLeft > 0) {
      await sleep(80);
      await osascript(`tell application "System Events"\nrepeat ${Math.min(r.cursorLeft, 2000)} times\nkey code 123\nend repeat\nend tell`);
    }
    return { ok: true, hide: true, message: "Pasted" };
  } catch (err) {
    return { ok: true, hide: true, message: `Copied to clipboard — ${err instanceof Error ? err.message : String(err)}` };
  }
}
