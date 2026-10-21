import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMiniReact } from "./react";
import { createRaycastSerializer } from "./serialize";
import { createRaycastApi } from "./api";
import { createRaycastUtils } from "./utils";
import { raycastRuntime } from "./runtime";
import type { ChildMessage, InitPayload, JsonValue, ParentMessage, ViewModel } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glide-rc-runtime-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const nodeRequire = createRequire(import.meta.url);

function setup(answers: Partial<Record<string, (params: JsonValue[]) => JsonValue>> = {}) {
  const sent: ChildMessage[] = [];
  let deliver: (m: ParentMessage) => void = () => undefined;
  const port = {
    send: (m: ChildMessage) => {
      sent.push(m);
      if (m.type === "request") {
        const fn = answers[m.method];
        queueMicrotask(() => deliver({ type: "response", id: m.id, result: fn ? fn(m.params) : null }));
      }
    },
    onMessage: (cb: (m: ParentMessage) => void) => (deliver = cb),
  };
  const rt = raycastRuntime(nodeRequire, port, { createMiniReact, createRaycastSerializer, createRaycastApi, createRaycastUtils });
  const R = rt.mr.React as any;
  const h = R.createElement;
  const api = rt.api as any;
  const settle = async (n = 4) => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 0));
      rt.mr.flush();
    }
  };
  const lastView = (depth = 0): ViewModel | undefined => [...sent].reverse().find((m): m is Extract<ChildMessage, { view: ViewModel }> => (m.type === "render" || m.type === "push") && m.depth === depth)?.view;
  const invoke = (depth: number, handler: string, args: JsonValue[] = []) => rt.handle({ type: "invoke", depth, handler, args });
  return { rt, R, h, api, sent, settle, lastView, invoke, deliver: (m: ParentMessage) => deliver(m) };
}

