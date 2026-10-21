import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumProfileNames, discoverProfiles, parseProfilesIni, safariAccess } from "./browsers";
import {
  buildHistoryQuery, cocoaToMs, faviconQuery, faviconsByHost, firefoxBookmarkRows, FIREFOX_BOOKMARKS_SQL, historyRowsToEntries, msToWebkit, parseChromiumBookmarks,
  parseSafariBookmarks, webkitToMs,
} from "./data";
import { parsePlistXml } from "./plist";
import { dedupe, indexEntries, parseHistoryPrefix, searchEntries } from "./search";
import { queryCopy, setTempRoot } from "./sqlite";

const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8");

describe("Chromium bookmarks", () => {
  const list = parseChromiumBookmarks(fx("chrome-bookmarks.json"));
  it("walks nested folders, labels roots, drops javascript: URLs, falls back to URL for empty titles", () => {
    expect(list.map((e) => [e.title, e.folder])).toEqual([
      ["GitHub", "Bookmarks Bar"],
      ["Electron Docs", "Bookmarks Bar / Dev"],
      ["https://example.com/untitled", "Other Bookmarks"],
    ]);
  });
  it("tolerates corrupt JSON", () => expect(parseChromiumBookmarks("{nope")).toEqual([]));
  it("reads profile names from Local State", () => expect(chromiumProfileNames(JSON.parse(fx("chrome-local-state.json")))).toEqual({ Default: "Personal", "Profile 5": "Work" }));
});

describe("Safari bookmarks (XML plist)", () => {
  it("parses leaves, folder names, entities, <data>/<date>/<true/>, and Reading List", () => {
    const list = parseSafariBookmarks(parsePlistXml(fx("safari-bookmarks.xml")));
    expect(list).toEqual([
      { type: "bookmark", title: "Apple & Friends", url: "https://www.apple.com/", folder: "Favourites" },
      { type: "bookmark", title: "An Article", url: "https://news.example.org/article?id=1&x=2", folder: "Reading List" },
    ]);
  });
  it("parses scalar types", () => {
    const v = parsePlistXml('<plist version="1.0"><dict><key>a</key><integer>3</integer><key>b</key><real>1.5</real><key>c</key><false/><key>d</key><array><string>x</string><string/></array></dict></plist>');
    expect(v).toEqual({ a: 3, b: 1.5, c: false, d: ["x", ""] });
  });
});

describe("history query building", () => {
  const since = Date.UTC(2026, 0, 1);
  it("chromium uses WebKit microseconds and hides hidden rows", () => {
    const q = buildHistoryQuery("chromium", { limit: 100, sinceMs: since });
    expect(q.sql).toContain("FROM urls WHERE hidden = 0");
    expect(q.sql).toContain(`last_visit_time >= ${msToWebkit(since)}`);
    expect(q.sql).toMatch(/LIMIT 100$/);
  });
  it("firefox uses unix microseconds", () => {
    expect(buildHistoryQuery("firefox", { limit: 10, sinceMs: since }).sql).toContain(`last_visit_date >= ${since * 1000}`);
  });
  it("safari groups visits and uses Cocoa seconds", () => {
    const sql = buildHistoryQuery("safari", { limit: 10, sinceMs: since }).sql;
    expect(sql).toContain("GROUP BY i.id HAVING last >= ");
    expect(sql).toContain(String(Math.floor(since / 1000 - 978307200)));
  });
  it("clamps and inlines only integers", () => {
    expect(buildHistoryQuery("chromium", { limit: Number.NaN }).sql).toMatch(/LIMIT 1$/);
    expect(buildHistoryQuery("chromium", { limit: 1e9 }).sql).toMatch(/LIMIT 100000$/);
    expect(buildHistoryQuery("chromium", { limit: 5 }).sql).not.toContain(">=");
  });
  it("converts epochs", () => {
    expect(webkitToMs(msToWebkit(since))).toBe(since);
    expect(cocoaToMs(0)).toBe(Date.UTC(2001, 0, 1));
  });
});

