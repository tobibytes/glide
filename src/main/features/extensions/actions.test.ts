import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { API_SHIM_SOURCE, buildRunnerSource } from "../../../extension-api/runtime";
import type { ActionModel, ChildMessage, JsonValue, ParentMessage, ViewModel } from "../../../extension-api/types";
import { dispatchAction, findAction, isSafeUrl, type ActionEffects } from "./actions";
import { SessionManager, type ChildHandle, type SessionEvent } from "./sessions";

function fx(): ActionEffects & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openUrl: async (u) => void calls.push(`open:${u}`),
    copy: async (t) => void calls.push(`copy:${t}`),
    paste: async (t) => void calls.push(`paste:${t}`),
    hud: (t) => void calls.push(`hud:${t}`),
    invoke: (h, a) => void calls.push(`invoke:${h}:${JSON.stringify(a)}`),
  };
}

const A = (a: Partial<ActionModel> & Pick<ActionModel, "kind">): ActionModel => ({ id: "a1", title: "t", ...a });

describe("dispatchAction", () => {
  it("opens only safe URLs", async () => {
    const f = fx();
    expect(await dispatchAction(A({ kind: "openInBrowser", url: "https://example.com/x" }), f)).toEqual({ ok: true, hide: true });
    const bad = await dispatchAction(A({ kind: "openInBrowser", url: "javascript:alert(1)" }), f);
    expect(bad.ok).toBe(false);
    expect(f.calls).toEqual(["open:https://example.com/x"]);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("mailto:a@b.c")).toBe(true);
  });

  it("copies with a HUD, pastes, and invokes handlers", async () => {
    const f = fx();
    expect(await dispatchAction(A({ kind: "copy", text: "abc" }), f)).toEqual({ ok: true, hide: true });
    expect(await dispatchAction(A({ kind: "paste", text: "p" }), f)).toEqual({ ok: true, hide: true });
    expect(await dispatchAction(A({ kind: "run", handler: "h7" }), f)).toEqual({ ok: true });
    expect((await dispatchAction(A({ kind: "push" }), f)).ok).toBe(false);
    expect(f.calls).toEqual(["copy:abc", "hud:Copied to Clipboard", "paste:p", "invoke:h7:[]"]);
  });

  it("finds actions inside list items", () => {
    const view: ViewModel = { type: "list", isLoading: false, items: [{ id: "x", title: "X", accessories: [], keywords: [], actions: [A({ id: "a9", kind: "copy", text: "q" })] }] };
    expect(findAction(view, "a9")?.text).toBe("q");
    expect(findAction(view, "nope")).toBeUndefined();
  });
});

// --- real extension process (child_process.fork of the generated runner) ---------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glide-ext-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
fs.writeFileSync(path.join(tmp, "runner.cjs"), buildRunnerSource());
fs.writeFileSync(path.join(tmp, "glide-api.cjs"), API_SHIM_SOURCE);

