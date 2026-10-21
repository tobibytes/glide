import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, isNewer, resolveStoreUrl, StoreIndexError, validateIndex } from "./store-schema";

const good = {
  id: "demo",
  name: "demo",
  title: "Demo",
  description: "A demo",
  author: "me",
  version: "1.2.3",
  categories: ["Developer Tools"],
  kind: "glide",
  minGlideVersion: "0.2.0",
  commands: [{ name: "run", title: "Run Demo", mode: "view" }],
  download: { url: "demo-1.2.3.tgz", sha256: "a".repeat(64), size: 100 },
  changelog: [
    { version: "1.0.0", notes: "first" },
    { version: "1.2.3", notes: "latest" },
  ],
};

describe("store index schema", () => {
  it("accepts the repository's store/index.json (5 bundled examples)", () => {
    const json = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../store/index.json"), "utf8"));
    const { index, errors } = validateIndex(json);
    expect(errors).toEqual([]);
    expect(index.extensions.map((e) => e.id).sort()).toEqual(["color-converter", "github-search", "hacker-news", "timezones", "uuid-generator"]);
    expect(index.extensions.every((e) => e.source?.bundled === true && !e.download)).toBe(true);
  });

  it("parses a valid entry and sorts its changelog newest first", () => {
    const { index, errors } = validateIndex({ schemaVersion: 1, extensions: [good] });
    expect(errors).toEqual([]);
    expect(index.extensions[0]!.changelog.map((c) => c.version)).toEqual(["1.2.3", "1.0.0"]);
  });

  it("rejects unusable documents", () => {
    expect(() => validateIndex([])).toThrow(StoreIndexError);
    expect(() => validateIndex({ extensions: [] })).toThrow(/schemaVersion/);
    expect(() => validateIndex({ schemaVersion: 2, extensions: [] })).toThrow(/update Glide/);
    expect(() => validateIndex({ schemaVersion: 1 })).toThrow(/extensions/);
  });

  it("drops invalid entries with reasons and keeps the rest", () => {
    const bad = [
      { ...good, id: "Bad ID" },
      { ...good, id: "nov", version: "1.0" },
      { ...good, id: "nodl", download: undefined },
      { ...good, id: "badsha", download: { ...good.download, sha256: "xyz" } },
      { ...good, id: "huge", download: { ...good.download, size: 10 ** 9 } },
      { ...good, id: "kind", kind: "vscode" },
      { ...good, id: "nocmd", commands: [] },
      { ...good, id: "js", download: { ...good.download, url: "javascript:alert(1)" } },
      { ...good, id: "src", download: undefined, source: { bundled: true, path: "../etc" } },
      { ...good, id: "nomin", minGlideVersion: undefined },
      good,
      { ...good, title: "dupe" },
    ];
    const { index, errors } = validateIndex({ schemaVersion: 1, extensions: bad });
    expect(index.extensions.map((e) => e.id)).toEqual(["demo"]);
    expect(new Set(errors.map((e) => /\(([^)]+)\)/.exec(e)?.[1])).size).toBe(11);
    expect(errors.join("\n")).toMatch(/duplicate/);
  });

  it("accepts a bundled source without a download", () => {
    const { index } = validateIndex({ schemaVersion: 1, extensions: [{ ...good, download: undefined, source: { bundled: true, path: "uuid-generator" } }] });
    expect(index.extensions[0]!.source).toEqual({ bundled: true, path: "uuid-generator" });
  });
});

describe("version compare", () => {
  it("orders semver including pre-releases", () => {
    const sorted = ["1.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "0.9.12", "1.0.0-alpha.beta", "1.10.0", "1.2.0", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-rc.1"].sort(compareVersions);
    expect(sorted).toEqual(["0.9.12", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.2.0", "1.10.0"]);
  });
  it("ignores build metadata and a leading v; invalid sorts lowest", () => {
    expect(compareVersions("v1.2.3", "1.2.3+build.5")).toBe(0);
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(compareVersions("garbage", "0.0.1")).toBe(-1);
  });
});

describe("store URLs", () => {
  it("allows https and loopback http only", () => {
    expect(resolveStoreUrl("https://example.com/i.json").href).toBe("https://example.com/i.json");
    expect(resolveStoreUrl("pkg/a.tgz", "http://127.0.0.1:9/store/index.json").href).toBe("http://127.0.0.1:9/store/pkg/a.tgz");
    expect(() => resolveStoreUrl("http://example.com/i.json")).toThrow(/https/);
    expect(() => resolveStoreUrl("file:///etc/passwd")).toThrow();
    expect(() => resolveStoreUrl("https://u:p@example.com/x")).toThrow(/credentials/);
  });
});
