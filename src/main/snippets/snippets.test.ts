import { describe, expect, it } from "vitest";
import type { Snippet } from "@shared/types";
import type { RenderEnv } from "../quicklinks/placeholders";
import { buildExpansionList, caseVariants, effectiveKeyword, expandsIn, expansionPlan, keywordWarning, needsFrontmost, needsRefresh, sanitizeSnippetSettings, SNIPPET_DEFAULTS } from "./expansion";
import { exportSnippets, mergeImported, parseSnippetImport } from "./io";
import { cursorLeftCount, htmlToText, placeCursor, renderSnippet, sanitizeHtml, snippetLookup } from "./render";

const NOW = new Date(2026, 9, 21, 9, 30, 0);
const env = (over: Partial<RenderEnv> = {}): RenderEnv => ({ now: NOW, clipboard: "CLIP", uuid: () => "u-1", ...over });
const sn = (id: string, name: string, text: string, extra: Partial<Snippet> = {}): Snippet => ({ id, name, text, ...extra });

describe("snippet rendering", () => {
  it("renders clipboard, dates with formats and offsets, uuid", () => {
    const r = renderSnippet({ text: `{clipboard} {date format="dd/MM/yyyy"} {date offset="+1d" format="EEE"} {time format="h:mm a"} {uuid}` }, env());
    expect(r).toEqual({ text: "CLIP 21/10/2026 Thu 9:30 AM u-1", cursorLeft: 0 });
  });
  it("does not percent-encode snippet values", () => {
    expect(renderSnippet({ text: "{clipboard}" }, env({ clipboard: "a b&c" })).text).toBe("a b&c");
  });
  it("computes ← presses for {cursor}", () => {
    expect(renderSnippet({ text: "Hello {cursor}, bye" }, env())).toEqual({ text: "Hello , bye", cursorLeft: 5 });
    expect(renderSnippet({ text: "<div>{cursor}</div>" }, env())).toEqual({ text: "<div></div>", cursorLeft: 6 });
    expect(renderSnippet({ text: "{cursor}" }, env()).cursorLeft).toBe(0);
    // Values after the cursor count too.
    expect(renderSnippet({ text: "({cursor}) {date format=\"yyyy\"}" }, env())).toEqual({ text: "() 2026", cursorLeft: 6 });
  });
  it("counts graphemes and CRLF as single caret steps; only the first cursor counts", () => {
    expect(cursorLeftCount("👍🏽é\r\nx")).toBe(4);
    expect(cursorLeftCount("🇳🇬")).toBe(1);
    expect(placeCursor("abc")).toEqual({ text: "abc", cursorLeft: 2 });
  });
  it("resolves nested snippets by name or keyword, guarding against cycles", () => {
    const all = [sn("1", "sig", "Best,\n{snippet name=\"me\"}"), sn("2", "me", "Olu {snippet name=\"sig\"}", { keyword: ";me" }), sn("3", "x", "{snippet name=\";me\"}!")];
    const lookup = snippetLookup(all);
    // sig → me → sig (once more) → me is already being expanded: stops.
    expect(renderSnippet(all[0]!, env({ snippet: lookup })).text).toBe("Best,\nOlu Best,\n");
    expect(renderSnippet(all[2]!, env({ snippet: lookup })).text).toBe("Olu Best,\nOlu !");
    expect(renderSnippet({ text: "{snippet name=\"missing\"}x" }, env({ snippet: lookup })).text).toBe("x");
  });
  it("renders rich text: values escaped in HTML, plain fallback kept", () => {
    const r = renderSnippet({ text: "Hi {clipboard}", html: "<b>Hi</b> {clipboard}" }, env({ clipboard: "<you>" }));
    expect(r).toEqual({ text: "Hi <you>", html: "<b>Hi</b> &lt;you&gt;", cursorLeft: 0 });
  });
  it("converts and sanitises HTML", () => {
    expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><ul><li>one</li><li>two</li></ul>a<br>b &amp; &#x41;")).toBe("Hi there\n• one\n• two\na\nb & A");
    expect(sanitizeHtml(`<b onclick="x()">x</b><script>alert(1)</script><a href="javascript:evil()">l</a>`)).toBe(`<b>x</b><a href="#">l</a>`);
  });
});