describe("search", () => {
  const entries = indexEntries(
    [
      { type: "bookmark", title: "GitHub", url: "https://github.com/" },
      { type: "bookmark", title: "Electron Docs", url: "https://www.electronjs.org/docs/latest", folder: "Dev" },
      { type: "history", title: "Pull requests · GitHub", url: "https://github.com/pulls", visitCount: 50, lastVisit: Date.now() },
      { type: "history", title: "Pull requests · GitHub", url: "https://github.com/pulls", visitCount: 5, lastVisit: Date.now() - 1000 },
    ],
    "chrome:Default",
    "chrome",
  );
  const deduped = dedupe(entries);
  it("dedupes history by URL summing visits", () => {
    expect(deduped).toHaveLength(3);
    expect(deduped.find((e) => e.type === "history")!.visitCount).toBe(55);
  });
  it("matches all tokens across title and URL", () => {
    expect(searchEntries(deduped, "electron docs", { limit: 5 }).map((r) => r.e.title)).toEqual(["Electron Docs"]);
    expect(searchEntries(deduped, "electronjs", { limit: 5 }).map((r) => r.e.title)).toEqual(["Electron Docs"]);
    expect(searchEntries(deduped, "git pulls", { limit: 5 }).map((r) => r.e.type)).toEqual(["history"]);
    expect(searchEntries(deduped, "zzz", { limit: 5 })).toEqual([]);
  });
  it("filters by type and ranks title prefix first", () => {
    expect(searchEntries(deduped, "git", { limit: 5, type: "bookmark" }).map((r) => r.e.title)).toEqual(["GitHub"]);
  });
  it("parses the history prefix", () => {
    expect(parseHistoryPrefix("history react hooks")).toBe("react hooks");
    expect(parseHistoryPrefix("hist  x")).toBe("x");
    expect(parseHistoryPrefix("historyx")).toBeUndefined();
    expect(parseHistoryPrefix("github")).toBeUndefined();
  });
});

describe("profiles.ini", () => {
  it("lists profiles with absolute paths", () => {
    expect(parseProfilesIni(fx("firefox-profiles.ini"), "/R")).toEqual([
      { name: "default", path: "/R/Profiles/wxyz0000.default" },
      { name: "Work", path: "/R/Profiles/abcd1234.default-release" },
    ]);
  });
});

