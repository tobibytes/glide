import { describe, expect, it } from "vitest";
import { isSafeHref, parseInline, parseMarkdown } from "./markdown";
import { filterItems } from "./filter";
import type { ListItemModel } from "../../../extension-api/types";

describe("parseMarkdown", () => {
  it("parses headings, paragraphs, lists, code, quotes and rules", () => {
    const md = "# Title\n\nHello **bold** and *it*.\nNext line  \nbreak\n\n- one\n- two `x`\n\n3. c\n4. d\n\n```js\nconst a = '<b>';\n```\n\n> quoted\n\n---";
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.t)).toEqual(["heading", "paragraph", "list", "list", "code", "quote", "hr"]);
    expect(blocks[0]).toEqual({ t: "heading", level: 1, c: [{ t: "text", v: "Title" }] });
    const p = blocks[1];
    expect(p.t === "paragraph" && p.c.some((i) => i.t === "br")).toBe(true);
    expect(p.t === "paragraph" && p.c.find((i) => i.t === "strong")).toEqual({ t: "strong", c: [{ t: "text", v: "bold" }] });
    const ol = blocks[3];
    expect(ol.t === "list" && ol.ordered && ol.start).toBe(3);
    expect(blocks[4]).toEqual({ t: "code", lang: "js", v: "const a = '<b>';" });
  });

  it("keeps raw HTML as text", () => {
    const blocks = parseMarkdown("<script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(blocks).toEqual([{ t: "paragraph", c: [{ t: "text", v: "<script>alert(1)</script> <img src=x onerror=alert(1)>" }] }]);
  });

  it("parses links, images, bare URLs and escapes", () => {
    expect(parseInline("see [docs](https://x.dev/a) now")).toEqual([
      { t: "text", v: "see " },
      { t: "link", href: "https://x.dev/a", c: [{ t: "text", v: "docs" }] },
      { t: "text", v: " now" },
    ]);
    expect(parseInline("![logo](https://x.dev/l.png)")).toEqual([{ t: "image", alt: "logo", src: "https://x.dev/l.png" }]);
    expect(parseInline("go to https://example.com.")).toEqual([
      { t: "text", v: "go to " },
      { t: "link", href: "https://example.com", c: [{ t: "text", v: "https://example.com" }] },
      { t: "text", v: "." },
    ]);
    expect(parseInline("\\*not em\\* snake_case_word")).toEqual([{ t: "text", v: "*not em* snake_case_word" }]);
  });

  it("only allows safe link schemes", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("https://ok")).toBe(true);
  });
});

const item = (id: string, title: string, extra: Partial<ListItemModel> = {}): ListItemModel => ({ id, title, accessories: [], keywords: [], actions: [], ...extra });

describe("filterItems", () => {
  const items = [item("1", "New York", { subtitle: "USA" }), item("2", "York", { keywords: ["England"] }), item("3", "Tokyo"), item("4", "Newark")];
  it("returns everything for an empty query", () => {
    expect(filterItems(items, " ").map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
  });
  it("matches title words, subtitles and keywords, best first", () => {
    expect(filterItems(items, "york").map((i) => i.id)).toEqual(["2", "1"]);
    expect(filterItems(items, "england").map((i) => i.id)).toEqual(["2"]);
    expect(filterItems(items, "new usa").map((i) => i.id)).toEqual(["1"]);
    expect(filterItems(items, "zzz")).toEqual([]);
  });
});