describe("keyword prefix and case-adaptive expansion", () => {
  it("prefixes keywords unless already prefixed", () => {
    expect(effectiveKeyword("sig", ";")).toBe(";sig");
    expect(effectiveKeyword(";sig", ";")).toBe(";sig");
    expect(effectiveKeyword(" sig ", "")).toBe("sig");
  });
  it("with a prefix, typing 'design' cannot end with the watched keyword", () => {
    const list = buildExpansionList({ snippets: [sn("1", "Signature", "Olu", { keyword: "sig" })], settings: { ...SNIPPET_DEFAULTS, keywordPrefix: ";" }, env: env() });
    expect(list.map((e) => e.keyword)).toEqual([";sig"]);
    expect("design".endsWith(list[0]!.keyword)).toBe(false);
    expect("de;sig".endsWith(list[0]!.keyword)).toBe(true);
    const bare = buildExpansionList({ snippets: [sn("1", "Signature", "Olu", { keyword: "sig" })], settings: SNIPPET_DEFAULTS, env: env() });
    expect("desig".endsWith(bare[0]!.keyword)).toBe(true);
  });
  it("warns about letters-only keywords without a prefix", () => {
    expect(keywordWarning("sig", "")).toMatch(/inside a longer word/);
    expect(keywordWarning("sig", ";")).toBeNull();
    expect(keywordWarning("!sig", "")).toBeNull();
  });
  it("adds Capitalised and UPPER variants", () => {
    expect(caseVariants(";addr", "12 main st")).toEqual([
      { keyword: ";addr", text: "12 main st" },
      { keyword: ";Addr", text: "12 Main st" },
      { keyword: ";ADDR", text: "12 MAIN ST" },
    ]);
    expect(caseVariants("sig", "best, olu")).toEqual([
      { keyword: "sig", text: "best, olu" },
      { keyword: "Sig", text: "Best, olu" },
      { keyword: "SIG", text: "BEST, OLU" },
    ]);
    expect(caseVariants("mySig", "x")).toEqual([{ keyword: "mySig", text: "x" }]);
    expect(caseVariants(";;1", "x")).toEqual([{ keyword: ";;1", text: "x" }]);
  });
  it("builds the list longest first, renders placeholders and drops {cursor}", () => {
    const list = buildExpansionList({
      snippets: [sn("1", "a", "Today is {date}{cursor}.", { keyword: "td" }), sn("2", "b", "x", { keyword: "td2" }), sn("3", "dup", "y", { keyword: "td" }), sn("4", "none", "z")],
      settings: { ...SNIPPET_DEFAULTS, keywordPrefix: "!" },
      env: env(),
    });
    expect(list).toEqual([
      { keyword: "!td2", text: "x", snippetId: "2" },
      { keyword: "!td", text: "Today is 2026-10-21.", snippetId: "1" },
    ]);
  });
  it("uses the plain text of HTML-only snippets", () => {
    const list = buildExpansionList({ snippets: [sn("1", "h", "", { keyword: ";h", html: "<b>Bold</b>" })], settings: SNIPPET_DEFAULTS, env: env() });
    expect(list[0]?.text).toBe("Bold");
  });
  it("expansionPlan adapts case to the typed keyword and returns the cursor offset", () => {
    const s = sn("1", "sig", "best,{cursor} olu", { keyword: "sig" });
    const settings = { ...SNIPPET_DEFAULTS, caseAdaptive: true };
    expect(expansionPlan("Sig", s, [s], settings, env())).toEqual({ deleteCount: 3, text: "Best, olu", cursorLeft: 4 });
    expect(expansionPlan("SIG", s, [s], settings, env())).toEqual({ deleteCount: 3, text: "BEST, OLU", cursorLeft: 4 });
    expect(expansionPlan(";sig", s, [s], SNIPPET_DEFAULTS, env())).toEqual({ deleteCount: 4, text: "best, olu", cursorLeft: 4 });
  });
});