function writeCommand(name: string, body: string): string {
  const file = path.join(tmp, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
}

function forkSpawn(): ChildHandle {
  const child = fork(path.join(tmp, "runner.cjs"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  return {
    postMessage: (m: ParentMessage) => child.send(m),
    onMessage: (cb) => child.on("message", (m) => cb(m as ChildMessage)),
    onExit: (cb) => child.on("exit", (code) => cb(code)),
    kill: () => void child.kill(),
  };
}

function manager(requests: Array<[string, JsonValue[]]>, events: SessionEvent[]) {
  return new SessionManager({
    spawn: forkSpawn,
    onRequest: async (_info, method, params) => {
      requests.push([method, params]);
      if (method === "storage.get") return "stored";
      if (method === "clipboard.read") return "clip";
    },
    emit: (e) => events.push(e),
    log: () => undefined,
  });
}

const init = (commandPath: string, mode: "view" | "no-view" = "view") => ({
  commandPath,
  apiPath: path.join(tmp, "glide-api.cjs"),
  arguments: { q: "hello" },
  preferences: { unit: "c" },
  environment: { extensionName: "t", extensionTitle: "T", commandName: "c", commandMode: mode, assetsPath: tmp, extensionPath: tmp, supportPath: tmp, glideVersion: "0" },
});
const meta = (mode: "view" | "no-view") => ({ extName: "t", extTitle: "T", commandName: "c", commandTitle: "C", mode });

describe("extension process round trip", () => {
  it("runs a no-view command that uses requests", async () => {
    const cmd = writeCommand(
      "noview",
      `const { Clipboard, showHUD, LocalStorage, getPreferenceValues } = require("@glide/api");
       module.exports = async function (ctx) {
         const v = await LocalStorage.getItem("k");
         const c = await Clipboard.read();
         await Clipboard.copy(ctx.arguments.q + ":" + v + ":" + c + ":" + getPreferenceValues().unit);
         await showHUD("done");
       };`,
    );
    const requests: Array<[string, JsonValue[]]> = [];
    const m = manager(requests, []);
    const info = m.start(meta("no-view"), init(cmd, "no-view"));
    expect(await m.completion(info.id)).toEqual({ ok: true });
    expect(requests).toEqual([
      ["storage.get", ["k"]],
      ["clipboard.read", []],
      ["clipboard.copy", ["hello:stored:clip:c"]],
      ["showHUD", ["done"]],
    ]);
    m.killAll();
  });

  it("renders a list, forwards search text, dispatches Run and Push actions", async () => {
    const cmd = writeCommand(
      "view",
      `const { List, Detail, Action, showToast } = require("@glide/api");
       exports.default = async (ctx) => {
         const render = (q) => ctx.render(List({
           onSearchTextChange: render,
           items: [{ id: "i", title: "Item " + q, actions: [
             Action.Run("Toast", () => showToast({ title: "ran " + q })),
             Action.Push("Open", (nav) => Detail({ markdown: "detail " + q })),
           ] }],
         }));
         render("");
       };`,
    );
    const events: SessionEvent[] = [];
    const requests: Array<[string, JsonValue[]]> = [];
    const m = manager(requests, events);
    const info = m.start(meta("view"), init(cmd));
    await vi.waitFor(() => expect(m.view(info.id, 0)).toBeTruthy(), { timeout: 5000 });
    m.mountView(info.id, 0);
    let view = m.view(info.id, 0)!;
    expect(view.type).toBe("list");
    if (view.type !== "list") return;
    m.invoke(info.id, 0, view.searchHandler!, ["abc"]);
    await vi.waitFor(() => {
      const v = m.view(info.id, 0);
      expect(v?.type === "list" && v.items[0].title).toBe("Item abc");
    });
    view = m.view(info.id, 0)!;
    const f = { ...fx(), invoke: (h: string, a: unknown[]) => void m.invoke(info.id, 0, h, a as JsonValue[]) };
    const run = findAction(view, view.type === "list" ? view.items[0].actions[0].id : "")!;
    expect((await dispatchAction(run, f)).ok).toBe(true);
    await vi.waitFor(() => expect(requests).toContainEqual(["showToast", ["success", "ran abc", null]]));
    const push = findAction(view, view.type === "list" ? view.items[0].actions[1].id : "")!;
    await dispatchAction(push, f);
    await vi.waitFor(() => expect(m.view(info.id, 1)).toMatchObject({ type: "detail", markdown: "detail abc" }));
    expect(events.some((e) => e.kind === "push" && e.depth === 1)).toBe(true);
    m.mountView(info.id, 1);
    m.unmountView(info.id, 1);
    m.mountView(info.id, 0);
    expect(m.view(info.id, 1)).toBeUndefined();
    m.killAll();
  });

  it("shows an error view when a view command throws", async () => {
    const cmd = writeCommand("boom", `module.exports = async () => { throw new Error("kaboom"); };`);
    const m = manager([], []);
    const info = m.start(meta("view"), init(cmd));
    await vi.waitFor(() => expect(m.view(info.id, 0)).toMatchObject({ type: "detail" }));
    const v = m.view(info.id, 0);
    expect(v?.type === "detail" && v.markdown).toContain("kaboom");
    m.killAll();
  });

  it("kills idle sessions with no mounted view", async () => {
    const cmd = writeCommand("idle", `const { List } = require("@glide/api"); module.exports = (ctx) => ctx.render(List({ items: [] }));`);
    const m = manager([], []);
    const info = m.start(meta("view"), init(cmd));
    await vi.waitFor(() => expect(m.view(info.id, 0)).toBeTruthy());
    m.sweep(Date.now() + 31_000);
    expect(m.get(info.id)).toBeUndefined();
    m.killAll();
  });
});

describe("dispatchAction (Raycast kinds)", () => {
  const rfx = () => {
    const f = fx();
    return Object.assign(f, {
      open: async (t: string, app?: string) => void f.calls.push(`openWith:${t}:${app ?? ""}`),
      showInFinder: async (p: string) => void f.calls.push(`reveal:${p}`),
      trash: async (p: string[]) => void f.calls.push(`trash:${p.join(",")}`),
    });
  };

  it("opens targets, reveals, trashes and runs callbacks after the effect", async () => {
    const f = rfx();
    expect(await dispatchAction(A({ kind: "open", target: "~/Downloads", application: "Finder", callback: "cb1" }), f)).toEqual({ ok: true, hide: true });
    expect(await dispatchAction(A({ kind: "open", target: "javascript:alert(1)" }), f)).toMatchObject({ ok: false });
    expect(await dispatchAction(A({ kind: "showInFinder", target: "/tmp/x" }), f)).toEqual({ ok: true, hide: true });
    expect(await dispatchAction(A({ kind: "trash", paths: ["/tmp/a", "/tmp/b"] }), f)).toEqual({ ok: true });
    expect(await dispatchAction(A({ kind: "copy", text: "c", html: "<b>c</b>", callback: "cb2" }), f)).toEqual({ ok: true, hide: true });
    expect(await dispatchAction(A({ kind: "submit", handler: "s" }), f)).toMatchObject({ ok: false });
    expect(f.calls).toEqual(["openWith:~/Downloads:Finder", "invoke:cb1:[]", "reveal:/tmp/x", "trash:/tmp/a,/tmp/b", "hud:Moved 2 items to Trash", "copy:c", "hud:Copied to Clipboard", "invoke:cb2:[]"]);
  });

  it("finds actions of grids, list-level actions, empty views and forms", () => {
    const grid: ViewModel = { type: "grid", columns: 4, aspectRatio: "1", fit: "contain", isLoading: false, items: [{ id: "g", content: "#fff", keywords: [], actions: [A({ id: "x", kind: "run", handler: "h" })] }], emptyView: { actions: [A({ id: "e", kind: "run" })] } };
    expect(findAction(grid, "x")?.handler).toBe("h");
    expect(findAction(grid, "e")?.id).toBe("e");
    const form: ViewModel = { type: "form", fields: [], submitTitle: "Go", isLoading: false, actions: [A({ id: "s", kind: "submit", handler: "sub" })] };
    expect(findAction(form, "s")?.handler).toBe("sub");
  });
});
