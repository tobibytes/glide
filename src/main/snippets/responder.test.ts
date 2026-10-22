import { describe, expect, it } from "vitest";
import type { Snippet } from "@shared/types";
import type { HelperEvents, HelperMethods } from "../native/helper";
import { SNIPPET_DEFAULTS } from "./expansion";
import { liveExpansionList, needsLiveRender, setExpansionInputs } from "./live";
import { attachLiveRender, renderReply, type LiveRenderDeps } from "./responder";

type Listener = (data: unknown) => void;

/** Fake helper: records calls, lets the test emit events. */
function fakeHelper() {
  const listeners = new Map<string, Listener[]>();
  const calls: Array<{ method: string; params: unknown }> = [];
  let resolveCall: (() => void) | null = null;
  const helper = {
    on<E extends keyof HelperEvents>(event: E, cb: (d: HelperEvents[E]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb as Listener);
      listeners.set(event, list);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== cb));
    },
    call(method: keyof HelperMethods, params?: unknown) {
      calls.push({ method, params });
      resolveCall?.();
      return Promise.resolve({ ok: true, applied: true });
    },
  };
  return {
    helper: helper as unknown as LiveRenderDeps["helper"],
    calls,
    emit: (event: string, data: unknown) => (listeners.get(event) ?? []).forEach((l) => l(data)),
    nextCall: () => new Promise<void>((r) => (resolveCall = r)),
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  };
}

const sn = (id: string, text: string, extra: Partial<Snippet> = {}): Snippet => ({ id, name: id, text, ...extra });
const NOW = new Date(2026, 9, 22, 14, 5, 0);

function deps(snippets: Snippet[], over: Partial<LiveRenderDeps> = {}): LiveRenderDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    helper: fakeHelper().helper,
    snippets: () => snippets,
    settings: () => ({ ...SNIPPET_DEFAULTS, caseAdaptive: true }),
    readClipboard: async () => (reads.push("clipboard"), "copied text"),
    readSelection: async () => (reads.push("selection"), "picked"),
    now: () => NOW,
    uuid: () => "uuid-1",
    reads,
    ...over,
  };
}

describe("live snippet render (snippet.matched → snippet.render)", () => {
  it("renders clipboard, selection and uuid at expansion time and places the cursor", async () => {
    const s = sn("a", "Re: {clipboard} / {selection} {uuid}{cursor}!!");
    const d = deps([s]);
    const r = await renderReply({ reqId: 7, keyword: ";re", id: "a", bundleId: "com.apple.TextEdit" }, d);
    expect(r).toEqual({ reqId: 7, text: "Re: copied text / picked uuid-1!!", cursorLeft: 2 });
    expect(d.reads.sort()).toEqual(["clipboard", "selection"]);
  });

  it("only reads the clipboard / selection when the snippet uses them", async () => {
    const d = deps([sn("a", "plain {cursor}x")]);
    expect(await renderReply({ reqId: 1, keyword: ";p", id: "a", bundleId: null }, d)).toEqual({ reqId: 1, text: "plain x", cursorLeft: 1 });
    expect(d.reads).toEqual([]);
  });

  it("adapts case to the typed variant and keeps (sanitised) rich text", async () => {
    const s = sn("h", "hello there", { html: '<b onclick="x()">hello</b> there' });
    const r = await renderReply({ reqId: 2, keyword: ";HI", id: "h", bundleId: null }, deps([s]));
    expect(r.text).toBe("HELLO THERE");
    expect(r.html).toBe("<b>hello</b> there");
  });

  it("answers without text for an unknown id (helper pastes its fallback)", async () => {
    expect(await renderReply({ reqId: 3, keyword: ";x", id: "gone", bundleId: null }, deps([]))).toEqual({ reqId: 3 });
  });

  it("a slow clipboard read is dropped after the budget instead of missing the helper's 300 ms window", async () => {
    const d = deps([sn("a", "[{clipboard}]")], { readClipboard: () => new Promise((r) => setTimeout(() => r("late"), 1000)) });
    const t = Date.now();
    const r = await renderReply({ reqId: 4, keyword: ";c", id: "a", bundleId: null }, d);
    expect(r.text).toBe("[]");
    expect(Date.now() - t).toBeLessThan(290);
  });

  it("attachLiveRender replies to the helper via snippet.render and unsubscribes", async () => {
    const f = fakeHelper();
    const off = attachLiveRender({ ...deps([sn("a", "Dated {date format=\"yyyy\"}")]), helper: f.helper });
    const done = f.nextCall();
    f.emit("snippet.matched", { reqId: 9, keyword: ";d", id: "a", bundleId: null });
    await done;
    expect(f.calls).toEqual([{ method: "snippet.render", params: { reqId: 9, text: "Dated 2026", cursorLeft: 0 } }]);
    off();
    expect(f.listenerCount("snippet.matched")).toBe(0);
  });
});

describe("keys.configure snippet list", () => {
  it("marks only snippets that need a live render with their id, and ships exclusions to the tap", () => {
    setExpansionInputs({ settings: { ...SNIPPET_DEFAULTS, keywordPrefix: ";", excludedApps: ["com.apple.Terminal"] } });
    const list = liveExpansionList([
      sn("plain", "Best, Olu", { keyword: "sig" }),
      sn("dyn", "{clipboard}", { keyword: "cb" }),
      sn("cur", "a{cursor}b", { keyword: "cur", excludedApps: ["com.microsoft.VSCode"] }),
      sn("rich", "bold", { keyword: "b", html: "<b>bold</b>" }),
    ]);
    expect(list).toEqual([
      { keyword: ";sig", text: "Best, Olu" },
      { keyword: ";cur", text: "ab", id: "cur", excludedBundleIds: ["com.microsoft.VSCode"] },
      { keyword: ";cb", text: "", id: "dyn" },
      { keyword: ";b", text: "bold", id: "rich" },
    ]);
    setExpansionInputs({ settings: SNIPPET_DEFAULTS });
  });

  it("needsLiveRender", () => {
    expect(needsLiveRender(sn("a", "static"))).toBe(false);
    expect(needsLiveRender(sn("a", "{time}"))).toBe(true);
    expect(needsLiveRender(sn("a", "x{cursor}"))).toBe(true);
    expect(needsLiveRender(sn("a", "x", { html: "<i>x</i>" }))).toBe(true);
  });
});
