/**
 * ⌘V-driven Paste Stack, main side. While the stack has items the helper's tap swallows a plain ⌘V
 * and emits stack.next {reqId}; we take the next item and answer with stack.reply within 500 ms:
 * text/html (the helper pastes it through a transient pasteboard write), passthrough (main already
 * put an image/file entry on the clipboard: let the original ⌘V through) or empty (stop intercepting).
 * No Electron imports, so it is unit-tested with a fake helper.
 */
import type { HelperMethods, NativeHelper } from "../../native/helper";

export type StackReplyBody = { text: string; html?: string } | { passthrough: true } | { empty: true };

export interface StackNext {
  reply: StackReplyBody;
  /** Items still waiting after this one (the tap keeps intercepting). */
  active: boolean;
  /** Put the item back when the helper had already given up (its watchdog let the original ⌘V through). */
  undo?(): void;
}

export function stackReplyParams(reqId: number, next: StackNext): HelperMethods["stack.reply"]["params"] {
  return { reqId, ...next.reply, active: "empty" in next.reply ? false : next.active };
}

export function attachStackPaste(helper: Pick<NativeHelper, "on" | "call">, next: () => Promise<StackNext>, log?: (...args: unknown[]) => void): () => void {
  return helper.on("stack.next", ({ reqId }) => {
    void (async () => {
      let taken: StackNext;
      try {
        taken = await next();
      } catch (err) {
        log?.("paste stack: could not take the next item:", err);
        taken = { reply: { passthrough: true }, active: true };
      }
      try {
        const r = await helper.call("stack.reply", stackReplyParams(reqId, taken));
        if (!r.applied) taken.undo?.();
      } catch (err) {
        log?.("stack.reply failed:", err);
        taken.undo?.();
      }
    })();
  });
}
