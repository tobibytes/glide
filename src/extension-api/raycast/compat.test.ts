/** Raycast compatibility gaps closed in the extension process: menu bar, submenus, drafts, field refs, toasts, AI, OAuth, system helpers. */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMiniReact } from "./react";
import { createRaycastSerializer } from "./serialize";
import { createRaycastApi } from "./api";
import { createRaycastUtils } from "./utils";
import { raycastRuntime } from "./runtime";
import type { ActionModel, ChildMessage, InitPayload, JsonValue, ParentMessage, ViewModel } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glide-rc-compat-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const nodeRequire = createRequire(import.meta.url);

type Answer = (params: JsonValue[], ctx: { id: number; stream(chunk: string): void }) => JsonValue | Promise<JsonValue>;

function setup(answers: Partial<Record<string, Answer>> = {}, init: Partial<InitPayload> = {}, supportPath = tmp) {
  const sent: ChildMessage[] = [];
  let deliver: (m: ParentMessage) => void = () => undefined;
  const port = {
    send: (m: ChildMessage) => {
      sent.push(m);
      if (m.type === "request") {
        const fn = answers[m.method];
        queueMicrotask(async () => {
          try {
            const result = fn ? await fn(m.params, { id: m.id, stream: (chunk) => deliver({ type: "stream", id: m.id, chunk }) }) : null;
            deliver({ type: "response", id: m.id, result });
          } catch (err) {
            deliver({ type: "response", id: m.id, error: (err as Error).message });
          }
        });
      }
    },
    onMessage: (cb: (m: ParentMessage) => void) => (deliver = cb),
  };
  const rt = raycastRuntime(nodeRequire, port, { createMiniReact, createRaycastSerializer, createRaycastApi, createRaycastUtils });
  deliver({
    type: "init",
    init: {
      commandPath: "/nonexistent",
      apiPath: "",
      runtime: "raycast",
      arguments: {},
      preferences: {},
      environment: { extensionName: "fixture", extensionTitle: "Fixture", commandName: "cmd", commandMode: "view", assetsPath: supportPath, extensionPath: supportPath, supportPath, glideVersion: "0" },
      ...init,
    },
  });
  const h = (rt.mr.React as any).createElement;
  const settle = async (n = 5) => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 0));
      rt.mr.flush();
    }
  };
  const lastView = (depth = 0): ViewModel | undefined => [...sent].reverse().find((m): m is Extract<ChildMessage, { view: ViewModel }> => (m.type === "render" || m.type === "push") && m.depth === depth)?.view;
  const requests = (method: string) => sent.filter((m) => m.type === "request" && m.method === method).map((m) => (m as { params: JsonValue[] }).params);
  const invoke = (depth: number, handler: string, args: JsonValue[] = []) => rt.handle({ type: "invoke", depth, handler, args });
  return { rt, api: rt.api as any, utils: rt.utils as any, R: rt.mr.React as any, h, sent, settle, lastView, requests, invoke };
}

describe("MenuBarExtra", () => {
  it("serialises items, sections, submenus, separators, shortcuts and isLoading", async () => {
    const { rt, api, h, settle, lastView, invoke } = setup({}, { environment: { extensionName: "fixture", extensionTitle: "F", commandName: "menu", commandMode: "menu-bar", assetsPath: tmp, extensionPath: tmp, supportPath: tmp, glideVersion: "0" } });
    const { MenuBarExtra, Icon } = api;
    let clicked: unknown = null;
    rt.renderRoot(
      h(
        MenuBarExtra,
        { title: "3", icon: Icon.Star, tooltip: "Tip", isLoading: true },
        h(MenuBarExtra.Section, { title: "Top" }, h(MenuBarExtra.Item, { title: "Run", shortcut: { modifiers: ["cmd"], key: "r" }, onAction: (e: unknown) => (clicked = e) }), h(MenuBarExtra.Item, { title: "Off" })),
        h(MenuBarExtra.Separator),
        h(MenuBarExtra.Submenu, { title: "More" }, h(MenuBarExtra.Item, { title: "Inner", subtitle: "sub", onAction: () => undefined })),
      ),
    );
    await settle();
    const v = lastView() as Extract<ViewModel, { type: "menubar" }>;
    expect(v).toMatchObject({ type: "menubar", title: "3", icon: "⭐", tooltip: "Tip", isLoading: true });
    expect(v.items.map((i) => i.kind)).toEqual(["section", "separator", "submenu"]);
    expect(v.items[0].children?.[0]).toMatchObject({ kind: "item", title: "Run", shortcut: "⌘R" });
    expect(v.items[0].children?.[1].handler).toBeUndefined();
    expect(v.items[2].children?.[0]).toMatchObject({ title: "Inner", subtitle: "sub" });
    invoke(0, v.items[0].children![0].handler!, [{ type: "left-click" }]);
    await settle();
    expect(clicked).toEqual({ type: "left-click" });
    expect(api.environment.commandMode).toBe("menu-bar");
  });

  it("sets environment.launchType from the launch", async () => {
    const { api } = setup({}, { launchType: "background" });
    expect(api.environment.launchType).toBe("background");
    expect(api.LaunchType.Background).toBe("background");
  });
});

