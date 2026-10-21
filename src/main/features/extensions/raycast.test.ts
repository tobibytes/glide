import { fork } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRaycastRunnerSource, RAYCAST_SHIMS } from "../../../extension-api/raycast/runtime";
import type { ChildMessage, InitPayload, JsonValue, ParentMessage, ViewModel } from "../../../extension-api/types";
import { missingPreferences, resolvePreferences } from "./manifest";
import { buildRaycastCommands, describeEsbuildError } from "./raycast-build";
import { isRaycastPackage, translateRaycastManifest } from "./raycast-manifest";
import { ExtensionRegistry, readManifest } from "./registry";
import { SessionManager } from "./sessions";

const fixtures = path.resolve(__dirname, "../../../../extensions-examples/raycast-fixtures");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glide-raycast-"));
const runtimeDir = path.join(tmp, "runtime");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(path.join(runtimeDir, "raycast-runner.cjs"), buildRaycastRunnerSource());
for (const [f, src] of Object.entries(RAYCAST_SHIMS)) fs.writeFileSync(path.join(runtimeDir, f), src);

const builder = async (src: string, out: string, m: Parameters<typeof buildRaycastCommands>[2]) => (await buildRaycastCommands(src, out, m, esbuild)).errors;
const registry = new ExtensionRegistry(path.join(tmp, "data"), builder);

describe("Raycast manifest translation", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(fixtures, "rc-fruits/package.json"), "utf8"));

  it("detects Raycast packages and maps commands, arguments and preferences", () => {
    expect(isRaycastPackage(pkg)).toBe(true);
    expect(isRaycastPackage({ name: "x", glide: { commands: [] }, commands: [] })).toBe(false);
    const res = translateRaycastManifest(pkg, (p) => p === ".glide-build/browse-fruits.cjs" || p === ".glide-build/copy-fruit.cjs");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = res.manifest;
    expect(m.runtime).toBe("raycast");
    expect(m.icon).toBe("extension-icon.png");
    expect(m.commands.map((c) => [c.name, c.mode, c.entry])).toEqual([
      ["browse-fruits", "view", ".glide-build/browse-fruits.cjs"],
      ["copy-fruit", "no-view", ".glide-build/copy-fruit.cjs"],
    ]);
    expect(m.warnings?.[0]).toMatch(/menu-bar/);
    expect(m.commands[1].arguments).toEqual([{ name: "fruit", placeholder: "Fruit", required: true, type: "text" }]);
    expect(m.preferences.map((p) => [p.name, p.type, p.required, p.default])).toEqual([
      ["greeting", "textfield", true, undefined],
      ["showPrices", "checkbox", false, true],
      ["currency", "dropdown", false, "usd"],
    ]);
    expect(m.preferences[1].description).toBe("Show prices as accessories");
    expect(missingPreferences(m, {}).map((p) => p.name)).toEqual(["greeting"]);
    expect(resolvePreferences(m, { greeting: "Hi" })).toEqual({ greeting: "Hi", showPrices: true, currency: "usd" });
  });

  it("scopes command preferences and reports unbuilt commands", () => {
    const res = translateRaycastManifest(
      { name: "scoped", title: "Scoped", commands: [{ name: "a", title: "A", mode: "view", preferences: [{ name: "token", title: "Token", type: "password", required: true }] }, { name: "b", title: "B", mode: "view" }], dependencies: { "@raycast/api": "1" } },
      () => true,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(missingPreferences(res.manifest, {}, "a").map((p) => p.name)).toEqual(["token"]);
    expect(missingPreferences(res.manifest, {}, "b")).toEqual([]);
    expect(translateRaycastManifest({ name: "nb", title: "NB", commands: [{ name: "x", title: "X", mode: "view" }], dependencies: { "@raycast/api": "1" } }, () => false)).toMatchObject({ ok: false });
  });

  it("explains missing dependencies", () => {
    expect(describeEsbuildError({ text: 'Could not resolve "node-fetch/lib"', location: { file: "src/a.tsx", line: 3 } }, "/x")).toMatch(/Missing dependency "node-fetch" \(src\/a.tsx:3\).*npm install/);
    expect(describeEsbuildError({ text: 'Could not resolve "@scope/pkg/sub"' }, "/x")).toMatch(/"@scope\/pkg"/);
  });
});

