import { describe, expect, it } from "vitest";
import { glideRuntime, buildRunnerSource } from "./runtime";
import type { ChildMessage, ParentMessage, View } from "./types";
import { iconFor } from "./icons";

function fakeRuntime() {
  const sent: ChildMessage[] = [];
  let handler: (m: ParentMessage) => void = () => undefined;
  const rt = glideRuntime(() => ({}), { send: (m) => sent.push(m), onMessage: (cb) => (handler = cb) });
  return { rt, sent, deliver: (m: ParentMessage) => handler(m) };
}

describe("view-model serialisation", () => {
  it("replaces functions with handler ids and produces plain JSON", () => {
    const { rt } = fakeRuntime();
    const api = rt.api as { List: (p: unknown) => View; Action: Record<string, (...a: unknown[]) => unknown> };
    const view = api.List({
      searchPlaceholder: "Search…",
      onSearchTextChange: () => undefined,
      items: [
        { id: "a", title: "Alpha", subtitle: "first", icon: "🚀", keywords: ["one"], actions: [api.Action.CopyToClipboard("alpha"), api.Action.Run("Do it", () => undefined)] },
        { id: "a", title: "Alpha again", actions: [api.Action.OpenInBrowser("https://example.com", { title: "Open Site", shortcut: "⌘O" })] },
        { title: "Gamma", detail: { markdown: "# G", metadata: [{ label: "k", text: "v" }] }, actions: [api.Action.Push("More", () => api.List({ items: [] }))] },
      ],
    });
    const model = rt.serialize(view, 0);
    const json = JSON.parse(JSON.stringify(model));
    expect(json).toEqual(model);
    expect(model.type).toBe("list");
    if (model.type !== "list") return;
    expect(model.searchHandler).toMatch(/^h\d+$/);
    expect(model.items.map((i) => i.id)).toEqual(["a", "a~", "2"]);
    expect(model.items[0].actions.map((a) => [a.kind, a.title])).toEqual([
      ["copy", "Copy to Clipboard"],
      ["run", "Do it"],
    ]);
    expect(model.items[0].actions[0].text).toBe("alpha");
    expect(model.items[0].actions[1].handler).toMatch(/^h\d+$/);
    expect(model.items[1].actions[0]).toMatchObject({ kind: "openInBrowser", url: "https://example.com", title: "Open Site", shortcut: "⌘O" });
    expect(model.items[2].actions[0]).toMatchObject({ kind: "push", title: "More" });
    const ids = model.items.flatMap((i) => i.actions.map((a) => a.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serialises Detail and Form", () => {
    const { rt } = fakeRuntime();
    const api = rt.api as { Detail: (p: unknown) => View; Form: (p: unknown) => View };
    const d = rt.serialize(api.Detail({ markdown: "**hi**", metadata: [{ label: "A", text: 1 }] }), 0);
    expect(d).toEqual({ type: "detail", markdown: "**hi**", metadata: [{ label: "A", text: "1", link: undefined }], actions: [], isLoading: false });
    const f = rt.serialize(api.Form({ fields: [{ id: "n", title: "Name", type: "bogus", required: true }, { id: "c", title: "Check", type: "checkbox", default: true }], onSubmit: () => undefined }), 0);
    expect(f.type).toBe("form");
    if (f.type !== "form") return;
    expect(f.fields[0]).toMatchObject({ id: "n", type: "text", required: true });
    expect(f.fields[1]).toMatchObject({ type: "checkbox", default: true });
    expect(f.submitHandler).toMatch(/^h\d+$/);
  });

  it("rejects invalid views and actions", () => {
    const { rt } = fakeRuntime();
    expect(() => rt.serialize({ type: "grid" } as unknown as View, 0)).toThrow(/Unknown view type/);
    expect(() => rt.serialize({ type: "list", items: [{ title: "x", actions: [{ kind: "nope" }] }] } as unknown as View, 0)).toThrow(/Actions must be created/);
  });

  it("invokes handlers by id and drops stale ones after a re-render", async () => {
    const { rt, deliver } = fakeRuntime();
    const api = rt.api as { List: (p: unknown) => View; Action: Record<string, (...a: unknown[]) => unknown> };
    const calls: string[] = [];
    const first = rt.serialize(api.List({ items: [{ title: "x", actions: [api.Action.Run("A", () => void calls.push("first"))] }] }), 0);
    const h1 = first.type === "list" ? first.items[0].actions[0].handler! : "";
    deliver({ type: "invoke", depth: 0, handler: h1, args: [] });
    await new Promise((r) => setTimeout(r, 0));
    rt.serialize(api.List({ items: [{ title: "x", actions: [api.Action.Run("B", () => void calls.push("second"))] }] }), 0);
    deliver({ type: "invoke", depth: 0, handler: h1, args: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["first"]);
  });

  it("pushes a view from Action.Push", async () => {
    const { rt, sent, deliver } = fakeRuntime();
    const api = rt.api as { List: (p: unknown) => View; Detail: (p: unknown) => View; Action: Record<string, (...a: unknown[]) => unknown> };
    const m = rt.serialize(api.List({ items: [{ title: "x", actions: [api.Action.Push(() => api.Detail({ markdown: "pushed" }))] }] }), 0);
    const h = m.type === "list" ? m.items[0].actions[0].handler! : "";
    deliver({ type: "invoke", depth: 0, handler: h, args: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.at(-1)).toMatchObject({ type: "push", depth: 1, view: { type: "detail", markdown: "pushed" } });
  });
});

describe("icons", () => {
  it("maps icon sources", () => {
    expect(iconFor("🚀")).toEqual({ kind: "emoji", value: "🚀" });
    expect(iconFor("https://x.dev/a.png")).toEqual({ kind: "url", value: "https://x.dev/a.png" });
    expect(iconFor("#ff0000")).toEqual({ kind: "color", value: "#ff0000" });
    expect(iconFor("icon.png", "/ext/assets")).toEqual({ kind: "file", value: "/ext/assets/icon.png" });
    expect(iconFor("../../etc/x.png", "/ext/assets")).toBeUndefined();
  });
});

describe("runner source", () => {
  it("is valid standalone JavaScript", () => {
    const src = buildRunnerSource();
    expect(() => new Function("require", "process", src)).not.toThrow();
    expect(src).not.toMatch(/__vite|__vi_import/);
  });
});
