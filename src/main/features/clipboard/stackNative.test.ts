import { describe, expect, it } from "vitest";
import type { HelperEvents, HelperMethods } from "../../native/helper";
import { addToStack, EMPTY_STACK, interceptsPaste, restoreHead, takeNext } from "./stack";
import { attachStackPaste, stackReplyParams, type StackNext } from "./stackNative";

function fakeHelper(applied = true) {
  let listener: ((d: HelperEvents["stack.next"]) => void) | null = null;
  const calls: Array<{ method: string; params: unknown }> = [];
  let resolveCall: (() => void) | null = null;
  const helper = {
    on: (_e: "stack.next", cb: (d: HelperEvents["stack.next"]) => void) => ((listener = cb), () => (listener = null)),
    call: (method: keyof HelperMethods, params?: unknown) => {
      calls.push({ method, params });
      queueMicrotask(() => resolveCall?.());
      return Promise.resolve({ ok: true, applied });
    },
  };
  return {
    helper: helper as unknown as Parameters<typeof attachStackPaste>[0],
    calls,
    press: (reqId: number) => {
      const done = new Promise<void>((r) => (resolveCall = r));
      listener?.({ reqId });
      return done;
    },
    attached: () => listener !== null,
  };
}

describe("Paste Stack ⌘V (stack.next → stack.reply)", () => {
  it("intercepts ⌘V only while items are waiting", () => {
    expect(interceptsPaste(EMPTY_STACK)).toBe(false);
    expect(interceptsPaste(addToStack(EMPTY_STACK, "a"))).toBe(true);
  });

  it("replies with each item in order, then empty (which stops interception)", async () => {
    let stack = addToStack(addToStack(EMPTY_STACK, "a"), "b");
    const texts: Record<string, string> = { a: "first", b: "second" };
    const next = async (): Promise<StackNext> => {
      const r = takeNext(stack);
      stack = r.stack;
      if (!r.id) return { reply: { empty: true }, active: false };
      return { reply: { text: texts[r.id]! }, active: interceptsPaste(stack) };
    };
    const f = fakeHelper();
    const off = attachStackPaste(f.helper, next);
    await f.press(1);
    await f.press(2);
    await f.press(3);
    expect(f.calls).toEqual([
      { method: "stack.reply", params: { reqId: 1, text: "first", active: true } },
      { method: "stack.reply", params: { reqId: 2, text: "second", active: false } },
      { method: "stack.reply", params: { reqId: 3, empty: true, active: false } },
    ]);
    off();
    expect(f.attached()).toBe(false);
  });

  it("puts the item back when the helper's watchdog already let ⌘V through", async () => {
    let stack = addToStack(addToStack(EMPTY_STACK, "a"), "b");
    const f = fakeHelper(false);
    attachStackPaste(f.helper, async () => {
      const r = takeNext(stack);
      stack = r.stack;
      return { reply: { text: r.id! }, active: true, undo: () => (stack = restoreHead(stack, r.id!)) };
    });
    await f.press(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(stack.items).toEqual(["a", "b"]);
  });

  it("a failing lookup lets the original ⌘V through instead of blocking paste", async () => {
    const f = fakeHelper();
    attachStackPaste(f.helper, async () => {
      throw new Error("boom");
    });
    await f.press(5);
    expect(f.calls[0]).toEqual({ method: "stack.reply", params: { reqId: 5, passthrough: true, active: true } });
  });

  it("image/file entries go through the clipboard (passthrough) and empty always reports inactive", () => {
    expect(stackReplyParams(1, { reply: { passthrough: true }, active: true })).toEqual({ reqId: 1, passthrough: true, active: true });
    expect(stackReplyParams(2, { reply: { empty: true }, active: true })).toEqual({ reqId: 2, empty: true, active: false });
    expect(stackReplyParams(3, { reply: { text: "x", html: "<b>x</b>" }, active: false })).toEqual({ reqId: 3, text: "x", html: "<b>x</b>", active: false });
  });
});
