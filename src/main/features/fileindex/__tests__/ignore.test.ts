import { describe, expect, it } from "vitest";
import { extendChain, IgnoreRules, isIgnoredByChain, parseIgnoreFile } from "../ignore";

const rules = (text: string, base = "/r") => new IgnoreRules(base, parseIgnoreFile(text));

describe("gitignore matcher", () => {
  it("matches unanchored names at any depth", () => {
    const r = rules("*.log\nsecret.txt");
    expect(r.match("a.log", false)).toBe("ignore");
    expect(r.match("x/y/a.log", false)).toBe("ignore");
    expect(r.match("x/secret.txt", false)).toBe("ignore");
    expect(r.match("x/secret.txt.bak", false)).toBe(null);
  });
  it("anchors patterns with a leading or inner slash", () => {
    const r = rules("/build\ndocs/*.md");
    expect(r.match("build", true)).toBe("ignore");
    expect(r.match("src/build", true)).toBe(null);
    expect(r.match("docs/a.md", false)).toBe("ignore");
    expect(r.match("docs/sub/a.md", false)).toBe(null);
    expect(r.match("x/docs/a.md", false)).toBe(null);
  });
  it("supports dir-only patterns", () => {
    const r = rules("cache/");
    expect(r.match("cache", true)).toBe("ignore");
    expect(r.match("cache", false)).toBe(null);
  });
  it("supports negation (last match wins)", () => {
    const r = rules("*.txt\n!keep.txt");
    expect(r.match("a.txt", false)).toBe("ignore");
    expect(r.match("keep.txt", false)).toBe("include");
  });
  it("supports ** forms, ? and character classes", () => {
    const r = rules("**/gen/**\na/**/z.c\nfile?.[ch]\n[!m]ain.go");
    expect(r.match("x/gen/out.js", false)).toBe("ignore");
    expect(r.match("gen/out.js", false)).toBe("ignore");
    expect(r.match("a/z.c", false)).toBe("ignore");
    expect(r.match("a/b/c/z.c", false)).toBe("ignore");
    expect(r.match("file1.c", false)).toBe("ignore");
    expect(r.match("file12.c", false)).toBe(null);
    expect(r.match("gain.go", false)).toBe("ignore");
    expect(r.match("main.go", false)).toBe(null);
  });
  it("skips comments/blank lines and honours escapes", () => {
    const r = rules("# comment\n\n\\#hash\n\\!bang");
    expect(r.rules.length).toBe(2);
    expect(r.match("#hash", false)).toBe("ignore");
    expect(r.match("!bang", false)).toBe("ignore");
  });
  it("lets deeper ignore files override shallower ones", () => {
    const chain = extendChain(extendChain(null, rules("*.md", "/r")), rules("!README.md", "/r/pkg"));
    expect(isIgnoredByChain(chain, "/r/notes.md", false)).toBe(true);
    expect(isIgnoredByChain(chain, "/r/pkg/README.md", false)).toBe(false);
    expect(isIgnoredByChain(chain, "/r/pkg/other.md", false)).toBe(true);
  });
});
