import { describe, expect, it } from "vitest";
import { applyDateOffset, formatDate } from "./dates";
import { argumentsOf, isDynamic, parseTemplate, renderTemplate, type RenderEnv } from "./placeholders";
import { argumentValues, bookmarksToQuicklinks, buildQuicklinkUrl, dedupeByUrl, exportQuicklinks, faviconOrigin, invalidOptions, missingArguments, parseQuicklinkImport } from "./core";

const NOW = new Date(2026, 9, 21, 14, 5, 9); // Wed 21 Oct 2026 14:05:09 local
const env = (over: Partial<RenderEnv> = {}): RenderEnv => ({ now: NOW, clipboard: "clip board", selection: "sel/ected", uuid: () => "1111-2222", ...over });

describe("parseTemplate", () => {
  it("parses placeholders with attributes and modifiers", () => {
    const t = parseTemplate(`a{argument name="lang" default='en'}b{clipboard | trim | uppercase}`);
    expect(t).toEqual([
      { type: "text", text: "a" },
      { type: "placeholder", name: "argument", attrs: { name: "lang", default: "en" }, modifiers: [], raw: `{argument name="lang" default='en'}` },
      { type: "text", text: "b" },
      { type: "placeholder", name: "clipboard", attrs: {}, modifiers: ["trim", "uppercase"], raw: "{clipboard | trim | uppercase}" },
    ]);
  });
  it("keeps unknown braces, JSON and unterminated braces literal", () => {
    for (const s of [`{"a": 1}`, "{nope}", "function() { return 1; }", "{date", "{date bad}", "{clipboard | shout}"]) {
      expect(renderTemplate(s, env())).toBe(s);
    }
  });
  it("allows braces and pipes inside quoted attribute values", () => {
    expect(renderTemplate(`{argument name="x" default="a|b}c"}`, env())).toBe("a|b}c");
  });
});

describe("arguments", () => {
  it("collects named arguments in order with defaults and options; same name is one argument", () => {
    const defs = argumentsOf(`https://x.com/{argument name="lang" default="en"}/{argument name="query"}?t={argument name="type" options="web, images,news"}&again={argument name="query"}`);
    expect(defs).toEqual([
      { name: "lang", placeholder: "lang", default: "en", optional: true },
      { name: "query", placeholder: "Query", optional: false },
      { name: "type", placeholder: "type", options: ["web", "images", "news"], optional: false },
    ]);
  });
  it("treats {query} as the argument 'query' and numbers unnamed {argument}s", () => {
    expect(argumentsOf("{query}").map((d) => d.name)).toEqual(["query"]);
    expect(argumentsOf("{argument}-{argument}").map((d) => d.name)).toEqual(["argument", "argument 2"]);
  });
  it("fills the first argument from the plain argument string and honours explicit values", () => {
    const defs = argumentsOf(`{argument name="a"}{argument name="b" default="z"}`);
    expect(argumentValues(defs, undefined, " hi ")).toEqual({ a: "hi" });
    expect(argumentValues(defs, { a: "x", b: "y" }, "ignored")).toEqual({ a: "x", b: "y" });
    expect(argumentValues(defs, { a: "", b: "y" }, "typed")).toEqual({ a: "typed", b: "y" });
  });
  it("reports missing required arguments and invalid options", () => {
    const defs = argumentsOf(`{argument name="q"}{argument name="lang" default="en"}{argument name="t" options="a,b"}`);
    expect(missingArguments(defs, { t: "a" }).map((d) => d.name)).toEqual(["q"]);
    expect(invalidOptions(defs, { q: "x", t: "c" }).map((d) => d.name)).toEqual(["t"]);
    expect(invalidOptions(defs, { q: "x", t: "b" })).toEqual([]);
  });
});

describe("quicklink URLs and encoding", () => {
  it("percent-encodes each value by default", () => {
    const url = `https://translate.example/?sl={argument name="from" default="auto"}&tl={argument name="lang" default="en"}&q={argument name="text"}`;
    expect(buildQuicklinkUrl(url, env({ arguments: { text: "a&b c/ü", lang: "de" } }))).toBe("https://translate.example/?sl=auto&tl=de&q=a%26b%20c%2F%C3%BC");
  });
  it("raw=\"true\" and | raw skip encoding for that placeholder only", () => {
    expect(buildQuicklinkUrl(`https://x.com/{argument name="path" raw="true"}?q={query}`, env({ arguments: { path: "a/b", query: "c/d" } }))).toBe("https://x.com/a/b?q=c%2Fd");
    expect(buildQuicklinkUrl(`https://x.com/{clipboard | raw}`, env())).toBe("https://x.com/clip board");
  });
  it("does not encode a placeholder that forms the start of the URL", () => {
    expect(buildQuicklinkUrl(`{clipboard}`, env({ clipboard: "https://a.com/x?y=1" }))).toBe("https://a.com/x?y=1");
    expect(buildQuicklinkUrl(`  {selection}/more`, env({ selection: "https://a.com" }))).toBe("https://a.com/more");
  });
  it("fills clipboard, selection, uuid and dates", () => {
    expect(buildQuicklinkUrl(`https://x/?c={clipboard}&s={selection}&u={uuid}&d={date format="yyyy-MM-dd"}`, env())).toBe("https://x/?c=clip%20board&s=sel%2Fected&u=1111-2222&d=2026-10-21");
  });
  it("modifiers apply before encoding", () => {
    expect(buildQuicklinkUrl(`https://x/{clipboard | uppercase}`, env())).toBe("https://x/CLIP%20BOARD");
  });
  it("empty arguments fall back to their default", () => {
    expect(buildQuicklinkUrl(`https://x/{argument name="l" default="en"}`, env({ arguments: { l: "" } }))).toBe("https://x/en");
  });
});