describe("ActionPanel and actions", () => {
  it("keeps ActionPanel.Submenu nested (with onOpen) and serialises PickDate / Quick Look / CreateSnippet / CreateQuicklink", async () => {
    const { rt, api, h, settle, lastView, invoke } = setup();
    const { List, ActionPanel, Action } = api;
    let opened = 0;
    let picked: unknown = "unset";
    rt.renderRoot(
      h(
        List,
        { selectedItemId: "b" },
        h(List.Item, {
          id: "a",
          title: "A",
          quickLook: { path: "/tmp/x.txt", name: "x" },
          actions: h(
            ActionPanel,
            null,
            h(Action, { title: "Go", onAction: () => undefined }),
            h(ActionPanel.Submenu, { title: "Share", onOpen: () => opened++ }, h(Action.CopyToClipboard, { content: "a" }), h(ActionPanel.Submenu, { title: "Deeper" }, h(Action, { title: "Deep", onAction: () => undefined }))),
            h(Action.PickDate, { title: "Due", type: Action.PickDate.Type.Date, onChange: (d: Date | null) => (picked = d) }),
            h(Action.ToggleQuickLook),
            h(Action.CreateSnippet, { snippet: { text: "hi", keyword: ";h" } }),
            h(Action.CreateQuicklink, { quicklink: { link: "https://x.dev/?q={query}", name: "X" } }),
          ),
        }),
        h(List.Item, { id: "b", title: "B" }),
      ),
    );
    await settle();
    const v = lastView() as Extract<ViewModel, { type: "list" }>;
    expect(v.selectedItemId).toBe("b");
    expect(v.items[0].quickLook).toEqual({ path: "/tmp/x.txt", name: "x" });
    const acts = v.items[0].actions;
    expect(acts.map((a) => a.kind)).toEqual(["run", "submenu", "pickDate", "quickLook", "createSnippet", "createQuicklink"]);
    const sub = acts[1] as ActionModel;
    expect(sub.title).toBe("Share");
    expect(sub.children?.map((c) => c.kind)).toEqual(["copy", "submenu"]);
    expect(sub.children?.[1].children?.[0].title).toBe("Deep");
    invoke(0, sub.callback!);
    await settle();
    expect(opened).toBe(1);
    expect(acts[2].dateType).toBe("date");
    invoke(0, acts[2].handler!, ["2026-10-21T00:00:00.000Z"]);
    await settle();
    expect(picked).toBeInstanceOf(Date);
    expect(acts[3]).toMatchObject({ title: "Quick Look", shortcut: "⌘Y" });
    expect(acts[4].snippet).toEqual({ text: "hi", keyword: ";h" });
    expect(acts[5].quicklink).toEqual({ link: "https://x.dev/?q={query}", name: "X" });
  });

  it("toast primary/secondary actions run in the extension and hide() asks main to remove the toast", async () => {
    const { api, requests, invoke, settle } = setup();
    let undone = 0;
    const toast = await api.showToast({ title: "Archived", primaryAction: { title: "Undo", shortcut: { modifiers: ["cmd"], key: "z" }, onAction: (t: any) => (undone++, t.hide()) }, secondaryAction: { title: "Open", onAction: () => undefined } });
    const [style, title, , id, actions] = requests("showToast")[0];
    expect([style, title, id]).toEqual(["success", "Archived", toast.id]);
    expect(actions).toEqual([
      { slot: "primary", title: "Undo", shortcut: "⌘Z", handler: `toast:${toast.id}:primary` },
      { slot: "secondary", title: "Open", shortcut: null, handler: `toast:${toast.id}:secondary` },
    ]);
    invoke(0, `toast:${toast.id}:primary`);
    await settle();
    expect(undone).toBe(1);
    expect(requests("toast.hide")).toEqual([[toast.id]]);
  });
});

