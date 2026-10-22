/**
 * Live snippet expansion, main side: the helper's tap matched a keyword and emitted snippet.matched;
 * render the snippet now ({clipboard}, {time}, {selection}, {uuid} are live, {cursor} becomes ← presses,
 * rich text keeps its HTML) and answer with snippet.render before the helper's 300 ms fallback.
 * No Electron imports, so it is unit-tested with a fake helper.
 */
import { randomUUID } from "node:crypto";
import type { Snippet } from "@shared/types";
import type { HelperEvents, NativeHelper } from "../native/helper";
import { usesPlaceholder } from "../quicklinks/placeholders";
import { expansionPlan, type SnippetSettings } from "./expansion";
import { sanitizeHtml } from "./render";

export interface LiveRenderDeps {
  helper: Pick<NativeHelper, "on" | "call">;
  snippets(): Snippet[];
  settings(): SnippetSettings;
  readClipboard(): Promise<string>;
  /** Selected text in the frontmost app (only read when the snippet uses {selection}). */
  readSelection(): Promise<string>;
  now?(): Date;
  uuid?(): string;
  log?(...args: unknown[]): void;
}

/** The helper gives up after 300 ms; reads that take longer than this are dropped (rendered as ""). */
const READ_BUDGET_MS = 150;

const withBudget = (p: Promise<string>): Promise<string> =>
  Promise.race([p.catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), READ_BUDGET_MS).unref?.())]);

export interface RenderReply {
  reqId: number;
  text?: string;
  html?: string;
  cursorLeft?: number;
}

/** Build the snippet.render params for one match (no text = let the helper paste its fallback). */
export async function renderReply(m: HelperEvents["snippet.matched"], deps: LiveRenderDeps): Promise<RenderReply> {
  const all = deps.snippets();
  const snippet = all.find((s) => s.id === m.id);
  if (!snippet) return { reqId: m.reqId };
  const src = `${snippet.text}\n${snippet.html ?? ""}`;
  const [clipboard, selection] = await Promise.all([
    usesPlaceholder(src, "clipboard") ? withBudget(deps.readClipboard()) : Promise.resolve(""),
    usesPlaceholder(src, "selection") ? withBudget(deps.readSelection()) : Promise.resolve(""),
  ]);
  const plan = expansionPlan(m.keyword, snippet, all, deps.settings(), { now: deps.now?.() ?? new Date(), clipboard, selection, uuid: deps.uuid ?? randomUUID });
  return { reqId: m.reqId, text: plan.text, ...(plan.html ? { html: sanitizeHtml(plan.html) } : {}), cursorLeft: plan.cursorLeft };
}

/** Subscribe to snippet.matched; returns the unsubscribe function. */
export function attachLiveRender(deps: LiveRenderDeps): () => void {
  return deps.helper.on("snippet.matched", (m) => {
    void renderReply(m, deps)
      .catch((err: unknown) => {
        deps.log?.("snippet render failed:", err);
        return { reqId: m.reqId };
      })
      .then((reply) => deps.helper.call("snippet.render", reply))
      .catch((err: unknown) => deps.log?.("snippet.render failed:", err));
  });
}
