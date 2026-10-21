import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, fillTemplate, sanitizeCommand, slug } from "./templates";

describe("fillTemplate", () => {
  it("substitutes selection and argument", () => {
    expect(fillTemplate("Translate to {argument}:\n{selection}", { selection: "Hallo", argument: "English" })).toBe("Translate to English:\nHallo");
  });
  it("replaces every occurrence and blanks missing vars", () => {
    expect(fillTemplate("{selection}|{selection}|{argument}", { selection: "a" })).toBe("a|a|");
  });
  it("does not re-expand placeholders that appear inside the selection", () => {
    expect(fillTemplate("[{selection}] in {argument}", { selection: "literal {argument} and {selection}", argument: "French" })).toBe("[literal {argument} and {selection}] in French");
  });
  it("leaves unknown braces alone", () => {
    expect(fillTemplate("{foo} {selection}", { selection: "x" })).toBe("{foo} x");
  });
});

describe("built-in commands", () => {
  it("cover the Raycast set with unique ids and a {selection} placeholder", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    for (const n of ["Fix Spelling and Grammar", "Improve Writing", "Make Shorter", "Make Longer", "Change Tone to Friendly", "Change Tone to Professional", "Summarize", "Explain This in Simple Terms", "Translate to …", "Explain Code", "Find Bugs in Code"]) expect(names).toContain(n);
    expect(new Set(BUILTIN_COMMANDS.map((c) => c.id)).size).toBe(BUILTIN_COMMANDS.length);
    for (const c of BUILTIN_COMMANDS) expect(c.prompt).toContain("{selection}");
  });
  it("translate takes an argument", () => {
    const t = BUILTIN_COMMANDS.find((c) => c.id === "translate")!;
    expect(t.acceptsArgument).toBe(true);
    expect(fillTemplate(t.prompt, { selection: "Bonjour", argument: "German" })).toContain("into German");
  });
});

describe("sanitizeCommand", () => {
  it("rejects missing name or prompt", () => {
    expect(sanitizeCommand({ name: "", prompt: "x" })).toBeNull();
    expect(sanitizeCommand({ name: "x", prompt: "  " })).toBeNull();
    expect(sanitizeCommand(null)).toBeNull();
  });
  it("derives id, detects {argument}, defaults the icon", () => {
    const c = sanitizeCommand({ name: "Rewrite As Pirate!", prompt: "Pirate {selection} in {argument}" })!;
    expect(c.id).toBe("custom-rewrite-as-pirate");
    expect(c.acceptsArgument).toBe(true);
    expect(c.icon).toBe("🤖");
  });
  it("rejects unsafe ids", () => {
    expect(sanitizeCommand({ id: "../../etc", name: "A", prompt: "p" })!.id).toBe(slug("A"));
  });
});