describe("Raycast import (esbuild)", () => {
  it("imports every fixture, copying only package.json, assets and bundles", async () => {
    for (const name of ["rc-fruits", "rc-notes", "rc-colors", "rc-fetch"]) {
      const ext = await registry.installRaycastFolder(path.join(fixtures, name));
      expect(ext.manifest?.runtime).toBe("raycast");
      expect(ext.errors).toBeUndefined();
      expect(ext.source).toEqual({ kind: "raycast-folder", path: path.join(fixtures, name) });
    }
    const dir = path.join(tmp, "data/installed/rc-fruits");
    expect(fs.existsSync(path.join(dir, ".glide-build/browse-fruits.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "assets/extension-icon.png"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "src"))).toBe(false);
    const bundle = fs.readFileSync(path.join(dir, ".glide-build/browse-fruits.cjs"), "utf8");
    expect(bundle).toMatch(/require\("@raycast\/api"\)/);
    expect(bundle).toMatch(/require\("react\/jsx-runtime"\)/);
  });

  it("resolves the folder's own node_modules and reports missing ones", async () => {
    const src = path.join(tmp, "own-deps");
    fs.mkdirSync(path.join(src, "src"), { recursive: true });
    fs.mkdirSync(path.join(src, "node_modules/tiny-dep"), { recursive: true });
    fs.writeFileSync(path.join(src, "node_modules/tiny-dep/package.json"), JSON.stringify({ name: "tiny-dep", main: "index.js" }));
    fs.writeFileSync(path.join(src, "node_modules/tiny-dep/index.js"), "exports.shout = (s) => s.toUpperCase() + '!';");
    const pkg = { name: "own-deps", title: "Own Deps", commands: [{ name: "hello", title: "Hello", mode: "view" }], dependencies: { "@raycast/api": "1", "tiny-dep": "1" } };
    fs.writeFileSync(path.join(src, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(path.join(src, "src/hello.tsx"), `import { Detail } from "@raycast/api";\nimport { shout } from "tiny-dep";\nexport default function C() { return <Detail markdown={shout("hi")} />; }\n`);
    const ext = await registry.installRaycastFolder(src);
    expect(fs.readFileSync(path.join(ext.dir, ".glide-build/hello.cjs"), "utf8")).toMatch(/toUpperCase/);

    fs.writeFileSync(path.join(src, "src/hello.tsx"), `import { Detail } from "@raycast/api";\nimport pad from "left-pad";\nexport default function C() { return <Detail markdown={pad("x", 3)} />; }\n`);
    await expect(registry.installRaycastFolder(src)).rejects.toThrow(/Missing dependency "left-pad".*npm install/s);
  });

  it("uses a pre-built dist/<command>.js when there is no source", async () => {
    const src = path.join(tmp, "prebuilt");
    fs.mkdirSync(path.join(src, "dist"), { recursive: true });
    fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "prebuilt", title: "Prebuilt", commands: [{ name: "go", title: "Go", mode: "no-view" }], dependencies: { "@raycast/api": "1" } }));
    fs.writeFileSync(path.join(src, "dist/go.js"), `module.exports = { default: async () => {} };`);
    const translated = translateRaycastManifest(JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")));
    if (!translated.ok) throw new Error(translated.errors.join("\n"));
    const res = await buildRaycastCommands(src, path.join(tmp, "prebuilt-out"), translated.manifest, null);
    expect(res).toEqual({ built: ["go"], errors: [] });
    expect(readManifest(path.join(tmp, "prebuilt")).manifest?.commands[0].entry).toBe("dist/go.js");
  });
});

// --- running imported commands in a real child process -----------------------------------------------

interface Running {
  views: Map<number, ViewModel>;
  messages: ChildMessage[];
  requests: Array<{ method: string; params: JsonValue[] }>;
  manager: SessionManager;
  id: string;
  waitFor<T>(pred: () => T | undefined | false, ms?: number): Promise<T>;
  invoke(depth: number, handler: string, args?: JsonValue[]): void;
}

function start(ext: string, command: string, prefs: Record<string, string | boolean> = {}, args: Record<string, string> = {}): Running {
  const installed = registry.get(ext)!;
  const cmd = installed.manifest!.commands.find((c) => c.name === command)!;
  const views = new Map<number, ViewModel>();
  const messages: ChildMessage[] = [];
  const requests: Running["requests"] = [];
  const manager = new SessionManager({
    spawn: () => {
      const child = fork(path.join(runtimeDir, "raycast-runner.cjs"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      return {
        postMessage: (m: ParentMessage) => child.send(m),
        onMessage: (cb) =>
          child.on("message", (m: ChildMessage) => {
            messages.push(m);
            cb(m);
          }),
        onExit: (cb) => child.on("exit", cb),
        kill: () => void child.kill(),
      };
    },
    onRequest: async (_s, method, params) => {
      requests.push({ method, params });
      if (method === "storage.get") return store[String(params[0])] ?? null;
      if (method === "storage.set") store[String(params[0])] = params[1] ?? null;
      if (method === "confirmAlert") return true;
      return null;
    },
    emit: (e) => {
      if (e.view && e.depth !== undefined) views.set(e.depth, e.view);
    },
    log: () => undefined,
  });
  const init: InitPayload = {
    commandPath: path.join(installed.dir, cmd.entry),
    apiPath: "",
    runtime: "raycast",
    shimDir: runtimeDir,
    arguments: args,
    preferences: { ...resolvePreferences(installed.manifest!, {}, command), ...prefs },
    environment: { extensionName: ext, extensionTitle: installed.manifest!.title, commandName: command, commandMode: cmd.mode, assetsPath: path.join(installed.dir, "assets"), extensionPath: installed.dir, supportPath: registry.supportDir(ext), glideVersion: "test" },
  };
  const info = manager.start({ extName: ext, extTitle: ext, commandName: command, commandTitle: command, mode: cmd.mode, runtime: "raycast" }, init);
  manager.mountView(info.id, 0);
  running.push(manager);
  return {
    views,
    messages,
    requests,
    manager,
    id: info.id,
    async waitFor(pred, ms = 3000) {
      const until = Date.now() + ms;
      for (;;) {
        const v = pred();
        if (v) return v as never;
        if (Date.now() > until) throw new Error(`timed out waiting for ${String(pred).slice(0, 300)}; views: ${JSON.stringify([...views.entries()].map(([d, v]) => [d, v.type, "items" in v ? v.items.length : 0, "pagination" in v ? v.pagination : null]))}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    invoke(depth, handler, a = []) {
      manager.invoke(info.id, depth, handler, a);
    },
  };
}

const store: Record<string, JsonValue> = {};
const running: SessionManager[] = [];
afterAll(() => running.forEach((m) => m.killAll()));

describe("Raycast commands in a child process", () => {
  beforeAll(async () => {
    if (!registry.get("rc-fruits")) for (const n of ["rc-fruits", "rc-notes", "rc-colors", "rc-fetch"]) await registry.installRaycastFolder(path.join(fixtures, n));
  });

  it("renders the fruit List, pushes a Detail and pops it", async () => {
    const r = start("rc-fruits", "browse-fruits", { greeting: "Hello" });
    const list = await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "list" && v.items.length ? v : undefined;
    });
    expect(list.items.map((i) => i.id)).toEqual(["apple", "cherry", "strawberry", "banana", "lemon", "kiwi", "pear"]);
    expect(list.items[0].section).toBe("Red Fruits");
    expect(list.items[0].accessories[0]).toEqual({ text: "$1.20", color: "#22C55E" });
    expect(list.items[0].accessories[1]).toEqual({ icon: "#EF4444" });
    expect(list.dropdown?.options).toHaveLength(4);
    expect(list.emptyView?.title).toBe("No fruit left");
    const actions = list.items[0].actions;
    expect(actions.map((a) => [a.kind, a.title, a.shortcut ?? null])).toEqual([
      ["push", "Show Fruit", null],
      ["run", "Show Details", "⌘D"],
      ["copy", "Copy Name", "⇧⌘C"],
      ["run", "Eat Fruit", "⌃X"],
    ]);
    // dropdown filters through React state
    r.invoke(0, list.dropdown!.handler!, ["Yellow"]);
    await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "list" && v.items.length === 2 ? v : undefined;
    });
    r.invoke(0, list.dropdown!.handler!, ["all"]);
    // Items re-mounted by the filter get fresh handler ids: always act on the latest view.
    const again = await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "list" && v.items.length === 7 ? v : undefined;
    });
    const fresh = again.items[0].actions;
    // Push → depth 1 Detail with metadata
    r.invoke(0, fresh[0].handler!);
    const detail = await r.waitFor(() => {
      const v = r.views.get(1);
      return v?.type === "detail" ? v : undefined;
    });
    expect(detail.markdown).toContain("Hello, **Apple**!");
    expect(detail.metadata.map((m) => m.kind)).toEqual(["label", "tags", "separator", "link"]);
    r.invoke(1, detail.actions[1].handler!);
    await r.waitFor(() => r.messages.some((m) => m.type === "pop" && m.depth === 1));
    // Eat Fruit removes the item and shows a toast
    r.invoke(0, fresh[3].handler!);
    await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "list" && !v.items.some((i) => i.id === "apple") ? v : undefined;
    });
    await r.waitFor(() => r.requests.some((q) => q.method === "showToast" && q.params[1] === "Ate Apple"));
  });

  it("runs a no-view command with arguments", async () => {
    const r = start("rc-fruits", "copy-fruit", {}, { fruit: "Kiwi" });
    const res = await r.manager.completion(r.id);
    expect(res.ok).toBe(true);
    expect(r.requests.map((q) => q.method)).toEqual(["clipboard.copy", "showHUD"]);
    expect(r.requests[0].params).toEqual(["🍽️ Kiwi"]);
  });

  it("validates and submits the notes Form, then lists the saved note", async () => {
    const r = start("rc-notes", "new-note");
    const form = await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "form" ? v : undefined;
    });
    expect(form.fields.map((f) => f.type)).toEqual(["description", "text", "textarea", "separator", "checkbox", "dropdown", "date", "tags"]);
    const submit = form.actions![0];
    expect(submit).toMatchObject({ kind: "submit", title: "Save Note" });
    r.invoke(0, submit.handler!, [{ title: "", body: "" }]);
    const invalid = await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "form" && v.fields[1].error ? v : undefined;
    });
    expect(invalid.fields[1].error).toBe("The item is required");
    r.invoke(0, form.fields[1].changeHandler!, ["Groceries"]);
    await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "form" && v.fields[1].value === "Groceries" && !v.fields[1].error;
    });
    r.invoke(0, submit.handler!, [{ title: "Groceries", body: "milk", pinned: true, priority: "high", due: "2026-10-21T00:00:00.000Z", tags: ["home"] }]);
    const saved = await r.waitFor(() => {
      const v = r.views.get(1);
      return v?.type === "detail" ? v : undefined;
    });
    expect(saved.markdown).toContain("Groceries");
    const toasts = r.requests.filter((q) => q.method === "showToast").map((q) => q.params.slice(0, 2));
    expect(toasts[0]).toEqual(["animated", "Saving note…"]);
    await r.waitFor(() => r.requests.some((q) => q.method === "showToast" && q.params[1] === 'Saved "Groceries"'));
    const notes = JSON.parse(String(store.notes));
    expect(notes[0]).toMatchObject({ title: "Groceries", pinned: true, priority: "high", tags: ["home"], due: "2026-10-21T00:00:00.000Z" });

    const l = start("rc-notes", "list-notes");
    const list = await l.waitFor(() => {
      const v = l.views.get(0);
      return v?.type === "list" && v.items.length ? v : undefined;
    });
    expect(list.items[0]).toMatchObject({ title: "Groceries", subtitle: "milk", accessories: [{ tag: "high" }, { text: "#home" }] });
    l.invoke(0, list.items[0].actions[1].handler!);
    await l.waitFor(() => {
      const v = l.views.get(0);
      return v?.type === "list" && v.items.length === 0 ? v : undefined;
    });
    expect(l.requests.some((q) => q.method === "confirmAlert")).toBe(true);
  });

  it("renders the Grid with sections, colours and emoji", async () => {
    const r = start("rc-colors", "color-grid");
    const grid = await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "grid" ? v : undefined;
    });
    expect(grid.columns).toBe(4);
    expect(grid.inset).toBe("sm");
    expect(grid.items[0]).toMatchObject({ id: "Tomato", content: "#FF6347", section: "Colours", subtitle: "#FF6347" });
    expect(grid.items.at(-1)).toMatchObject({ content: "🍇", section: "Fruit" });
    expect(grid.title).toBe("Last copied: none");
    const copy = grid.items[0].actions[1];
    expect(copy).toMatchObject({ kind: "copy", text: "#FF6347" });
    r.invoke(0, copy.callback!);
    await r.waitFor(() => {
      const v = r.views.get(0);
      return v?.type === "grid" && v.title === "Last copied: #FF6347";
    });
  });

  it("useFetch loads, searches and paginates from a local 127.0.0.1 server", async () => {
    const all = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, name: `${i % 2 ? "Beta" : "Alpha"} ${i}`, kind: i % 2 ? "odd" : "even" }));
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      hits.push(u.pathname + u.search);
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      const page = Number(u.searchParams.get("page") ?? 0);
      const matches = all.filter((x) => x.name.toLowerCase().includes(q));
      const items = matches.slice(page * 10, page * 10 + 10);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items, hasMore: (page + 1) * 10 < matches.length }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const r = start("rc-fetch", "search-items", { baseUrl: `http://127.0.0.1:${port}` });
      const first = await r.waitFor(() => {
        const v = r.views.get(0);
        return v?.type === "list" && v.items.length === 10 && !v.isLoading ? v : undefined;
      });
      expect(first.pagination).toMatchObject({ hasMore: true });
      expect(first.filtering).toBe(false);
      r.invoke(0, first.pagination!.handler!);
      await r.waitFor(() => {
        const v = r.views.get(0);
        return v?.type === "list" && v.items.length === 20 ? v : undefined;
      });
      r.invoke(0, first.searchHandler!, ["beta"]);
      const searched = await r.waitFor(() => {
        const v = r.views.get(0);
        return v?.type === "list" && !v.isLoading && v.items.length && v.items.every((i) => i.title.startsWith("Beta")) ? v : undefined;
      });
      expect(searched.items).toHaveLength(10);
      expect(hits).toContain("/items?q=beta&page=0");
      expect(hits).toContain("/items?q=&page=1");
    } finally {
      server.close();
    }
  });
});