describe("Form drafts and field refs", () => {
  it("enableDrafts restores values as defaults and draftValues, and a submit clears them", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "drafts-"));
    const run = () => {
      const s = setup({}, { commandPath: path.join(dir, "cmd.cjs") }, dir);
      return s;
    };
    fs.writeFileSync(path.join(dir, "cmd.cjs"), "module.exports = function () { return null; };");
    const first = run();
    const { api, h } = first;
    const form = (props: Record<string, unknown> = {}) =>
      h(api.Form, { enableDrafts: true, actions: h(api.ActionPanel, null, h(api.Action.SubmitForm, { onSubmit: () => undefined })), ...props }, h(api.Form.TextField, { id: "title", title: "Title", defaultValue: "Untitled" }));
    first.rt.renderRoot(form());
    await first.settle();
    let v = first.lastView() as Extract<ViewModel, { type: "form" }>;
    expect(v.drafts).toBe(true);
    expect(v.fields[0].default).toBe("Untitled");
    first.invoke(0, v.fields[0].changeHandler!, ["Half written"]);
    await first.settle();

    // A new launch of the same command (same support dir): the draft comes back.
    const second = run();
    second.rt.renderRoot(form());
    await second.settle();
    v = second.lastView() as Extract<ViewModel, { type: "form" }>;
    expect(v.fields[0].default).toBe("Half written");
    const cache = new second.api.Cache({ namespace: "glide-form-drafts" });
    expect(JSON.parse(cache.get("cmd"))).toEqual({ title: { type: "text", value: "Half written" } });
    second.invoke(0, v.actions![0].handler!, [{ title: "Half written" }]);
    await second.settle();
    expect(new second.api.Cache({ namespace: "glide-form-drafts" }).get("cmd")).toBeUndefined();
  });

  it("passes draftValues to the command component", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "draftprops-"));
    fs.mkdirSync(path.join(dir, ".cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cache", "glide-form-drafts.json"), JSON.stringify({ cmd: JSON.stringify({ title: { type: "text", value: "Kept" }, due: { type: "date", value: "2026-01-02T00:00:00.000Z" } }) }));
    fs.writeFileSync(path.join(dir, "cmd.cjs"), "let seen; module.exports = function (props) { globalThis.__draftProps = props.draftValues; return null; };");
    setup({}, { commandPath: path.join(dir, "cmd.cjs") }, dir);
    await new Promise((r) => setTimeout(r, 10));
    const seen = (globalThis as { __draftProps?: Record<string, unknown> }).__draftProps;
    expect(seen?.title).toBe("Kept");
    expect(seen?.due).toBeInstanceOf(Date);
  });

  it("field refs: focus() and reset() are sent to the launcher with the field id", async () => {
    const { api, h, R, rt, settle, requests } = setup();
    let ref: any = null;
    function Cmd() {
      const r = R.useRef(null);
      ref = r;
      return h(api.Form, null, h(api.Form.TextField, { id: "name", title: "Name", ref: r }));
    }
    rt.renderRoot(h(Cmd));
    await settle();
    ref.current.focus();
    ref.current.reset();
    await settle();
    expect(requests("form.field")).toEqual([
      ["focus", "name"],
      ["reset", "name"],
    ]);
  });
});

describe("AI", () => {
  it("AI.ask streams data events and resolves with the answer; canAccess reflects the host", async () => {
    const { api } = setup(
      {
        "ai.ask": async (params, c) => {
          c.stream("Hel");
          c.stream("lo");
          return `Hello (${String(params[0])})`;
        },
      },
      { capabilities: { ai: true } },
    );
    expect(api.environment.canAccess(api.AI)).toBe(true);
    const chunks: string[] = [];
    const p = api.AI.ask("hi", { creativity: "low" });
    p.on("data", (d: string) => chunks.push(d));
    expect(await p).toBe("Hello (hi)");
    expect(chunks).toEqual(["Hel", "lo"]);
  });

  it("canAccess(AI) is false without a key", () => {
    const { api } = setup();
    expect(api.environment.canAccess(api.AI)).toBe(false);
  });

  it("useAI renders the streamed answer", async () => {
    const { rt, api, utils, h, settle, lastView } = setup({ "ai.ask": async (_p, c) => (c.stream("Fake "), c.stream("answer"), "Fake answer") }, { capabilities: { ai: true } });
    function Cmd() {
      const { data, isLoading } = utils.useAI("prompt");
      return h(api.Detail, { isLoading, markdown: `ai:${data}` });
    }
    rt.renderRoot(h(Cmd));
    await settle(10);
    expect(lastView()).toMatchObject({ type: "detail", markdown: "ai:Fake answer", isLoading: false });
  });
});

