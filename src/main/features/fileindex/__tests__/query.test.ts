import { describe, expect, it } from "vitest";
import { parseQuery, search } from "../query";
import { buildFake } from "./helpers";

const HOME = "/Users/me";
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const q = (s: string) => parseQuery(s, HOME);

const db = buildFake(
  HOME,
  [
    { path: "Documents/Taxes 2024.pdf" },
    { path: "Documents/notes.txt" },
    { path: "Documents/notes-archive-2019.txt" },
    { path: "Documents/Project Plan.docx" },
    { path: "Pictures/holiday-beach.jpg" },
    { path: "Pictures/holiday-video.mov" },
    { path: "Music/holiday song.mp3" },
    { path: "Code/glide/src/main.ts" },
    { path: "Code/glide/README.md" },
    { path: "Code/holiday-planner/" },
    { path: "Desktop/report-old.txt", mtime: NOW - 300 * DAY },
    { path: "Desktop/report-new.txt", mtime: NOW - 1 * DAY },
    { path: "Desktop/café menu.pdf" },
    { path: "Applications/Holiday.app/" },
  ],
  NOW,
);

const names = (query: string, opts = {}) => search(db, q(query), { now: NOW, ...opts }).map((h) => h.name);

describe("query parsing", () => {
  it("extracts kind:, in: and quoted phrases", () => {
    const p = q('kind:image|pdf in:~/Documents "project plan" draft');
    expect(p.kinds).toEqual(["image", "pdf"]);
    expect(p.inPaths).toEqual(["/Users/me/Documents"]);
    expect(p.phrases).toEqual(["project plan"]);
    expect(p.tokens).toEqual(["project", "plan", "draft"]);
  });
});

describe("search", () => {
  it("finds by word prefix, folded diacritics and run-together text", () => {
    expect(names("tax")).toEqual(["Taxes 2024.pdf"]);
    expect(names("cafe")).toEqual(["café menu.pdf"]);
    expect(names("projectpl")).toContain("Project Plan.docx");
  });
  it("falls back to substrings inside words", () => {
    expect(names("liday")[0]).toMatch(/holiday/i);
  });
  it("lets a token match a parent folder at lower weight", () => {
    const r = names("glide readme");
    expect(r[0]).toBe("README.md");
  });
  it("filters by kind", () => {
    expect(names("holiday kind:image")).toEqual(["holiday-beach.jpg"]);
    expect(names("holiday kind:video")).toEqual(["holiday-video.mov"]);
    expect(names("holiday kind:audio")).toEqual(["holiday song.mp3"]);
    expect(names("holiday kind:folder")).toEqual(["holiday-planner"]);
    expect(names("holiday kind:app")).toEqual(["Holiday.app"]);
    expect(names("kind:pdf")).toEqual(expect.arrayContaining(["Taxes 2024.pdf", "café menu.pdf"]));
    expect(names("main kind:code")).toEqual(["main.ts"]);
    expect(names("notes kind:doc").length).toBe(2);
  });
  it("filters by folder with in:", () => {
    expect(names("holiday in:~/Pictures").sort()).toEqual(["holiday-beach.jpg", "holiday-video.mov"]);
    expect(names("in:~/Code/glide").sort()).toEqual(["README.md", "main.ts", "src"].sort());
  });
  it("requires quoted phrases to appear verbatim", () => {
    expect(names('"holiday song"')).toEqual(["holiday song.mp3"]);
    expect(names('"song holiday"')).toEqual([]);
  });
  it("ranks recent above old", () => {
    expect(names("report")).toEqual(["report-new.txt", "report-old.txt"]);
  });
  it("ranks opened-from-Glide above untouched", () => {
    const old = db.findPath(`${HOME}/Desktop/report-old.txt`);
    const r = names("report", { opened: new Map([[old, NOW - 60_000]]) });
    expect(r[0]).toBe("report-old.txt");
  });
  it("ranks an exact name above fuzzy/longer matches", () => {
    expect(names("notes")[0]).toBe("notes.txt");
  });
  it("returns highlight ranges on the name", () => {
    const [h] = search(db, q("tax"), { now: NOW });
    expect(h.ranges[0]).toEqual({ start: 0, end: 3 });
  });
  it("returns nothing for unmatched tokens and recent files for an empty query", () => {
    expect(names("zzzqqq")).toEqual([]);
    expect(names("").length).toBeGreaterThan(5);
    expect(names("")[0]).toBe("report-new.txt");
  });
  it("sees incremental additions and removals", () => {
    const extra = buildFake("/x", [{ path: "a/alpha.txt" }], NOW);
    const id = extra.add("beta.txt", extra.findPath("/x/a"), { isDir: false, size: 1, mtime: NOW, atime: 0 });
    expect(search(extra, parseQuery("beta", HOME), { now: NOW }).map((h) => h.path)).toEqual(["/x/a/beta.txt"]);
    extra.remove(id);
    expect(search(extra, parseQuery("beta", HOME), { now: NOW })).toEqual([]);
    extra.remove(extra.findPath("/x/a"));
    expect(search(extra, parseQuery("alpha", HOME), { now: NOW })).toEqual([]);
  });
});
