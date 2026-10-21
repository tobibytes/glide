import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { API_SHIM_SOURCE, buildRunnerSource } from "../../../extension-api/runtime";
import type { ChildMessage, JsonValue, ParentMessage } from "../../../extension-api/types";
import { resolvePreferences } from "./manifest";
import { ExtensionRegistry, readManifest } from "./registry";
import { SessionManager } from "./sessions";
import { bundledIndex, parseIndex } from "./store-index";

const examples = path.resolve(__dirname, "../../../../extensions-examples");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glide-ext-examples-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
fs.writeFileSync(path.join(tmp, "runner.cjs"), buildRunnerSource());
fs.writeFileSync(path.join(tmp, "glide-api.cjs"), API_SHIM_SOURCE);

describe("bundled store", () => {
  it("lists every example with a valid manifest", () => {
    const names = bundledIndex(examples).map((e) => e.name);
    expect(names).toEqual(["color-converter", "github-search", "hacker-news", "timezones", "uuid-generator"]);
    for (const n of names) expect(readManifest(path.join(examples, n)).errors).toBeUndefined();
  });

  it("parses a remote index and drops invalid entries", () => {
    const list = parseIndex([
      { name: "ok", title: "OK", repo: "https://github.com/a/b.git", commands: ["one", { name: "two", title: "Two" }] },
      { name: "bad name!", repo: "https://x" },
      { name: "norepo" },
      { name: "evil", repo: "--upload-pack=touch /tmp/x" },
    ]);
    expect(list.map((e) => e.name)).toEqual(["ok"]);
    expect(list[0].commands).toEqual([{ name: "one", title: "one" }, { name: "two", title: "Two", description: undefined }]);
  });
});

describe("registry", () => {
  it("installs from a folder, toggles, stores prefs and uninstalls", () => {
    const reg = new ExtensionRegistry(path.join(tmp, "data"));
    const ext = reg.installFromFolder(path.join(examples, "uuid-generator"), { kind: "store", name: "uuid-generator" });
    expect(ext.manifest?.title).toBe("UUID Generator");
    expect(fs.existsSync(path.join(tmp, "data/installed/uuid-generator/generate-uuid.js"))).toBe(true);
    reg.setEnabled("uuid-generator", false);
    expect(reg.get("uuid-generator")?.enabled).toBe(false);
    reg.setPreferences("uuid-generator", { uppercase: true });
    expect(reg.getPreferences("uuid-generator")).toEqual({ uppercase: true });
    reg.storageWrite("uuid-generator", (d) => void (d.a = 1));
    expect(reg.storageAll("uuid-generator")).toEqual({ a: 1 });
    reg.uninstall("uuid-generator");
    expect(reg.list()).toEqual([]);
  });

  it("refuses an invalid folder", () => {
    const bad = path.join(tmp, "bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "package.json"), JSON.stringify({ name: "bad", glide: { title: "Bad", commands: [{ name: "x", title: "X" }] } }));
    const reg = new ExtensionRegistry(path.join(tmp, "data2"));
    expect(() => reg.installFromFolder(bad, { kind: "folder", path: bad })).toThrow(/no entry file/);
  });
});

function run(ext: string, args: Record<string, string> = {}) {
  const dir = path.join(examples, ext);
  const manifest = readManifest(dir).manifest!;
  const cmd = manifest.commands[0];
  const requests: Array<[string, JsonValue[]]> = [];
  const m = new SessionManager({
    spawn: () => {
      const child = fork(path.join(tmp, "runner.cjs"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      return {
        postMessage: (msg: ParentMessage) => child.send(msg),
        onMessage: (cb) => child.on("message", (x) => cb(x as ChildMessage)),
        onExit: (cb) => child.on("exit", cb),
        kill: () => void child.kill(),
      };
    },
    onRequest: async (_i, method, params) => void requests.push([method, params]),
    emit: () => undefined,
    log: () => undefined,
  });
  const info = m.start(
    { extName: ext, extTitle: manifest.title, commandName: cmd.name, commandTitle: cmd.title, mode: cmd.mode },
    {
      commandPath: path.join(dir, cmd.entry),
      apiPath: path.join(tmp, "glide-api.cjs"),
      arguments: args,
      preferences: resolvePreferences(manifest, {}),
      environment: { extensionName: ext, extensionTitle: manifest.title, commandName: cmd.name, commandMode: cmd.mode, assetsPath: dir, extensionPath: dir, supportPath: tmp, glideVersion: "0" },
    },
  );
  return { m, info, requests };
}

describe("examples run end to end (no network)", () => {
  it("uuid-generator copies a UUID and shows a HUD", async () => {
    const { m, info, requests } = run("uuid-generator");
    expect(await m.completion(info.id)).toEqual({ ok: true });
    expect(requests[0][0]).toBe("clipboard.copy");
    expect(String(requests[0][1][0])).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1]).toEqual(["showHUD", [`Copied ${requests[0][1][0]}`]]);
    m.killAll();
  });

  it("color-converter converts typed colors", async () => {
    const { m, info } = run("color-converter", { color: "#ff8800" });
    await vi.waitFor(() => expect(m.view(info.id, 0)).toBeTruthy());
    let v = m.view(info.id, 0)!;
    expect(v.type === "list" && v.items.map((i) => i.title).slice(0, 3)).toEqual(["#ff8800", "rgb(255, 136, 0)", "hsl(32, 100%, 50%)"]);
    m.invoke(info.id, 0, v.type === "list" ? v.searchHandler! : "", ["hsl(0, 100%, 50%)"]);
    await vi.waitFor(() => {
      v = m.view(info.id, 0)!;
      expect(v.type === "list" && v.items[0].title).toBe("#ff0000");
    });
    m.killAll();
  });

  it("timezones lists cities", async () => {
    const { m, info } = run("timezones");
    await vi.waitFor(() => expect(m.view(info.id, 0)).toBeTruthy());
    const v = m.view(info.id, 0)!;
    expect(v.type === "list" && v.items.some((i) => i.title === "Tokyo" && i.accessories.some((a) => /^\d\d:\d\d$/.test(a.text ?? "")))).toBe(true);
    m.killAll();
  });
});
