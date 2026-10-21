import { describe, expect, it } from "vitest";
import {
  classifyText,
  computeStats,
  entryTitle,
  filePathsFromUriList,
  filterEntries,
  isConcealed,
  isIgnoredApp,
  normalizeSettings,
  prune,
  touch,
  upsert,
  type ClipCandidate,
  type ClipEntry,
} from "./model";

const DAY = 86_400_000;
let n = 0;
const newId = () => `id${++n}`;
const text = (t: string): ClipCandidate => ({ type: classifyText(t), key: `t:${t}`, text: t, source: null });
const entry = (over: Partial<ClipEntry>): ClipEntry => ({
  id: newId(),
  type: "text",
  key: `k${n}`,
  text: "x",
  source: null,
  createdAt: 0,
  lastCopiedAt: 0,
  count: 1,
  pinned: false,
  ...over,
});

describe("type detection", () => {
  it("detects links", () => {
    expect(classifyText("https://raycast.com/pro")).toBe("link");
    expect(classifyText("  mailto:a@b.co ")).toBe("link");
    expect(classifyText("www.example.com/path")).toBe("link");
    expect(classifyText("see https://x.com for more")).toBe("text");
  });
  it("detects colors", () => {
    for (const c of ["#fff", "#FFAA00", "#ffaa0080", "rgb(255, 0, 10)", "rgba(1,2,3,0.5)", "hsl(120deg 50% 40%)", "hsla(120, 50%, 40%, .3)"]) expect(classifyText(c)).toBe("color");
    expect(classifyText("#ggg")).toBe("text");
    expect(classifyText("#12345")).toBe("text");
  });
  it("parses file uri lists", () => {
    expect(filePathsFromUriList("file:///etc/hosts\r\nfile:///Users/me/My%20Doc.txt\n# comment\nhttps://x.com")).toEqual(["/etc/hosts", "/Users/me/My Doc.txt"]);
  });
  it("titles entries", () => {
    expect(entryTitle({ type: "text", text: "\n\n  hello\nworld" })).toBe("hello");
    expect(entryTitle({ type: "file", files: ["/a/b.txt", "/c"] })).toBe("b.txt + 1 more");
    expect(entryTitle({ type: "image", image: { sha1: "x", width: 3, height: 4, bytes: 1 } })).toBe("Image (3×4)");
  });
});

describe("ignore rules", () => {
  it("flags concealed and transient pasteboard types", () => {
    expect(isConcealed(['electron application/osclipboard;format="org.nspasteboard.ConcealedType"'])).toBe(true);
    expect(isConcealed(["org.nspasteboard.TransientType"])).toBe(true);
    expect(isConcealed(["com.agilebits.onepassword"])).toBe(true);
    expect(isConcealed(["text/plain", "electron application/findtext"])).toBe(false);
  });
  it("matches ignored bundle ids case-insensitively", () => {
    expect(isIgnoredApp("com.1Password.1password", ["com.1password.1password"])).toBe(true);
    expect(isIgnoredApp("com.apple.Safari", ["com.1password.1password"])).toBe(false);
    expect(isIgnoredApp(null, ["com.1password.1password"])).toBe(false);
  });
});

describe("dedupe", () => {
  it("moves the same content to the top and bumps its count", () => {
    let list: ClipEntry[] = [];
    list = upsert(list, text("a"), 1, newId).entries;
    list = upsert(list, text("b"), 2, newId).entries;
    const firstId = list[1]!.id;
    const r = upsert(list, text("a"), 3, newId);
    expect(r.isNew).toBe(false);
    expect(r.entries.map((e) => e.text)).toEqual(["a", "b"]);
    expect(r.entries[0]).toMatchObject({ id: firstId, count: 2, createdAt: 1, lastCopiedAt: 3 });
  });
  it("keeps pin state when re-copied", () => {
    let list = upsert([], text("a"), 1, newId).entries;
    list = [{ ...list[0]!, pinned: true }];
    expect(upsert(list, text("a"), 2, newId).entries[0]!.pinned).toBe(true);
  });
  it("touch moves to top", () => {
    const list = [entry({ id: "x", lastCopiedAt: 5 }), entry({ id: "y", lastCopiedAt: 1 })];
    expect(touch(list, "y", 9).map((e) => e.id)).toEqual(["y", "x"]);
  });
});