describe("OAuth", () => {
  it("PKCEClient builds an S256 authorization request with the glide://oauth redirect and stores tokens through main", async () => {
    const store: Record<string, JsonValue> = {};
    const { api, requests } = setup({
      "oauth.authorize": (p) => ({ code: `code-for-${(p[0] as Record<string, string>).state}` }),
      "oauth.setTokens": (p) => ((store[String(p[0])] = p[1]), null),
      "oauth.getTokens": (p) => store[String(p[0])] ?? null,
      "oauth.removeTokens": (p) => (delete store[String(p[0])], null),
    });
    const client = new api.OAuth.PKCEClient({ redirectMethod: api.OAuth.RedirectMethod.Web, providerName: "Test", providerId: "test" });
    const req = await client.authorizationRequest({ endpoint: "https://auth.example/authorize", clientId: "cid", scope: "read write", extraParameters: { prompt: "consent" } });
    const url = new URL(req.toURL());
    expect(url.searchParams.get("redirect_uri")).toBe("glide://oauth?package_name=fixture");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const crypto = await import("node:crypto");
    expect(url.searchParams.get("code_challenge")).toBe(crypto.createHash("sha256").update(req.codeVerifier).digest("base64url"));
    expect(url.searchParams.get("prompt")).toBe("consent");
    const { authorizationCode } = await client.authorize(req);
    expect(authorizationCode).toBe(`code-for-${req.state}`);
    expect((requests("oauth.authorize")[0][0] as Record<string, string>).providerName).toBe("Test");
    await client.setTokens({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read" });
    const set = await client.getTokens();
    expect(set).toMatchObject({ accessToken: "at", refreshToken: "rt", expiresIn: 3600, scope: "read" });
    expect(set.isExpired()).toBe(false);
    await client.removeTokens();
    expect(await client.getTokens()).toBeUndefined();
  });

  it("OAuthService exchanges the code at the token URL (local server) and withAccessToken renders once authorized", async () => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        bodies.push(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "tok-1", refresh_token: "ref-1", expires_in: 60 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const store: Record<string, JsonValue> = {};
      const { rt, api, utils, h, settle, lastView } = setup({
        "oauth.authorize": () => ({ code: "the-code" }),
        "oauth.setTokens": (p) => ((store[String(p[0])] = p[1]), null),
        "oauth.getTokens": (p) => store[String(p[0])] ?? null,
      });
      const client = new api.OAuth.PKCEClient({ providerName: "Local", providerId: "local" });
      const service = new utils.OAuthService({ client, clientId: "c1", scope: "read", authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, bodyEncoding: "url-encoded" });
      const Wrapped = utils.withAccessToken(service)(() => h(api.Detail, { markdown: `token=${utils.getAccessToken().token}` }));
      rt.renderRoot(h(Wrapped));
      for (let i = 0; i < 40 && (lastView() as { markdown?: string } | undefined)?.markdown !== "token=tok-1"; i++) await settle(2);
      expect(lastView()).toMatchObject({ type: "detail", markdown: "token=tok-1" });
      const form = new URLSearchParams(bodies[0]);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("the-code");
      expect(form.get("code_verifier")?.length).toBeGreaterThan(40);
      expect(form.get("redirect_uri")).toBe("glide://oauth?package_name=fixture");
      expect(store.local).toMatchObject({ accessToken: "tok-1", refreshToken: "ref-1" });
    } finally {
      server.close();
    }
  });
});

describe("system helpers", () => {
  it("getFrontmostApplication / getSelectedFinderItems go through main; errors surface", async () => {
    const { api } = setup({
      "app.frontmost": () => ({ name: "Finder", path: "/System/Library/CoreServices/Finder.app", bundleId: "com.apple.finder" }),
      "finder.selection": () => ["/tmp/a", "/tmp/b"],
    });
    expect(await api.getFrontmostApplication()).toEqual({ name: "Finder", path: "/System/Library/CoreServices/Finder.app", bundleId: "com.apple.finder" });
    expect(await api.getSelectedFinderItems()).toEqual([{ path: "/tmp/a" }, { path: "/tmp/b" }]);
    const failing = setup({
      "finder.selection": () => {
        throw new Error("getSelectedFinderItems is not supported in this Glide build (unknown method)");
      },
    });
    await expect(failing.api.getSelectedFinderItems()).rejects.toThrow(/not supported/);
  });

  it("launchCommand passes the launch type", async () => {
    const { api, requests } = setup();
    await api.launchCommand({ name: "tick", type: api.LaunchType.Background });
    expect(requests("launchCommand")[0][4]).toBe("background");
  });
});
