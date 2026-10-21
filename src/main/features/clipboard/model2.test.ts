import { describe, expect, it } from "vitest";
import { computeStats, filterEntries, haystack, isPaused, linkDomain, markdownLink, mergeTexts, normalizeSettings, prune, sourceApps, summarize, type ClipEntry } from "./model";

const DAY = 86_400_000;
let n = 0;
const entry = (over: Partial<ClipEntry>): ClipEntry => ({
  id: `e${++n}`,
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
const safari = { name: "Safari", bundleId: "com.apple.Safari" };
const notes = { name: "Notes", bundleId: null };

describe("filters", () => {
  const list = [
    entry({ text: "hello world", source: safari, lastCopiedAt: 5 }),
    entry({ type: "link", text: "https://github.com/x", source: safari, lastCopiedAt: 4 }),
    entry({ type: "image", text: undefined, image: { sha1: "a", width: 10, height: 10, bytes: 1 }, ocrText: "Invoice total 42", lastCopiedAt: 3 }),
    entry({ type: "file", text: undefined, files: ["/tmp/a.txt"], source: notes, lastCopiedAt: 2 }),
    entry({ type: "color", text: "#ff0000", pinned: true, lastCopiedAt: 1 }),
  ];
  it("filters by pinned", () => {
    expect(filterEntries(list, "", "pinned", 0).map((e) => e.type)).toEqual(["color"]);
  });
  it("filters by type and source app", () => {
    expect(filterEntries(list, "", "all", 0, undefined, "com.apple.Safari").map((e) => e.type)).toEqual(["text", "link"]);
    expect(filterEntries(list, "", "link", 0, undefined, "com.apple.Safari")).toHaveLength(1);
    expect(filterEntries(list, "", "all", 0, undefined, "name:Notes").map((e) => e.type)).toEqual(["file"]);
  });
  it("searches OCR text of images", () => {
    expect(filterEntries(list, "invoice", "all", 0).map((e) => e.type)).toEqual(["image"]);
    expect(haystack(list[2]!)).toContain("total 42");
  });
  it("lists source apps by count", () => {
    expect(sourceApps(list)).toEqual([
      { key: "com.apple.Safari", name: "Safari", bundleId: "com.apple.Safari", count: 2 },
      { key: "name:Notes", name: "Notes", bundleId: null, count: 1 },
    ]);
  });
});

describe("retention per type", () => {
  it("applies a shorter image retention while keeping text", () => {
    const now = 100 * DAY;
    const list = [
      entry({ type: "image", image: { sha1: "a", width: 1, height: 1, bytes: 1 }, lastCopiedAt: now - 8 * DAY }),
      entry({ type: "image", image: { sha1: "b", width: 1, height: 1, bytes: 1 }, lastCopiedAt: now - 8 * DAY, pinned: true }),
      entry({ type: "image", image: { sha1: "c", width: 1, height: 1, bytes: 1 }, lastCopiedAt: now - 2 * DAY }),
      entry({ type: "text", lastCopiedAt: now - 30 * DAY }),
    ];
    const r = prune(list, { retentionDays: 90, retentionByType: { image: 7 }, maxEntries: 0, maxImages: 0, maxImageMB: 0 }, now);
    expect(r.removed.map((e) => e.image?.sha1)).toEqual(["a"]);
    expect(r.kept).toHaveLength(3);
  });
  it("normalizes per-type settings", () => {
    const s = normalizeSettings({ retentionByType: { image: 7, text: -1, link: 0 } as never });
    expect(s.retentionByType).toEqual({ image: 7 });
  });
});

describe("timed pause", () => {
  it("is paused until the deadline", () => {
    expect(isPaused({ paused: false, pausedUntil: 1000 }, 999)).toBe(true);
    expect(isPaused({ paused: false, pausedUntil: 1000 }, 1000)).toBe(false);
    const st = computeStats([], { paused: false, enabled: true, pausedUntil: 2000 }, 1000);
    expect(st.paused).toBe(true);
    expect(st.pausedUntil).toBe(2000);
  });
});

describe("merge and links", () => {
  it("merges text and file entries in order, skipping images", () => {
    expect(mergeTexts([{ type: "text", text: "a" }, { type: "image" }, { type: "file", files: ["/x", "/y"] }, { type: "link", text: "https://b.co" }])).toBe("a\n/x\n/y\nhttps://b.co");
    expect(mergeTexts([{ type: "image" }])).toBeNull();
    expect(mergeTexts([{ type: "text", text: "a" }, { type: "text", text: "b" }], ", ")).toBe("a, b");
  });
  it("extracts domains and builds markdown links", () => {
    expect(linkDomain("https://www.github.com/a?b")).toBe("github.com");
    expect(linkDomain("www.example.org/x")).toBe("example.org");
    expect(linkDomain("mailto:me@mail.com")).toBe("mail.com");
    expect(markdownLink("https://github.com/a b")).toBe("[github.com](https://github.com/a%20b)");
    expect(markdownLink("https://x.com/(y)", "A [b]")).toBe("[A \\[b\\]](https://x.com/(y%29)");
    expect(summarize(entry({ type: "link", text: "https://www.raycast.com/pro" })).domain).toBe("raycast.com");
  });
});