describe("retention", () => {
  const base = { retentionDays: 7, maxEntries: 1000, maxImages: 200, maxImageMB: 500 };
  it("expires old unpinned entries but never pinned ones", () => {
    const now = 100 * DAY;
    const old = entry({ lastCopiedAt: now - 8 * DAY });
    const oldPinned = entry({ lastCopiedAt: now - 300 * DAY, pinned: true });
    const fresh = entry({ lastCopiedAt: now - DAY });
    const { kept, removed } = prune([old, oldPinned, fresh], base, now);
    expect(kept).toEqual([fresh, oldPinned]);
    expect(removed).toEqual([old]);
  });
  it("retention 0 keeps forever", () => {
    const e = entry({ lastCopiedAt: 0 });
    expect(prune([e], { ...base, retentionDays: 0 }, 1e12).kept).toEqual([e]);
  });
  it("caps entry count, dropping the oldest unpinned", () => {
    const list = Array.from({ length: 15 }, (_, i) => entry({ lastCopiedAt: 1000 - i, pinned: i === 14 }));
    const { kept, removed } = prune(list, { ...base, retentionDays: 0, maxEntries: 10 }, 1000);
    expect(kept).toHaveLength(10);
    expect(kept.some((e) => e.pinned)).toBe(true);
    expect(removed).toHaveLength(5);
  });
  it("caps images by count and bytes separately", () => {
    const img = (i: number, mb: number) => entry({ type: "image", lastCopiedAt: 1000 - i, image: { sha1: `s${i}`, width: 1, height: 1, bytes: mb * 1024 * 1024 } });
    const list = [img(0, 1), img(1, 1), img(2, 1), entry({ lastCopiedAt: 1 })];
    expect(prune(list, { ...base, retentionDays: 0, maxImages: 2 }, 1000).removed.map((e) => e.image?.sha1)).toEqual(["s2"]);
    expect(prune(list, { ...base, retentionDays: 0, maxImageMB: 1 }, 1000).removed.map((e) => e.image?.sha1)).toEqual(["s2", "s1"]);
  });
});

describe("search", () => {
  it("filters by words, type, and orders pinned first", () => {
    const a = entry({ text: "Hello world", lastCopiedAt: 3 });
    const b = entry({ type: "link", text: "https://hello.dev", lastCopiedAt: 2 });
    const c = entry({ text: "unrelated", lastCopiedAt: 1, pinned: true });
    expect(filterEntries([a, b, c], "", "all", 0).map((e) => e.id)).toEqual([c.id, a.id, b.id]);
    expect(filterEntries([a, b, c], "hello", "all", 0).map((e) => e.id)).toEqual([a.id, b.id]);
    expect(filterEntries([a, b, c], "hello", "link", 0).map((e) => e.id)).toEqual([b.id]);
    expect(filterEntries([a, b, c], "world hello", "all", 1).map((e) => e.id)).toEqual([a.id]);
  });
  it("stats count by type", () => {
    const s = computeStats([entry({ type: "image", image: { sha1: "a", width: 1, height: 1, bytes: 10 } }), entry({ pinned: true })], { paused: false, enabled: true });
    expect(s).toMatchObject({ total: 2, pinned: 1, imageBytes: 10, byType: { image: 1, text: 1 } });
  });
  it("normalizes settings", () => {
    const s = normalizeSettings({ retentionDays: -4, maxEntries: 5.6, ignoredApps: ["a", "", 3 as unknown as string] });
    expect(s.retentionDays).toBe(0);
    expect(s.maxEntries).toBe(10);
    expect(s.ignoredApps).toEqual(["a"]);
  });
});
