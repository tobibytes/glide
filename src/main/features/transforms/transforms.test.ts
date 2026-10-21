import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { md5, sha1, sha256 } from "./hash";
import { applyTransform, parseQuery, splitWords, TRANSFORMS } from "./transforms";

const run = (id: string, input: string, opts = {}) => {
  const r = applyTransform(id, input, opts);
  if (!r.ok) throw new Error(r.error);
  return r.output;
};
const fails = (id: string, input: string) => {
  const r = applyTransform(id, input);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error;
};

describe("case transforms", () => {
  it("splits words across conventions", () => {
    expect(splitWords("fooBar baz-qux_HTTPServer")).toEqual(["foo", "Bar", "baz", "qux", "HTTP", "Server"]);
  });
  it("upper / lower", () => {
    expect(run("upper", "Hello wörld")).toBe("HELLO WÖRLD");
    expect(run("lower", "Hello WÖRLD")).toBe("hello wörld");
  });
  it("title / sentence", () => {
    expect(run("title", "the quick BROWN fox's tail")).toBe("The Quick Brown Fox's Tail");
    expect(run("sentence", "HELLO THERE. how are you? fine!\nnew line")).toBe("Hello there. How are you? Fine!\nNew line");
  });
  it("camel / pascal / snake / constant / kebab per line", () => {
    expect(run("camel", "hello big world\nfoo_bar")).toBe("helloBigWorld\nfooBar");
    expect(run("pascal", "hello big-world")).toBe("HelloBigWorld");
    expect(run("snake", "helloBigWorld")).toBe("hello_big_world");
    expect(run("constant", "max retry count")).toBe("MAX_RETRY_COUNT");
    expect(run("kebab", "Hello Big_World")).toBe("hello-big-world");
  });
  it("slugify strips accents and punctuation", () => {
    expect(run("slugify", "  Crème Brûlée: The Recipe!  ")).toBe("creme-brulee-the-recipe");
  });
});

describe("line transforms", () => {
  it("trim", () => expect(run("trim", "  a  \n   b \n")).toBe("a\nb"));
  it("sort (natural, case-insensitive)", () => expect(run("sort", "b10\nB2\na")).toBe("a\nB2\nb10"));
  it("dedupe keeps first occurrence", () => expect(run("dedupe", "a\nb\na\nc\nb")).toBe("a\nb\nc"));
  it("reverse lines and text", () => {
    expect(run("reverse-lines", "1\n2\n3")).toBe("3\n2\n1");
    expect(run("reverse", "abc😀")).toBe("😀cba");
  });
  it("wrap at width with indentation", () => {
    expect(run("wrap", "aaa bbb ccc ddd", { width: 10 })).toBe("aaa bbb\nccc ddd");
    expect(run("wrap", "  one two three four", { width: 12 })).toBe("  one two\n  three four");
    expect(run("wrap", "short", { width: 80 })).toBe("short");
  });
  it("count", () => {
    expect(run("count", "Hello world\n\nsecond para")).toBe("Characters: 24\nCharacters (no spaces): 20\nWords: 4\nLines: 3\nParagraphs: 2");
  });
});

describe("data transforms", () => {
  it("json pretty / minify / validate", () => {
    expect(run("json-pretty", '{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(run("json-minify", '{ "a" : 1 ,\n "b": [ 1 ] }')).toBe('{"a":1,"b":[1]}');
    expect(run("json-validate", '{"a":1}')).toBe("✓ Valid JSON (object with 1 keys)");
    expect(fails("json-validate", "{a:1}")).toMatch(/Invalid JSON/);
  });
  it("markdown to plain text", () => {
    const md = "# Title\n\nSome **bold** and _it_ with [a link](http://x) and `code`.\n\n- item one\n- [x] done\n> quote\n```js\nconst x = 1;\n```\n---";
    expect(run("markdown-plain", md)).toBe("Title\n\nSome bold and it with a link and code.\n\n• item one\n• done\nquote\nconst x = 1;");
  });
  it("jwt decode labels the missing verification", () => {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "42", exp: 1700000000 })}.sig`;
    const out = run("jwt", token);
    expect(out).toContain("NOT verified");
    expect(out).toContain("// exp: 2023-11-14T22:13:20.000Z");
    expect(out).toContain('"sub": "42"');
    expect(fails("jwt", "not-a-token")).toMatch(/Not a JWT/);
  });
  it("timestamp both ways", () => {
    expect(run("timestamp", "1700000000")).toBe("2023-11-14T22:13:20.000Z");
    expect(run("timestamp", "1700000000123")).toBe("2023-11-14T22:13:20.123Z");
    expect(run("timestamp", "2023-11-14T22:13:20Z")).toBe("1700000000");
    expect(run("timestamp", "", { now: new Date(1_000_000_000_000) })).toBe("1000000000\n2001-09-09T01:46:40.000Z");
    expect(fails("timestamp", "next tuesday-ish")).toMatch(/Not a unix timestamp/);
  });
});

describe("encoding transforms", () => {
  it("base64 round trip with unicode and base64url", () => {
    expect(run("base64-encode", "héllo ✓")).toBe(Buffer.from("héllo ✓").toString("base64"));
    expect(run("base64-decode", Buffer.from("héllo ✓").toString("base64"))).toBe("héllo ✓");
    expect(run("base64-decode", Buffer.from("??>>").toString("base64url"))).toBe("??>>");
    expect(fails("base64-decode", "%%%")).toMatch(/Base64/);
  });
  it("url encode / decode", () => {
    expect(run("url-encode", "a b&c=d/é")).toBe("a%20b%26c%3Dd%2F%C3%A9");
    expect(run("url-decode", "a%20b+c%C3%A9")).toBe("a b cé");
    expect(fails("url-decode", "%E0%A4%A")).toMatch(/Malformed/);
  });
  it("html escape / unescape", () => {
    expect(run("html-escape", `<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
    expect(run("html-unescape", "&lt;b&gt; &amp; &#169; &#x1F600;")).toBe("<b> & © 😀");
  });
  it("hashes match node:crypto", () => {
    for (const s of ["", "abc", "The quick brown fox jumps over the lazy dog", "ünïcødé ✓".repeat(30)]) {
      expect(md5(s)).toBe(createHash("md5").update(s).digest("hex"));
      expect(sha1(s)).toBe(createHash("sha1").update(s).digest("hex"));
      expect(sha256(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
    expect(run("sha256", "abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("generators and plumbing", () => {
  it("uuid ignores input and is v4-shaped", () => {
    expect(run("uuid", "")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(run("uuid", "x", { uuid: () => "fixed" })).toBe("fixed");
  });
  it("empty input is an error for input-based transforms", () => {
    expect(fails("upper", "")).toMatch(/No input/);
  });
  it("unknown transform", () => expect(fails("nope", "x")).toMatch(/Unknown/));
  it("ids are unique and every transform has keywords", () => {
    expect(new Set(TRANSFORMS.map((t) => t.id)).size).toBe(TRANSFORMS.length);
    for (const t of TRANSFORMS) expect(t.keywords.length).toBeGreaterThan(0);
  });
  it("parseQuery picks up a wrap width", () => {
    expect(parseQuery("wrap 60")).toEqual({ query: "wrap", width: 60 });
    expect(parseQuery("sha256")).toEqual({ query: "sha256" });
  });
});