describe("dates", () => {
  it("formats tokens and quoted literals", () => {
    expect(formatDate(NOW, "yyyy-MM-dd HH:mm:ss")).toBe("2026-10-21 14:05:09");
    expect(formatDate(NOW, "EEEE, MMMM d 'at' h:mm a")).toBe("Wednesday, October 21 at 2:05 PM");
    expect(formatDate(NOW, "EEE d MMM yy, 'Q'Q 'w'ww")).toBe("Wed 21 Oct 26, Q4 w43");
    expect(formatDate(NOW, "'it''s' yyyy")).toBe("it's 2026");
  });
  it("applies offsets", () => {
    expect(formatDate(applyDateOffset(NOW, "+1d"), "yyyy-MM-dd")).toBe("2026-10-22");
    expect(formatDate(applyDateOffset(NOW, "-2w"), "yyyy-MM-dd")).toBe("2026-10-07");
    expect(formatDate(applyDateOffset(NOW, "+1d 3h"), "yyyy-MM-dd HH")).toBe("2026-10-22 17");
    expect(formatDate(applyDateOffset(NOW, "-1d+2h"), "dd HH")).toBe("20 16");
    expect(formatDate(applyDateOffset(new Date(2026, 0, 31), "+1M"), "yyyy-MM-dd")).toBe("2026-02-28");
    expect(formatDate(applyDateOffset(NOW, "+1y"), "yyyy")).toBe("2027");
    expect(formatDate(applyDateOffset(NOW, "+30m"), "HH:mm")).toBe("14:35");
    expect(applyDateOffset(NOW, "soon").getTime()).toBe(NOW.getTime());
  });
  it("renders {date}/{time}/{day} defaults and offsets in templates", () => {
    expect(renderTemplate(`{date} {time} {day} {date offset="+1d" format="d MMM"}`, env())).toBe("2026-10-21 14:05 Wednesday 22 Oct");
  });
  it("isDynamic ignores arguments and cursor", () => {
    expect(isDynamic("x {query} {cursor}")).toBe(false);
    expect(isDynamic("x {date}")).toBe(true);
  });
});

describe("import / export", () => {
  it("round-trips Glide exports", () => {
    const list = [{ id: "a", name: "G", url: "https://g.com/?q={query}", alias: "g", openWith: "/Applications/Safari.app" }];
    const json = JSON.stringify(exportQuicklinks(list, NOW));
    expect(parseQuicklinkImport(json)).toEqual({ quicklinks: [{ name: "G", url: "https://g.com/?q={query}", alias: "g", openWith: "/Applications/Safari.app" }], skipped: 0 });
  });
  it("reads Raycast's quicklink export ({name, link, openWith})", () => {
    const r = parseQuicklinkImport(JSON.stringify([{ name: "Docs", link: "https://d.dev/{argument name=\"q\"}", openWith: "com.google.Chrome" }, { name: "" }, 5]));
    expect(r).toEqual({ quicklinks: [{ name: "Docs", url: "https://d.dev/{argument name=\"q\"}", openWith: "com.google.Chrome" }], skipped: 2 });
  });
  it("rejects non-JSON and shapeless JSON", () => {
    expect(() => parseQuicklinkImport("nope")).toThrow(/valid JSON/);
    expect(() => parseQuicklinkImport("{}")).toThrow(/No quicklinks/);
  });
  it("dedupes by URL, ignoring trailing slashes and case", () => {
    expect(dedupeByUrl([{ url: "https://A.com/" }, { url: "https://b.com" }, { url: "https://b.com/" }], [{ url: "https://a.com" }])).toEqual([{ url: "https://b.com" }]);
  });
  it("converts bookmarks to quicklinks, skipping non-http", () => {
    expect(bookmarksToQuicklinks([{ title: "A", url: "https://a.com", folder: "Bar / Dev", icon: "data:image/png;base64,xx" }, { title: "js", url: "javascript:alert(1)" }])).toEqual([
      { name: "A", url: "https://a.com", icon: { kind: "url", value: "data:image/png;base64,xx" }, keywords: ["bar", "dev"] },
    ]);
  });
  it("finds the favicon origin only for concrete http hosts", () => {
    expect(faviconOrigin("https://www.google.com/search?q={query}")).toBe("https://www.google.com");
    expect(faviconOrigin("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
    expect(faviconOrigin("{clipboard}")).toBeUndefined();
    expect(faviconOrigin("https://{argument name=\"host\"}/x")).toBeUndefined();
    expect(faviconOrigin("raycast://x")).toBeUndefined();
  });
});