describe("per-app exclusions", () => {
  const settings = sanitizeSnippetSettings({ excludedApps: ["com.apple.Terminal"] });
  const snippets = [sn("1", "a", "A", { keyword: ";a", excludedApps: ["com.microsoft.VSCode"] }), sn("2", "b", "B", { keyword: ";b" })];
  it("filters per snippet and globally (case-insensitive bundle ids)", () => {
    expect(expandsIn(snippets[0]!, settings, "com.microsoft.vscode")).toBe(false);
    expect(expandsIn(snippets[1]!, settings, "com.microsoft.VSCode")).toBe(true);
    expect(expandsIn(snippets[1]!, settings, "com.apple.Terminal")).toBe(false);
    expect(expandsIn(snippets[0]!, settings, null)).toBe(true);
    expect(buildExpansionList({ snippets, settings, env: env(), frontmostBundleId: "com.microsoft.VSCode" }).map((e) => e.keyword)).toEqual([";b"]);
    expect(buildExpansionList({ snippets, settings, env: env(), frontmostBundleId: "com.apple.Terminal" })).toEqual([]);
  });
  it("knows when tracking is needed", () => {
    expect(needsFrontmost(snippets, SNIPPET_DEFAULTS)).toBe(true);
    expect(needsFrontmost([snippets[1]!], SNIPPET_DEFAULTS)).toBe(false);
    expect(needsRefresh([sn("1", "a", "{date}", { keyword: "x" })])).toBe(true);
    expect(needsRefresh([sn("1", "a", "{date}")])).toBe(false);
  });
  it("sanitises settings", () => {
    expect(sanitizeSnippetSettings({ keywordPrefix: " ; ", caseAdaptive: "yes", excludedApps: ["a", 3, " "] })).toEqual({ keywordPrefix: ";", caseAdaptive: false, excludedApps: ["a"] });
  });
});

describe("import / export", () => {
  it("imports Raycast's snippet export and reports unsupported placeholders", () => {
    const raycast = JSON.stringify([
      { name: "Signature", text: "Best,\n{cursor}\n{clipboard}", keyword: "!sig" },
      { name: "Tab", text: "Current: {browser-tab}" },
      { name: "", text: "x" },
    ]);
    expect(parseSnippetImport(raycast)).toEqual({
      snippets: [
        { name: "Signature", text: "Best,\n{cursor}\n{clipboard}", keyword: "!sig" },
        { name: "Tab", text: "Current: {browser-tab}" },
      ],
      skipped: 1,
      unsupported: ["{browser-tab}"],
    });
  });
  it("round-trips Glide exports", () => {
    const list = [sn("a", "A", "t", { html: "<b>t</b>", keyword: ";a", excludedApps: ["x"] })];
    expect(parseSnippetImport(JSON.stringify(exportSnippets(list, NOW))).snippets).toEqual([{ name: "A", text: "t", html: "<b>t</b>", keyword: ";a", excludedApps: ["x"] }]);
  });
  it("merges: skips duplicates and drops conflicting keywords", () => {
    const r = mergeImported([{ name: "A", text: "t" }, { name: "B", text: "u", keyword: ";a" }, { name: "C", text: "v", keyword: ";c" }], [sn("1", "a", "t", { keyword: ";a" })]);
    expect(r).toEqual({ add: [{ name: "B", text: "u" }, { name: "C", text: "v", keyword: ";c" }], duplicates: 1, keywordConflicts: 1 });
  });
});
