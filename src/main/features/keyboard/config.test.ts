import { describe, expect, it } from "vitest";
import { KEYBOARD_DEFAULTS, buildKeyConfig, hotkeyAfterTakeover, snippetKeywords } from "./config";

const snip = (id: string, keyword: string | undefined, text = `text ${id}`) => ({ id, name: id, text, keyword });

describe("keyboard config", () => {
  it("keeps only snippets with a keyword, trims, dedupes and sorts longest first", () => {
    const out = snippetKeywords([snip("a", ";sig"), snip("b", undefined), snip("c", "  "), snip("d", " ;sig2 "), snip("e", ";sig", "dupe"), snip("f", ";x", "")]);
    expect(out).toEqual([
      { keyword: ";sig2", text: "text d" },
      { keyword: ";sig", text: "text a" },
    ]);
  });

  it("sends nothing without Accessibility", () => {
    expect(buildKeyConfig({ ...KEYBOARD_DEFAULTS, hyperKey: "capslock" }, [snip("a", ";a")], false)).toEqual({ snippets: [], hyperKey: "off" });
  });

  it("respects the expansion toggle, hyper key and paste stack", () => {
    expect(buildKeyConfig({ ...KEYBOARD_DEFAULTS, expandSnippets: false, hyperKey: "capslock" }, [snip("a", ";a")], true)).toEqual({ snippets: [], hyperKey: "capslock", pasteStack: false });
    expect(buildKeyConfig({ ...KEYBOARD_DEFAULTS, expandSnippets: false }, [], true, true)).toEqual({ snippets: [], hyperKey: "off", pasteStack: true });
    expect(buildKeyConfig(KEYBOARD_DEFAULTS, [], false, true)).toEqual({ snippets: [], hyperKey: "off" });
    expect(buildKeyConfig(KEYBOARD_DEFAULTS, [snip("a", ";a")], true).snippets).toHaveLength(1);
  });

  it("restores a sensible hotkey after the ⌘Space takeover", () => {
    expect(hotkeyAfterTakeover("Alt+Cmd+K")).toBe("Alt+Cmd+K");
    expect(hotkeyAfterTakeover("")).toBe("Alt+Space");
    expect(hotkeyAfterTakeover("Command+Space")).toBe("Alt+Space");
  });
});
