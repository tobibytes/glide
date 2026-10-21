import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionRegistry, readManifest } from "./registry";
import { sha256, type Fetcher } from "./store-client";
import { StoreService } from "./store-service";
import { createTgz } from "./store-tar";

const EXAMPLES = path.resolve(__dirname, "../../../../extensions-examples");
const LOCAL_INDEX = path.resolve(__dirname, "../../../../store/index.json");
const INDEX_URL = "http://127.0.0.1:1/store/index.json";

function pkgTgz(version: string, name = "demo-ext") {
  const pkg = { name, version, glide: { title: "Demo Ext", description: "demo", commands: [{ name: "hello", title: "Say Hello", mode: "no-view" }] } };
  return createTgz([
    { path: "package/package.json", data: JSON.stringify(pkg) },
    { path: "package/dist/hello.js", data: "module.exports = async () => {};" },
  ]);
}

function entry(version: string, tgz: Buffer, extra: Record<string, unknown> = {}) {
  return {
    id: "demo-ext",
    name: "demo-ext",
    title: "Demo Ext",
    description: "demo",
    author: "tester",
    version,
    categories: ["Testing"],
    kind: "glide",
    minGlideVersion: "0.1.0",
    commands: [{ name: "hello", title: "Say Hello" }],
    download: { url: `pkg/demo-ext-${version}.tgz`, sha256: sha256(tgz), size: tgz.length },
    changelog: [{ version, notes: `notes ${version}` }],
    ...extra,
  };
}

let dir: string;
let files: Map<string, Buffer>;
let requests: string[];
let index: unknown;
const fetcher: Fetcher = async (url) => {
  requests.push(url);
  if (url === INDEX_URL) return new Response(JSON.stringify(index), { headers: { "content-type": "application/json" } });
  const body = files.get(url);
  return body ? new Response(new Uint8Array(body)) : new Response("nope", { status: 404 });
};

