/** Copy / paste helpers shared by the conversion, color and timer features. */
import { clipboard } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import { sleep } from "../../util/exec";
import { pasteFromClipboard } from "../../workflows/runtime";
import type { FeatureContext } from "../types";

export function copyText(text: string, what = "Copied"): ExecuteResult {
  clipboard.writeText(text);
  return { ok: true, hide: true, message: `${what}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` };
}

/** Put text on the clipboard, hide Glide and ⌘V into the app underneath. */
export async function pasteText(ctx: FeatureContext | undefined, text: string): Promise<ExecuteResult> {
  clipboard.writeText(text);
  ctx?.hideLauncher();
  await sleep(150);
  try {
    await pasteFromClipboard();
    return { ok: true, hide: true, message: "Pasted" };
  } catch (err) {
    return { ok: true, hide: true, message: `Copied to clipboard — ${err instanceof Error ? err.message : String(err)}` };
  }
}
