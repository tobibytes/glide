import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { parseInline, parseMarkdown, safeHref } from "./mdparse";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("parseMarkdown", () => {
  it("parses headings, lists, code fences and paragraphs", () => {
    const ast = parseMarkdown("# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```");
    expect(ast.map((b) => b.t)).toEqual(["heading", "para", "list", "list", "code"]);
    expect(ast[4]).toMatchObject({ t: "code", lang: "ts", v: "const x = 1;", open: false });
    expect(ast[3]).toMatchObject({ t: "list", ordered: true, start: 1 });
  });
  it("treats an unterminated fence as an open code block while streaming", () => {
    const ast = parseMarkdown("Here:\n```py\nprint(1)");
    expect(ast[1]).toMatchObject({ t: "code", lang: "py", v: "print(1)", open: true });
  });
  it("nests indented lists", () => {
    const ast = parseMarkdown("- a\n  - b\n- c");
    expect(ast).toHaveLength(1);
    const list = ast[0] as Extract<(typeof ast)[0], { t: "list" }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children?.[0]).toMatchObject({ t: "list" });
  });
  it("parses inline constructs", () => {
    expect(parseInline("**b** _i_ `c` [l](https://x.dev)")).toEqual([
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "i" }] },
      { t: "text", v: " " },
      { t: "code", v: "c" },
      { t: "text", v: " " },
      { t: "link", href: "https://x.dev/", c: [{ t: "text", v: "l" }] },
    ]);
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
  });
});

describe("safety", () => {
  it("only allows http(s) and mailto links", () => {
    expect(safeHref("https://anthropic.com")).toBe("https://anthropic.com/");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  it("renders raw HTML as inert text", () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n**<b>hi</b>**');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/<b>/);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
  });

  it("drops dangerous link targets but keeps their text", () => {
    const out = html("[click](javascript:alert(1)) and [ok](https://example.com)");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
    expect(out).toContain('href="https://example.com/"');
  });

  it("escapes HTML inside code blocks and inline code", () => {
    const out = html("`<iframe>`\n\n```html\n<iframe src=evil></iframe>\n```");
    expect(out).not.toMatch(/<iframe/i);
    expect(out).toContain("&lt;iframe src=evil&gt;&lt;/iframe&gt;");
  });

  it("does not hang on pathological input", () => {
    const t0 = Date.now();
    html(`${"*".repeat(5000)} ${"_a".repeat(3000)} ${"[".repeat(3000)} ${"`".repeat(3000)}\n${"> ".repeat(500)}x\n${"  - ".repeat(200)}y`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