describe("fixture home: discovery + SQLite snapshots", () => {
  let home: string;
  let tmp: string;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "glide-browser-home-"));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glide-browser-tmp-"));
    setTempRoot(tmp);
    const chrome = path.join(home, "Library/Application Support/Google/Chrome");
    fs.mkdirSync(path.join(chrome, "Default"), { recursive: true });
    fs.mkdirSync(path.join(chrome, "Profile 5"), { recursive: true });
    fs.mkdirSync(path.join(chrome, "System Profile"), { recursive: true });
    fs.writeFileSync(path.join(chrome, "Local State"), fx("chrome-local-state.json"));
    fs.writeFileSync(path.join(chrome, "Default/Bookmarks"), fx("chrome-bookmarks.json"));
    const hist = new DatabaseSync(path.join(chrome, "Profile 5/History"));
    hist.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)");
    const ins = hist.prepare("INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 0, ?, ?)");
    ins.run("https://react.dev/learn", "Quick Start – React", 12, msToWebkit(Date.UTC(2026, 9, 1)), 0);
    ins.run("https://old.example.com/", "Old", 1, msToWebkit(Date.UTC(2020, 0, 1)), 0);
    ins.run("https://hidden.example.com/", "Hidden", 1, msToWebkit(Date.UTC(2026, 9, 1)), 1);
    hist.close();
    const fav = new DatabaseSync(path.join(chrome, "Default/Favicons"));
    fav.exec("CREATE TABLE icon_mapping(id INTEGER PRIMARY KEY, page_url TEXT, icon_id INTEGER); CREATE TABLE favicon_bitmaps(id INTEGER PRIMARY KEY, icon_id INTEGER, image_data BLOB, width INTEGER)");
    fav.prepare("INSERT INTO icon_mapping(page_url, icon_id) VALUES (?, 1)").run("https://github.com/");
    fav.prepare("INSERT INTO favicon_bitmaps(icon_id, image_data, width) VALUES (1, ?, 16)").run(PNG);
    fav.close();

    const ff = path.join(home, "Library/Application Support/Firefox");
    fs.mkdirSync(path.join(ff, "Profiles/abcd1234.default-release"), { recursive: true });
    fs.writeFileSync(path.join(ff, "profiles.ini"), fx("firefox-profiles.ini"));
    const places = new DatabaseSync(path.join(ff, "Profiles/abcd1234.default-release/places.sqlite"));
    places.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER DEFAULT 0, last_visit_date INTEGER);
      CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, title TEXT);
      INSERT INTO moz_places VALUES (1, 'https://developer.mozilla.org/', 'MDN', 3, 0, ${Date.UTC(2026, 9, 2) * 1000});
      INSERT INTO moz_places VALUES (2, 'place:sort=8', 'Recent', 0, 0, NULL);
      INSERT INTO moz_bookmarks VALUES (1, 2, NULL, 0, 'root');
      INSERT INTO moz_bookmarks VALUES (2, 2, NULL, 1, 'toolbar');
      INSERT INTO moz_bookmarks VALUES (3, 1, 1, 2, 'MDN Web Docs');
      INSERT INTO moz_bookmarks VALUES (4, 1, 2, 2, 'Smart folder');`);
    places.close();
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("discovers Chromium and Firefox profiles with names", () => {
    const ps = discoverProfiles(home);
    expect(ps.map((p) => [p.key, p.name, !!p.bookmarksFile, !!p.historyFile, !!p.faviconsFile])).toEqual([
      ["chrome:Default", "Personal", true, false, true],
      ["chrome:Profile 5", "Work", false, true, false],
      ["firefox:abcd1234.default-release", "Work", true, true, false],
    ]);
    expect(safariAccess(home)).toBe("missing");
  });

  it("reads Chromium history from a snapshot and deletes the copy", async () => {
    const file = path.join(home, "Library/Application Support/Google/Chrome/Profile 5/History");
    const q = buildHistoryQuery("chromium", { limit: 10, sinceMs: Date.UTC(2025, 0, 1) });
    const [rows] = await queryCopy(file, [q.sql]);
    const entries = historyRowsToEntries("chromium", rows!);
    expect(entries.map((e) => [e.title, e.visitCount, new Date(e.lastVisit!).toISOString()])).toEqual([["Quick Start – React", 12, "2026-10-01T00:00:00.000Z"]]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("reads Firefox bookmarks and history from places.sqlite", async () => {
    const file = path.join(home, "Library/Application Support/Firefox/Profiles/abcd1234.default-release/places.sqlite");
    const [bm, hi] = await queryCopy(file, [FIREFOX_BOOKMARKS_SQL, buildHistoryQuery("firefox", { limit: 10 }).sql]);
    expect(firefoxBookmarkRows(bm!)).toEqual([{ type: "bookmark", url: "https://developer.mozilla.org/", title: "MDN Web Docs", folder: "Bookmarks Toolbar" }]);
    expect(historyRowsToEntries("firefox", hi!).map((e) => [e.title, e.lastVisit])).toEqual([["MDN", Date.UTC(2026, 9, 2)]]);
  });

  it("extracts favicons as data URLs for wanted hosts only", async () => {
    const file = path.join(home, "Library/Application Support/Google/Chrome/Default/Favicons");
    const [rows] = await queryCopy(file, [faviconQuery("chromium")!]);
    const icons = faviconsByHost(rows!, new Set(["github.com"]));
    expect(icons.get("github.com")).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(faviconsByHost(rows!, new Set(["other.com"])).size).toBe(0);
  });
});
