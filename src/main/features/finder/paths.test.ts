import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeFolder, createEmptyFile, listApps, moveItems } from "./ops";
import { commonParent, compressPlan, expandPath, formatPaths, hereFolder, movePlan, openWithSteps, terminalSteps, uniqueName, validateFileName } from "./paths";

const HOME = "/Users/me";

describe("path formatting and planning", () => {
  it("formats paths", () => {
    const p = ["/Users/me/a b.txt", "/tmp/x"];
    expect(formatPaths(p, "posix", HOME)).toBe("/Users/me/a b.txt\n/tmp/x");
    expect(formatPaths(p, "tilde", HOME)).toBe("~/a b.txt\n/tmp/x");
    expect(formatPaths(["/Users/me/it's"], "quoted", HOME)).toBe(`'/Users/me/it'\\''s'`);
    expect(formatPaths(p, "quoted", HOME)).toBe(`'/Users/me/a b.txt' /tmp/x`);
    expect(formatPaths(["/Users/me/a b#.txt"], "url", HOME)).toBe("file:///Users/me/a%20b%23.txt");
  });

  it("finds 'here'", () => {
    const dirs = new Set(["/p/dir"]);
    expect(hereFolder(["/p/dir", "/p/f"], null, (x) => dirs.has(x))).toBe("/p/dir");
    expect(hereFolder(["/p/f.txt"], null, () => false)).toBe("/p");
    expect(hereFolder([], "/win", () => false)).toBe("/win");
    expect(hereFolder([], null, () => false)).toBeNull();
  });

  it("terminal commands", () => {
    expect(terminalSteps("Terminal", "/a b")).toEqual([{ cmd: "/usr/bin/open", args: ["-a", "Terminal", "/a b"] }]);
    expect(terminalSteps("iTerm", "/x")[0]!.args).toEqual(["-a", "iTerm", "/x"]);
    expect(terminalSteps("Ghostty", "/x")[0]!.args).toEqual(["-na", "Ghostty", "--args", "--working-directory=/x"]);
    expect(openWithSteps("/Applications/TextEdit.app", ["/a", "/b"])[0]!.args).toEqual(["-a", "/Applications/TextEdit.app", "/a", "/b"]);
  });

  it("names", () => {
    expect(validateFileName("")).toMatch(/Type/);
    expect(validateFileName("a/b")).toMatch(/\//);
    expect(validateFileName("..")).toMatch(/reserved/);
    expect(validateFileName("ok.txt")).toBeNull();
    const taken = new Set(["notes.txt", "notes 2.txt", "README", ".env"]);
    expect(uniqueName("notes.txt", (c) => taken.has(c))).toBe("notes 3.txt");
    expect(uniqueName("README", (c) => taken.has(c))).toBe("README 2");
    expect(uniqueName(".env", (c) => taken.has(c))).toBe(".env 2");
    expect(uniqueName("fresh.md", (c) => taken.has(c))).toBe("fresh.md");
  });

  it("compress plans", () => {
    expect(commonParent(["/a/b/c.txt", "/a/b/d/e.txt", "/a/b/f"])).toBe("/a/b");
    expect(commonParent(["/a/x", "/b/y"])).toBe("/");
    const one = compressPlan(["/p/Report.pdf"], (p) => p === "/p/Report.pdf.zip")!;
    expect(one.output).toBe("/p/Report.pdf 2.zip");
    expect(one.steps[0]).toEqual({ cmd: "/usr/bin/ditto", args: ["-c", "-k", "--sequesterRsrc", "--keepParent", "/p/Report.pdf", "/p/Report.pdf 2.zip"] });
    const many = compressPlan(["/p/a.txt", "/p/sub/b.txt"], () => false)!;
    expect(many.output).toBe("/p/Archive.zip");
    expect(many.steps[0]).toEqual({ cmd: "/usr/bin/zip", args: ["-r", "-y", "-X", "-q", "/p/Archive.zip", "a.txt", "sub/b.txt"], cwd: "/p" });
    expect(compressPlan([], () => false)).toBeNull();
  });

  it("move plans refuse overwrites and self-moves", () => {
    const exists = (p: string) => p === "/dest/taken.txt";
    const plan = movePlan(["/src/a.txt", "/src/taken.txt", "/dest/already.txt", "/dest"], "/dest/", exists);
    expect(plan.moves).toEqual([{ from: "/src/a.txt", to: "/dest/a.txt" }]);
    expect(plan.skipped).toEqual(["/dest/already.txt"]);
    expect(plan.conflicts).toHaveLength(2);
    expect(movePlan(["/a/folder"], "/a/folder/inner", () => false).conflicts[0]).toMatch(/into itself/);
  });

  it("expands typed paths", () => {
    expect(expandPath("~", HOME, "/w")).toBe(HOME);
    expect(expandPath("~/Projects", HOME, "/w")).toBe("/Users/me/Projects");
    expect(expandPath("../x", HOME, "/w/sub")).toBe("/w/x");
    expect(expandPath("/abs", HOME, "/w")).toBe("/abs");
  });
});

describe("file operations (temp dir)", () => {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(process.env.GLIDE_TEST_TMP ?? os.tmpdir(), "glide-finder-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates empty files without overwriting", async () => {
    const a = await createEmptyFile(dir, "new.txt");
    expect(a.ok).toBe(true);
    fs.writeFileSync(a.path!, "keep");
    const b = await createEmptyFile(dir, "new.txt");
    expect(b.path).toBe(path.join(dir, "new 2.txt"));
    expect(fs.readFileSync(a.path!, "utf8")).toBe("keep");
    expect((await createEmptyFile(dir, "bad/name")).ok).toBe(false);
    expect((await createEmptyFile(path.join(dir, "missing"), "x")).error).toMatch(/no longer exists/);
  });

  it("moves items and refuses conflicts as a batch", async () => {
    const src = path.join(dir, "src");
    const dest = path.join(dir, "dest");
    fs.mkdirSync(src);
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(src, "one.txt"), "1");
    fs.mkdirSync(path.join(src, "folder"));
    fs.writeFileSync(path.join(src, "folder", "inner.txt"), "i");
    const ok = await moveItems([path.join(src, "one.txt"), path.join(src, "folder")], dest);
    expect(ok.ok).toBe(true);
    expect(fs.readFileSync(path.join(dest, "folder", "inner.txt"), "utf8")).toBe("i");
    expect(fs.existsSync(path.join(src, "one.txt"))).toBe(false);

    fs.writeFileSync(path.join(src, "one.txt"), "again");
    fs.writeFileSync(path.join(src, "two.txt"), "2");
    const clash = await moveItems([path.join(src, "two.txt"), path.join(src, "one.txt")], dest);
    expect(clash.ok).toBe(false);
    expect(clash.error).toMatch(/already exists/);
    expect(fs.existsSync(path.join(src, "two.txt"))).toBe(true); // nothing moved
    expect(fs.readFileSync(path.join(dest, "one.txt"), "utf8")).toBe("1");
    expect((await moveItems([path.join(src, "two.txt")], path.join(dest, "one.txt"))).error).toMatch(/not a folder/);
  });

  it("completes folders and lists apps", async () => {
    fs.mkdirSync(path.join(dir, "Projects"));
    fs.mkdirSync(path.join(dir, "Pictures"));
    fs.mkdirSync(path.join(dir, ".hidden"));
    fs.mkdirSync(path.join(dir, "Fake.app"));
    fs.writeFileSync(path.join(dir, "Plain.txt"), "");
    expect((await completeFolder(path.join(dir, "P"), false)).map((s) => s.name)).toEqual(["Pictures", "Projects"]);
    expect((await completeFolder(dir, true)).map((s) => s.name)).not.toContain(".hidden");
    const apps = await listApps([dir, path.join(dir, "missing")]);
    expect(apps).toEqual([{ name: "Fake", path: path.join(dir, "Fake.app") }]);
  });
});
