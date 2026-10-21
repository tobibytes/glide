import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { MenuBarHandle, MenuBarItemSpec } from "../../menubar";
import type { ViewModel } from "../../../extension-api/types";
import { createFakeAsker, mapModel } from "./ai-bridge";
import { BackgroundScheduler } from "./background";
import { RaycastCompat, type CompatDeps } from "./compat";
import { findAction } from "./actions";
import { missingPreferences, parseInterval, prefKey, resolvePreferences, type ExtensionManifest } from "./manifest";
import { menuBarSpec, toAccelerator } from "./menubar-ext";
import { OAuthFlows, OAuthTokenStore, type Cipher } from "./oauth";
import { translateRaycastManifest } from "./raycast-manifest";
import type { SessionEvent, SessionInfo } from "./sessions";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glide-compat-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Reversible stand-in for safeStorage (XOR), so the test can check nothing is stored in plain text. */
const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString(),
};

describe("manifest: interval and command-scoped preferences", () => {
  it("parses Raycast intervals (≥ 10 s)", () => {
    expect(parseInterval("10s")).toBe(10_000);
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(parseInterval("1d")).toBe(86_400_000);
    expect(parseInterval("5s")).toBeNull();
    expect(parseInterval("1w")).toBeNull();
    expect(parseInterval(10)).toBeNull();
  });

  it("keeps menu-bar commands and their interval, warns about bad ones", () => {
    const res = translateRaycastManifest(
      {
        name: "mb",
        title: "MB",
        dependencies: { "@raycast/api": "1" },
        commands: [
          { name: "bar", title: "Bar", mode: "menu-bar", interval: "1m" },
          { name: "job", title: "Job", mode: "no-view", interval: "3s" },
          { name: "view", title: "View", mode: "view", interval: "1m" },
        ],
      },
      () => true,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.commands.map((c) => [c.name, c.mode, c.intervalMs ?? null])).toEqual([
      ["bar", "menu-bar", 60_000],
      ["job", "no-view", null],
      ["view", "view", null],
    ]);
    expect(res.manifest.warnings).toHaveLength(2);
  });

  it("namespaces command preferences so equal names do not share a value", () => {
    const m: ExtensionManifest = {
      name: "x",
      version: "1",
      title: "X",
      description: "",
      commands: [],
      preferences: [
        { name: "label", title: "Label", type: "textfield", required: false, data: [], default: "ext" },
        { name: "label", title: "Label", type: "textfield", required: false, data: [], default: "a-default", command: "a" },
        { name: "token", title: "Token", type: "password", required: true, data: [], command: "b" },
      ],
    };
    expect(m.preferences.map(prefKey)).toEqual(["label", "a/label", "b/token"]);
    const saved = { label: "E", "a/label": "A" };
    expect(resolvePreferences(m, saved, "a")).toEqual({ label: "A" });
    expect(resolvePreferences(m, saved, "b")).toEqual({ label: "E", token: "" });
    expect(resolvePreferences(m, saved)).toEqual({ label: "E", "a/label": "A", "b/token": "" });
    expect(missingPreferences(m, saved, "b").map(prefKey)).toEqual(["b/token"]);
    // Values saved before namespacing are still honoured.
    expect(missingPreferences(m, { token: "legacy" }, "b")).toEqual([]);
  });
});