describe("Raycast runtime: serialisation", () => {
  it("serialises a List with sections, accessories, detail, dropdown and actions", async () => {
    const { rt, h, api, R, settle, lastView, invoke } = setup();
    const { List, ActionPanel, Action, Icon, Color } = api;
    let dropdownValue = "";
    function Cmd() {
      const [q, setQ] = R.useState("");
      return h(
        List,
        {
          isShowingDetail: true,
          searchBarPlaceholder: "Search fruit",
          onSearchTextChange: setQ,
          searchBarAccessory: h(List.Dropdown, { tooltip: "Kind", onChange: (v: string) => (dropdownValue = v) }, h(List.Dropdown.Item, { title: "All", value: "all" }), h(List.Dropdown.Section, { title: "More" }, h(List.Dropdown.Item, { title: "Red", value: "red" }))),
        },
        h(
          List.Section,
          { title: `Fruit ${q}` },
          h(List.Item, {
            id: "apple",
            title: "Apple",
            subtitle: "red",
            icon: Icon.Star,
            keywords: ["pome"],
            accessories: [{ text: { value: "5", color: Color.Red } }, { tag: "new" }, { date: new Date(Date.now() - 2 * 3600_000) }],
            detail: h(List.Item.Detail, { markdown: "# Apple", metadata: h(List.Item.Detail.Metadata, null, h(List.Item.Detail.Metadata.Label, { title: "Kind", text: "Fruit" }), h(List.Item.Detail.Metadata.TagList, { title: "Tags" }, h(List.Item.Detail.Metadata.TagList.Item, { text: "sweet", color: Color.Green }))) }),
            actions: h(
              ActionPanel,
              null,
              h(Action.CopyToClipboard, { content: "apple", shortcut: { modifiers: ["cmd", "shift"], key: "c" } }),
              h(ActionPanel.Section, { title: "More" }, h(Action, { title: "Eat", icon: Icon.Trash, style: Action.Style.Destructive, onAction: () => undefined })),
            ),
          }),
        ),
        h(List.Item, { title: "Loose" }),
      );
    }
    rt.renderRoot(h(Cmd));
    await settle();
    const view = lastView();
    expect(view?.type).toBe("list");
    if (view?.type !== "list") return;
    expect(view.searchPlaceholder).toBe("Search fruit");
    expect(view.filtering).toBe(false);
    expect(view.showDetail).toBe(true);
    expect(view.dropdown?.options.map((o) => [o.value, o.section])).toEqual([["all", undefined], ["red", "More"]]);
    expect(view.dropdown?.value).toBe("all");
    expect(dropdownValue).toBe("all"); // Raycast calls onChange with the initial value
    const [apple, loose] = view.items;
    expect(apple).toMatchObject({ id: "apple", title: "Apple", subtitle: "red", icon: "⭐", section: "Fruit ", keywords: ["pome"] });
    expect(apple.accessories[0]).toEqual({ text: "5", color: "#EF4444" });
    expect(apple.accessories[1]).toEqual({ tag: "new" });
    expect(apple.accessories[2].text).toBe("2h");
    expect(apple.detail?.markdown).toBe("# Apple");
    expect(apple.detail?.metadata?.[1]).toMatchObject({ kind: "tags", label: "Tags", tags: [{ text: "sweet", color: "#22C55E" }] });
    expect(apple.actions.map((a) => [a.kind, a.title, a.shortcut, a.section, a.destructive])).toEqual([
      ["copy", "Copy to Clipboard", "⇧⌘C", undefined, undefined],
      ["run", "Eat", undefined, "More", true],
    ]);
    expect(loose.section).toBeUndefined();
    // search text flows back into state
    invoke(0, view.searchHandler!, ["ki"]);
    await settle();
    const v2 = lastView();
    expect(v2?.type === "list" && v2.items[0].section).toBe("Fruit ki");
    expect(JSON.parse(JSON.stringify(v2))).toEqual(v2);
  });

  it("pushes and pops views with useNavigation and Action.Push", async () => {
    const { rt, h, api, settle, sent, lastView, invoke } = setup();
    const { Detail, List, ActionPanel, Action, useNavigation } = api;
    function Second() {
      const { pop } = useNavigation();
      return h(Detail, { markdown: "second", actions: h(ActionPanel, null, h(Action, { title: "Back", onAction: pop })) });
    }
    function First() {
      return h(List, null, h(List.Item, { title: "Go", actions: h(ActionPanel, null, h(Action.Push, { title: "Open", target: h(Second) })) }));
    }
    rt.renderRoot(h(First));
    await settle();
    const v = lastView();
    const push = v?.type === "list" ? v.items[0].actions[0] : undefined;
    expect(push).toMatchObject({ kind: "push", title: "Open" });
    invoke(0, push!.handler!);
    await settle();
    const pushed = sent.find((m) => m.type === "push");
    expect(pushed).toMatchObject({ type: "push", depth: 1, view: { type: "detail", markdown: "second" } });
    const back = lastView(1);
    invoke(1, back?.type === "detail" ? back.actions[0].handler! : "");
    await settle();
    expect(sent.some((m) => m.type === "pop" && m.depth === 1)).toBe(true);
  });

  it("serialises a Form and decodes submitted values by field type", async () => {
    const { rt, h, api, settle, lastView, invoke } = setup();
    const { Form, ActionPanel, Action } = api;
    let submitted: Record<string, unknown> | null = null;
    let changed: unknown = null;
    rt.renderRoot(
      h(
        Form,
        { actions: h(ActionPanel, null, h(Action.SubmitForm, { title: "Save", onSubmit: (v: Record<string, unknown>) => (submitted = v) })) },
        h(Form.TextField, { id: "name", title: "Name", placeholder: "Your name", error: "Required", onChange: (v: string) => (changed = v) }),
        h(Form.Checkbox, { id: "ok", label: "Agree", defaultValue: true }),
        h(Form.DatePicker, { id: "when", title: "When", type: Form.DatePicker.Type.Date }),
        h(Form.Dropdown, { id: "lang", title: "Lang", defaultValue: "ts" }, h(Form.Dropdown.Item, { value: "js", title: "JS" }), h(Form.Dropdown.Item, { value: "ts", title: "TS" })),
        h(Form.TagPicker, { id: "tags", title: "Tags" }, h(Form.TagPicker.Item, { value: "a", title: "A" })),
        h(Form.Separator),
        h(Form.Description, { title: "Note", text: "Hello" }),
      ),
    );
    await settle();
    const v = lastView();
    expect(v?.type).toBe("form");
    if (v?.type !== "form") return;
    expect(v.fields.map((f) => [f.id, f.type])).toEqual([
      ["name", "text"],
      ["ok", "checkbox"],
      ["when", "date"],
      ["lang", "dropdown"],
      ["tags", "tags"],
      ["separator-1", "separator"],
      ["description-2", "description"],
    ]);
    expect(v.fields[0]).toMatchObject({ placeholder: "Your name", error: "Required" });
    expect(v.fields[1]).toMatchObject({ placeholder: "Agree", default: true });
    expect(v.submitTitle).toBe("Save");
    invoke(0, v.fields[0].changeHandler!, ["Ada"]);
    invoke(0, v.actions![0].handler!, [{ name: "Ada", ok: false, when: "2026-01-02T00:00:00.000Z", lang: "js", tags: ["a"] }]);
    await settle();
    expect(changed).toBe("Ada");
    expect(submitted).toMatchObject({ name: "Ada", ok: false, lang: "js", tags: ["a"] });
    expect((submitted as unknown as { when: Date }).when).toBeInstanceOf(Date);
  });

  it("serialises Grid and Detail with metadata", async () => {
    const { rt, h, api, settle, lastView } = setup();
    const { Grid, Detail } = api;
    rt.renderRoot(h(Grid, { columns: 4, inset: Grid.Inset.Small }, h(Grid.Section, { title: "Colors" }, h(Grid.Item, { id: "r", title: "Red", content: { color: "#ff0000" } }), h(Grid.Item, { title: "Pic", content: "https://example.com/a.png" }))));
    await settle();
    const g = lastView();
    expect(g).toMatchObject({ type: "grid", columns: 4, inset: "sm", items: [{ id: "r", content: "#ff0000", section: "Colors" }, { content: "https://example.com/a.png" }] });
    const d = setup();
    d.rt.renderRoot(d.h(Detail, { markdown: "# Hi", navigationTitle: "T", metadata: d.h(Detail.Metadata, null, d.h(Detail.Metadata.Link, { title: "Site", text: "x", target: "https://x.dev" }), d.h(Detail.Metadata.Separator)) }));
    await d.settle();
    expect(d.lastView()).toMatchObject({ type: "detail", markdown: "# Hi", title: "T", metadata: [{ kind: "link", link: "https://x.dev" }, { kind: "separator" }] });
  });

  it("renders an error view when a component throws", async () => {
    const { rt, h, settle, lastView } = setup();
    rt.renderRoot(
      h(() => {
        throw new Error("kaboom");
      }),
    );
    await settle();
    expect(lastView()).toMatchObject({ type: "detail", title: "Extension error" });
    expect((lastView() as { markdown: string }).markdown).toMatch(/kaboom/);
  });
});

