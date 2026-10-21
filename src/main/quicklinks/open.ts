/** Opening quicklinks: argument values, placeholders, encoding and "open with" an app. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { clipboard, shell } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { Quicklink, ScoredItem } from "@shared/types";
import { HEADLESS } from "../headless";
import type { NativeHelper } from "../native/helper";
import { argumentValues, buildQuicklinkUrl, invalidOptions, missingArguments, needsClipboard, needsSelection, quicklinkArguments } from "./core";

let helper: NativeHelper | null = null;
export function setQuicklinkHelper(h: NativeHelper | null): void {
  helper = h;
}

async function readSelection(): Promise<string> {
  if (!helper?.available()) return "";
  try {
    return (await helper.call("selection.text")).text ?? "";
  } catch {
    return ""; // blocked in headless mode / no Accessibility
  }
}

/** Build the final URL for a quicklink template and the launcher's argument values. */
export async function resolveQuicklinkUrl(url: string, scored: Pick<ScoredItem, "argument" | "arguments">): Promise<{ url: string } | { error: string }> {
  const defs = quicklinkArguments(url);
  const values = argumentValues(defs, scored.arguments, scored.argument);
  // Legacy `{query}`-only links open with an empty query, like before; named arguments must be filled.
  const legacy = defs.length === 1 && defs[0]!.name === "query";
  const missing = legacy ? [] : missingArguments(defs, values);
  if (missing.length) return { error: `Fill in ${missing.map((d) => `“${d.placeholder}”`).join(", ")} — Tab moves between arguments` };
  const bad = invalidOptions(defs, values);
  if (bad.length) return { error: `“${values[bad[0]!.name]}” is not one of ${bad[0]!.options!.join(", ")}` };
  const [clip, selection] = await Promise.all([needsClipboard(url) ? clipboard.readText().catch(() => "") : "", needsSelection(url) ? readSelection() : ""]);
  return { url: buildQuicklinkUrl(url, { now: new Date(), clipboard: clip, selection, uuid: randomUUID, arguments: values }) };
}

const BUNDLE_ID = /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i;

/** `open -a <app> <url>` (or `-b <bundle id>`): the same launch path apps use, with the URL as the document. */
export function openWithApp(app: string, url: string): Promise<ExecuteResult> {
  const flag = !app.includes("/") && BUNDLE_ID.test(app) ? "-b" : "-a";
  if (HEADLESS) {
    // Headless runs never launch apps; record the launch like headless.ts records openExternal.
    const detail = { app, flag, url };
    (globalThis as { __glideHeadlessLog?: Array<{ at: number; kind: string; detail: unknown }> }).__glideHeadlessLog?.push({ at: Date.now(), kind: "quicklink.openWith", detail });
    console.log(`[headless] quicklink.openWith ${JSON.stringify(detail)}`);
    return Promise.resolve({ ok: true, hide: true });
  }
  return new Promise((resolve) =>
    execFile("/usr/bin/open", [flag, app, url], { timeout: 15_000 }, (err) =>
      resolve(err ? { ok: false, error: `Could not open with ${app.split("/").pop()?.replace(/\.app$/, "") ?? app}` } : { ok: true, hide: true }),
    ),
  );
}

export async function openQuicklink(q: Pick<Quicklink, "url" | "openWith">, scored: Pick<ScoredItem, "argument" | "arguments">): Promise<ExecuteResult> {
  const r = await resolveQuicklinkUrl(q.url, scored);
  if ("error" in r) return { ok: false, error: r.error };
  if (!r.url) return { ok: false, error: "The quicklink produced an empty URL" };
  if (q.openWith?.trim()) return openWithApp(q.openWith.trim(), r.url);
  await shell.openExternal(r.url);
  return { ok: true, hide: true };
}