describe("BackgroundScheduler", () => {
  it("runs each enabled entry on its interval, never overlapping, and stops removed ones", async () => {
    vi.useFakeTimers();
    try {
      const runs: string[] = [];
      let release: () => void = () => undefined;
      const s = new BackgroundScheduler({
        run: async (k) => {
          runs.push(k);
          if (k === "slow/x") await new Promise<void>((r) => (release = r));
        },
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      });
      s.sync([
        { key: "a/x", intervalMs: 1000 },
        { key: "slow/x", intervalMs: 500 },
      ]);
      await vi.advanceTimersByTimeAsync(2100);
      expect(runs.filter((r) => r === "a/x")).toHaveLength(2);
      expect(runs.filter((r) => r === "slow/x")).toHaveLength(1); // still running: not started again
      release();
      await vi.advanceTimersByTimeAsync(600);
      expect(runs.filter((r) => r === "slow/x")).toHaveLength(2);
      s.sync([{ key: "slow/x", intervalMs: 500 }]);
      expect(s.scheduled()).toEqual(["slow/x"]);
      const before = runs.filter((r) => r === "a/x").length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(runs.filter((r) => r === "a/x")).toHaveLength(before);
      s.stopAll();
      expect(s.scheduled()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OAuth token store and redirects", () => {
  it("stores tokens per extension and provider, encrypted", () => {
    const store = new OAuthTokenStore(path.join(tmp, "oauth"), cipher);
    store.set("ext-a", "github", { accessToken: "secret-token", refreshToken: "r" });
    store.set("ext-a", "linear", { accessToken: "other" });
    store.set("ext-b", "github", { accessToken: "b-token" });
    expect(store.get("ext-a", "github")).toEqual({ accessToken: "secret-token", refreshToken: "r" });
    expect(store.get("ext-b", "github")).toEqual({ accessToken: "b-token" });
    const raw = fs.readFileSync(path.join(tmp, "oauth", "ext-a.bin"));
    expect(raw.toString()).not.toContain("secret-token");
    expect(fs.statSync(path.join(tmp, "oauth", "ext-a.bin")).mode & 0o777).toBe(0o600);
    store.remove("ext-a", "github");
    expect(store.get("ext-a", "github")).toBeNull();
    store.clear("ext-a");
    expect(store.get("ext-a", "linear")).toBeNull();
    expect(() => store.get("../evil", "x")).toThrow(/Invalid/);
  });

  it("refuses to save without encryption", () => {
    const store = new OAuthTokenStore(path.join(tmp, "oauth-noenc"), { ...cipher, isEncryptionAvailable: () => false });
    expect(() => store.set("e", "p", { accessToken: "x" })).toThrow(/Secure storage/);
  });

  it("matches redirects by state and reports provider errors", async () => {
    const flows = new OAuthFlows();
    const a = flows.start({ extName: "e", sessionId: "s1", url: "https://auth.example/authorize?state=abc", state: "abc", providerName: "P" });
    expect(flows.handleRedirect("glide://oauth?code=nope&state=other")).toBeNull();
    expect(flows.handleRedirect("https://evil.example/?code=1&state=abc")).toBeNull();
    expect(flows.handleRedirect("glide://oauth?package_name=e&code=c0de&state=abc")).toBe(a.request.id);
    await expect(a.code).resolves.toBe("c0de");
    const b = flows.start({ extName: "e", sessionId: "s1", url: "https://auth.example/a", state: "s2", providerName: "P" });
    flows.handleRedirect("glide://oauth?error=access_denied&error_description=User+said+no&state=s2");
    await expect(b.code).rejects.toThrow("User said no");
    const c = flows.start({ extName: "e", sessionId: "s9", url: "https://auth.example/a", state: "s3", providerName: "P" });
    flows.cancelSession("s9");
    await expect(c.code).rejects.toThrow(/stopped/);
    expect(() => flows.start({ extName: "e", sessionId: "s", url: "http://auth.example/a", state: "x", providerName: "P" })).toThrow(/https/);
    expect(() => flows.start({ extName: "e", sessionId: "s", url: "http://127.0.0.1:5/a", state: "x", providerName: "P" })).not.toThrow();
  });
});

describe("menu-bar specs", () => {
  it("turns a MenuBarExtra model into status-item menus", () => {
    const clicks: string[] = [];
    const view: Extract<ViewModel, { type: "menubar" }> = {
      type: "menubar",
      icon: "🧪",
      isLoading: false,
      items: [
        { kind: "section", title: "Top", children: [{ kind: "item", title: "Run", shortcut: "⌘⇧R", handler: "h1" }, { kind: "item", title: "Off" }] },
        { kind: "separator" },
        { kind: "submenu", title: "More", children: [{ kind: "item", title: "Inner", handler: "h2", icon: "https://x/y.png" }] },
        { kind: "separator" },
      ],
    };
    const spec = menuBarSpec(view, (h) => clicks.push(h), "Cmd");
    expect(spec.title).toBeUndefined();
    expect(spec.icon).toBe("🧪");
    expect(spec.menu.map((m) => (m.separator ? "—" : m.title))).toEqual(["Top", "Run", "Off", "—", "More"]);
    expect(spec.menu[0].enabled).toBe(false);
    expect(spec.menu[1].shortcut).toBe("CommandOrControl+Shift+R");
    expect(spec.menu[2].enabled).toBe(false);
    expect(spec.menu[4].submenu?.[0].icon).toBeUndefined();
    spec.menu[1].onClick?.();
    spec.menu[4].submenu?.[0].onClick?.();
    expect(clicks).toEqual(["h1", "h2"]);
    expect(menuBarSpec({ type: "menubar", isLoading: true, items: [] }, () => undefined, "Cmd")).toMatchObject({ title: "Cmd", menu: [{ title: "Loading…", enabled: false }] });
    expect(toAccelerator("⌃⌥K")).toBe("Control+Alt+K");
  });
});

describe("findAction inside submenus", () => {
  it("finds nested actions by id", () => {
    const view: ViewModel = {
      type: "detail",
      markdown: "",
      metadata: [],
      isLoading: false,
      actions: [{ id: "s", kind: "submenu", title: "S", children: [{ id: "deep", kind: "run", title: "Deep", handler: "h" }] }],
    };
    expect(findAction(view, "deep")?.handler).toBe("h");
  });
});

// --- RaycastCompat with fakes ----------------------------------------------------------------

function fakeCompat(over: Partial<CompatDeps> = {}) {
  const manifest: ExtensionManifest = {
    name: "lab",
    version: "1",
    title: "Lab",
    description: "",
    runtime: "raycast",
    preferences: [],
    commands: [
      { name: "bar", title: "Bar", mode: "menu-bar", arguments: [], keywords: [], entry: "x", intervalMs: 60_000, interval: "1m" },
      { name: "tick", title: "Tick", mode: "no-view", arguments: [], keywords: [], entry: "x", intervalMs: 10_000, interval: "10s" },
      { name: "view", title: "View", mode: "view", arguments: [], keywords: [], entry: "x" },
    ],
  };
  const ext = { name: "lab", dir: tmp, enabled: true, manifest };
  let background: Record<string, boolean> = {};
  const registered: Array<{ spec: MenuBarItemSpec; removed: boolean; updates: Array<Omit<MenuBarItemSpec, "id">> }> = [];
  const events: SessionEvent[] = [];
  const launches: Array<{ ext: string; command: string; launchType: string }> = [];
  const invoked: Array<[string, number, string]> = [];
  const killed: string[] = [];
  const keepAlive: string[] = [];
  let seq = 0;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let compat!: RaycastCompat;
  const sessions = {
    setKeepAlive: (id: string) => keepAlive.push(id),
    kill: (id: string) => killed.push(id),
    invoke: (id: string, depth: number, handler: string) => (invoked.push([id, depth, handler]), true),
  };
  const deps: CompatDeps = {
    sessions: () => sessions as never,
    registry: () => ({ list: () => [ext], get: (n: string) => (n === "lab" ? ext : undefined) }) as never,
    launch: async (e, command, o) => {
      launches.push({ ext: e, command, launchType: o.launchType });
      const info: SessionInfo = { id: `s${++seq}`, extName: e, extTitle: "Lab", commandName: command, commandTitle: command, mode: command === "bar" ? "menu-bar" : "no-view", launchType: o.launchType };
      if (command === "bar") compat.menuSessionStarted(info);
      return { ok: true, sessionId: info.id };
    },
    getBackground: () => background,
    setBackground: (next) => void (background = next),
    registerMenuBarItem: (spec) => {
      const entry = { spec, removed: false, updates: [] as Array<Omit<MenuBarItemSpec, "id">> };
      registered.push(entry);
      const handle: MenuBarHandle = { update: (s) => void entry.updates.push(s), remove: () => void (entry.removed = true) };
      return handle;
    },
    emit: (e) => void events.push(e),
    openView: () => undefined,
    openExternal: async () => undefined,
    helperCall: async () => null,
    tokens: new OAuthTokenStore(path.join(tmp, "compat-oauth"), cipher),
    ai: createFakeAsker(),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length - 1),
    clearTimer: () => undefined,
    log: () => undefined,
    ...over,
  };
  compat = new RaycastCompat(deps);
  return { compat, registered, events, launches, invoked, killed, keepAlive, timers, background: () => background };
}

describe("RaycastCompat", () => {
  it("activates a menu-bar command, renders its MenuBarExtra as a status item and routes clicks", async () => {
    const t = fakeCompat();
    t.compat.setEnabled("lab", "bar", true);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.launches).toEqual([{ ext: "lab", command: "bar", launchType: "background" }]);
    expect(t.keepAlive).toEqual(["s1"]);
    expect(t.compat.scheduledKeys()).toEqual(["lab/bar"]);
    const consumed = t.compat.onSessionEvent({ sessionId: "s1", depth: 0, kind: "render", view: { type: "menubar", title: "3", isLoading: false, items: [{ kind: "item", title: "Go", handler: "1.onAction" }] } });
    expect(consumed).toBe(true);
    expect(t.registered[0].spec).toMatchObject({ id: "ext:lab/bar", title: "3" });
    t.registered[0].spec.menu[0].onClick?.();
    expect(t.invoked).toEqual([["s1", 0, "1.onAction"]]);
    // Interval refresh relaunches in the background and replaces the process; the item is updated in place.
    t.timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.launches[1]).toEqual({ ext: "lab", command: "bar", launchType: "background" });
    expect(t.killed).toEqual(["s1"]);
    t.compat.onSessionEvent({ sessionId: "s2", depth: 0, kind: "render", view: { type: "menubar", title: "4", isLoading: false, items: [] } });
    expect(t.registered).toHaveLength(1);
    expect(t.registered[0].updates.at(-1)?.title).toBe("4");
    // A crash shows an error item.
    t.compat.onSessionEvent({ sessionId: "s2", depth: 0, kind: "render", view: { type: "detail", markdown: "# Bar failed\n\nboom", metadata: [], actions: [], isLoading: false } });
    expect(t.registered[0].updates.at(-1)).toMatchObject({ title: "⚠️" });
    t.compat.setEnabled("lab", "bar", false);
    expect(t.registered[0].removed).toBe(true);
    expect(t.killed).toContain("s2");
  });

  it("runs no-view interval commands in the background only when enabled; the first user launch enables them", async () => {
    const t = fakeCompat();
    t.compat.sync();
    expect(t.compat.scheduledKeys()).toEqual([]);
    t.compat.userLaunched("lab", { name: "tick", title: "Tick", mode: "no-view", arguments: [], keywords: [], entry: "x", intervalMs: 10_000 });
    expect(t.background()).toEqual({ "lab/tick": true });
    expect(t.compat.scheduledKeys()).toEqual(["lab/tick"]);
    expect(t.timers[0].ms).toBe(10_000);
    t.timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.launches).toEqual([{ ext: "lab", command: "tick", launchType: "background" }]);
    expect(t.compat.state().find((s) => s.command === "tick")).toMatchObject({ enabled: true, interval: "10s", runs: 1 });
    t.compat.setEnabled("lab", "tick", false);
    expect(t.compat.scheduledKeys()).toEqual([]);
  });

  it("caps intervals in headless tests", () => {
    const t = fakeCompat({ intervalCapMs: 1500 });
    t.compat.setEnabled("lab", "tick", true);
    expect(t.timers[0].ms).toBe(1500);
  });

  const info: SessionInfo = { id: "s7", extName: "lab", extTitle: "Lab", commandName: "view", commandTitle: "View", mode: "view" };

  it("answers frontmost-app and Finder requests, with a clear error when the helper lacks the method", async () => {
    const t = fakeCompat({
      helperCall: async (m) => {
        if (m === "app.frontmost") return { name: "Notes", bundleId: "com.apple.Notes", pid: 1, path: "/System/Applications/Notes.app" };
        throw new Error("Unknown method finder.selection");
      },
    });
    expect(await t.compat.request(info, "app.frontmost", [], () => undefined)).toEqual({ value: { name: "Notes", path: "/System/Applications/Notes.app", bundleId: "com.apple.Notes" } });
    await expect(t.compat.request(info, "finder.selection", [], () => undefined)).rejects.toThrow(/getSelectedFinderItems is not supported/);
    const ok = fakeCompat({ helperCall: async () => ({ paths: ["/a", 3, "/b"], source: "ax" }) });
    expect(await ok.compat.request(info, "finder.selection", [], () => undefined)).toEqual({ value: ["/a", "/b"] });
    expect(await t.compat.request(info, "storage.get", [], () => undefined)).toBeUndefined();
  });

  it("streams AI answers from the injected asker and refuses without a key", async () => {
    const t = fakeCompat();
    const chunks: string[] = [];
    const res = await t.compat.request(info, "ai.ask", ["Hi", { model: "Anthropic_Claude_Haiku" }], (c) => chunks.push(c));
    expect(res?.value).toBe("Fake AI answer to: Hi");
    expect(chunks.join("")).toBe("Fake AI answer to: Hi");
    const none = fakeCompat({ ai: { available: () => false, ask: async () => "" } });
    await expect(none.compat.request(info, "ai.ask", ["Hi"], () => undefined)).rejects.toThrow(/not set up/);
    expect(mapModel("Anthropic_Claude_Haiku", "claude-opus-5-5")).toBe("claude-haiku-4-5");
    expect(mapModel("OpenAI_GPT4o", "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  it("OAuth: shows the sign-in card, opens the browser on request and resolves on the redirect", async () => {
    const opened: string[] = [];
    const t = fakeCompat({ openExternal: async (u) => void opened.push(u) });
    const pending = t.compat.request(info, "oauth.authorize", [{ url: "https://auth.example/authorize?state=st1", state: "st1", providerName: "Example" }], () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    const card = t.events.find((e) => e.kind === "oauth");
    expect(card?.oauth).toMatchObject({ providerName: "Example" });
    await t.compat.openAuthorization(card!.oauth!.id);
    expect(opened).toEqual(["https://auth.example/authorize?state=st1"]);
    expect(t.compat.redirect("glide://oauth?code=xyz&state=st1")).toBe(true);
    expect(await pending).toEqual({ value: { code: "xyz" } });
    expect(t.events.at(-1)).toMatchObject({ kind: "oauthDone", oauthId: card!.oauth!.id });
    await t.compat.request(info, "oauth.setTokens", ["example", { accessToken: "a" }], () => undefined);
    expect(await t.compat.request(info, "oauth.getTokens", ["example"], () => undefined)).toEqual({ value: { accessToken: "a" } });
  });

  it("forwards field ref calls to the launcher", async () => {
    const t = fakeCompat();
    await t.compat.request(info, "form.field", ["reset", "title"], () => undefined);
    expect(t.events).toEqual([{ sessionId: "s7", kind: "field", field: { op: "reset", id: "title" } }]);
  });
});