function service(over: Partial<ConstructorParameters<typeof StoreService>[0]> = {}) {
  const reg = new ExtensionRegistry(path.join(dir, "ext"));
  const changes: string[] = [];
  const svc = new StoreService({
    registry: () => reg,
    readManifest,
    dataDir: () => path.join(dir, "ext"),
    examplesDir: () => EXAMPLES,
    localIndexPath: () => LOCAL_INDEX,
    indexUrl: () => INDEX_URL,
    mayFetch: () => null,
    appVersion: () => "0.2.0",
    changed: () => void changes.push("changed"),
    beforeUninstall: () => undefined,
    log: () => undefined,
    fetcher,
    ...over,
  });
  return { svc, reg, changes };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-store-"));
  files = new Map();
  requests = [];
  const v1 = pkgTgz("1.0.0");
  files.set("http://127.0.0.1:1/store/pkg/demo-ext-1.0.0.tgz", v1);
  index = { schemaVersion: 1, extensions: [entry("1.0.0", v1)] };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("StoreService", () => {
  it("lists bundled examples plus the remote index, with categories", async () => {
    const { svc } = service();
    const st = await svc.list(false);
    expect(st.items.map((i) => i.id)).toEqual(expect.arrayContaining(["uuid-generator", "timezones", "demo-ext"]));
    expect(st.items.find((i) => i.id === "uuid-generator")).toMatchObject({ origin: "bundled", via: "bundled", installed: false });
    expect(st.items.find((i) => i.id === "demo-ext")).toMatchObject({ origin: "remote", via: "download", size: expect.any(Number) });
    expect(st.categories).toContain("Testing");
  });

  it("caches the index: opening again does not refetch, Refresh does", async () => {
    const { svc } = service();
    await svc.list(false);
    await svc.list(false);
    expect(requests.filter((u) => u === INDEX_URL)).toHaveLength(1);
    await svc.list(true);
    expect(requests.filter((u) => u === INDEX_URL)).toHaveLength(2);
    // A new service instance (app restart) reads the disk cache.
    const again = await service().svc.list(false);
    expect(again.fromCache).toBe(true);
    expect(requests.filter((u) => u === INDEX_URL)).toHaveLength(2);
  });

  it("keeps the cached index and reports an error when offline", async () => {
    await service().svc.list(true);
    const { svc } = service({ fetcher: async () => Promise.reject(new Error("offline")), maxCacheAgeMs: 0 });
    const st = await svc.list(true);
    expect(st.error).toMatch(/offline/);
    expect(st.items.some((i) => i.id === "demo-ext")).toBe(true);
  });

  it("refuses to install without confirmation", async () => {
    const { svc } = service();
    await expect(svc.install("demo-ext", false)).rejects.toThrow(/confirmed/);
  });

  it("installs a bundled example without network", async () => {
    const { svc, reg } = service({ fetcher: async () => Promise.reject(new Error("no network")) });
    await svc.list(false);
    const res = await svc.install("uuid-generator", true);
    expect(res.firstCommand).toBe("Generate UUID");
    expect(reg.get("uuid-generator")?.source).toEqual({ kind: "store", name: "uuid-generator" });
    expect((await svc.list(false)).items.find((i) => i.id === "uuid-generator")).toMatchObject({ installed: true, installedFromStore: true });
  });

  it("downloads, verifies, installs, updates and uninstalls", async () => {
    const { svc, reg, changes } = service();
    await svc.list(false);
    await svc.install("demo-ext", true);
    expect(reg.get("demo-ext")?.manifest?.version).toBe("1.0.0");
    expect(fs.existsSync(path.join(reg.installedDir, "demo-ext", "dist", "hello.js"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "ext", "store-tmp"))).toEqual([]);

    const v2 = pkgTgz("1.1.0");
    files.set("http://127.0.0.1:1/store/pkg/demo-ext-1.1.0.tgz", v2);
    index = { schemaVersion: 1, extensions: [entry("1.1.0", v2)] };
    const st = await svc.list(true);
    expect(st.items.find((i) => i.id === "demo-ext")).toMatchObject({ installedVersion: "1.0.0", version: "1.1.0", updateAvailable: true });
    await svc.install("demo-ext", true, "update");
    expect(reg.get("demo-ext")?.manifest?.version).toBe("1.1.0");
    await expect(svc.install("demo-ext", true, "update")).rejects.toThrow(/up to date/);

    svc.uninstall("demo-ext");
    expect(reg.get("demo-ext")).toBeUndefined();
    expect(changes.length).toBe(3);
  });

  it("rejects a sha256 mismatch and leaves nothing installed", async () => {
    const tampered = pkgTgz("1.0.0");
    tampered[tampered.length - 5]! ^= 0xff;
    files.set("http://127.0.0.1:1/store/pkg/demo-ext-1.0.0.tgz", tampered);
    const { svc, reg } = service();
    await svc.list(false);
    await expect(svc.install("demo-ext", true)).rejects.toThrow(/Checksum mismatch/);
    expect(reg.get("demo-ext")).toBeUndefined();
  });

  it("rejects a size mismatch", async () => {
    files.set("http://127.0.0.1:1/store/pkg/demo-ext-1.0.0.tgz", Buffer.concat([pkgTgz("1.0.0"), Buffer.from("extra")]));
    const { svc } = service();
    await svc.list(false);
    await expect(svc.install("demo-ext", true)).rejects.toThrow(/larger than expected|size mismatch/);
  });

  it("rejects a package that is not the advertised extension", async () => {
    const other = pkgTgz("1.0.0", "someone-else");
    files.set("http://127.0.0.1:1/store/pkg/demo-ext-1.0.0.tgz", other);
    index = { schemaVersion: 1, extensions: [entry("1.0.0", other)] };
    const { svc, reg } = service();
    await svc.list(false);
    await expect(svc.install("demo-ext", true)).rejects.toThrow(/"someone-else"/);
    expect(reg.list()).toEqual([]);
  });

  it("rejects a malicious tarball (path traversal) without writing outside", async () => {
    const evil = createTgz([
      { path: "package/package.json", data: "{}" },
      { path: "package/../../../escape.txt", data: "pwned" },
    ]);
    files.set("http://127.0.0.1:1/store/pkg/demo-ext-1.0.0.tgz", evil);
    index = { schemaVersion: 1, extensions: [entry("1.0.0", evil)] };
    const { svc } = service();
    await svc.list(false);
    await expect(svc.install("demo-ext", true)).rejects.toThrow(/traversal/);
    expect(fs.existsSync(path.join(dir, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "ext", "escape.txt"))).toBe(false);
  });

  it("marks extensions needing a newer Glide as unavailable", async () => {
    const v1 = files.get("http://127.0.0.1:1/store/pkg/demo-ext-1.0.0.tgz")!;
    index = { schemaVersion: 1, extensions: [entry("1.0.0", v1, { minGlideVersion: "9.0.0" })] };
    const { svc } = service();
    const st = await svc.list(false);
    expect(st.items.find((i) => i.id === "demo-ext")?.unavailable).toMatch(/9\.0\.0/);
    await expect(svc.install("demo-ext", true)).rejects.toThrow(/Requires Glide/);
  });

  it("does not fetch when the host forbids it (headless + public URL)", async () => {
    const { svc } = service({ mayFetch: () => "blocked in headless mode" });
    const st = await svc.list(true);
    expect(requests).toEqual([]);
    expect(st.error).toMatch(/headless/);
    expect(st.items.some((i) => i.id === "uuid-generator")).toBe(true);
  });
});