describe("Raycast runtime: API shims", () => {
  it("shows and updates toasts, uses LocalStorage and preferences", async () => {
    const store: Record<string, JsonValue> = {};
    const { api, sent, deliver } = setup({
      "storage.set": (p) => {
        store[String(p[0])] = p[1];
        return null;
      },
      "storage.get": (p) => store[String(p[0])] ?? null,
    });
    deliver({ type: "init", init: initPayload({ preferences: { token: "abc", flag: true } }) });
    const toast = await api.showToast({ style: api.Toast.Style.Animated, title: "Loading" });
    toast.style = api.Toast.Style.Success;
    toast.title = "Done";
    await new Promise((r) => setTimeout(r, 5));
    const toasts = sent.filter((m) => m.type === "request" && m.method === "showToast").map((m) => (m as { params: JsonValue[] }).params);
    expect(toasts[0]).toEqual(["animated", "Loading", null, toast.id, []]);
    expect(toasts[toasts.length - 1]).toEqual(["success", "Done", null, toast.id, []]);
    await api.LocalStorage.setItem("k", "v");
    expect(await api.LocalStorage.getItem("k")).toBe("v");
    expect(await api.LocalStorage.getItem("missing")).toBeUndefined();
    expect(api.getPreferenceValues()).toEqual({ token: "abc", flag: true });
    expect(api.environment.extensionName).toBe("fixture");
  });

  it("Cache is synchronous and persists to the support directory", async () => {
    const { api, deliver } = setup();
    deliver({ type: "init", init: initPayload({}) });
    const c = new api.Cache({ namespace: "t" });
    c.set("a", "1");
    expect(c.get("a")).toBe("1");
    expect(new api.Cache({ namespace: "t" }).get("a")).toBe("1");
    expect(c.remove("a")).toBe(true);
    expect(c.has("a")).toBe(false);
  });

  it("maps Icon, Color and Image sources", () => {
    const { rt, api } = setup();
    const s = rt.ser;
    expect(s.toIconSource(api.Icon.Star)).toBe("⭐");
    expect(s.toIconSource(api.Icon.SomethingUnknown)).toBe("▫️");
    expect(s.toIconSource({ source: api.Icon.Circle, tintColor: api.Color.Green })).toBe("#22C55E");
    expect(s.toIconSource({ source: { light: "a.png", dark: "b.png" } })).toBe("b.png");
    expect(s.toIconSource({ fileIcon: "/Applications" })).toBe("file:///Applications");
    expect(s.shortcutDisplay(api.Keyboard.Shortcut.Common.Remove)).toBe("⌃X");
    expect(s.shortcutDisplay({ modifiers: ["cmd", "opt"], key: "return" })).toBe("⌥⌘⏎");
  });

  it("usePromise / useCachedState / useForm work through the mini runtime", async () => {
    const { h, R, api, rt, settle, lastView, invoke, deliver } = setup();
    deliver({ type: "init", init: initPayload({}) });
    const { usePromise, useCachedState, useForm, FormValidation } = rt.utils;
    let calls = 0;
    function Cmd() {
      const { data, isLoading } = usePromise(async (n: number) => {
        calls++;
        return n * 2;
      }, [21]);
      const [count] = useCachedState("count", 7);
      const { handleSubmit, itemProps } = useForm({ onSubmit: () => undefined, validation: { title: FormValidation.Required } });
      void R;
      return h(
        api.Form,
        { isLoading, navigationTitle: `${data ?? "…"}/${count}`, actions: h(api.ActionPanel, null, h(api.Action.SubmitForm, { onSubmit: handleSubmit })) },
        h(api.Form.TextField, { title: "Title", ...itemProps.title }),
      );
    }
    rt.renderRoot(h(Cmd));
    await settle(6);
    let v = lastView();
    expect(v).toMatchObject({ type: "form", title: "42/7", isLoading: false });
    expect(calls).toBe(1);
    invoke(0, (v as { actions: Array<{ handler: string }> }).actions[0].handler, [{ title: "" }]);
    await settle();
    v = lastView();
    expect((v as { fields: Array<{ error?: string }> }).fields[0].error).toBe("The item is required");
  });
});

function initPayload(over: Partial<InitPayload>): InitPayload {
  return {
    commandPath: "/nonexistent",
    apiPath: "",
    runtime: "raycast",
    arguments: {},
    preferences: {},
    environment: { extensionName: "fixture", extensionTitle: "Fixture", commandName: "cmd", commandMode: "view", assetsPath: tmp, extensionPath: tmp, supportPath: tmp, glideVersion: "0" },
    ...over,
  };
}

