import { describe, expect, it } from "vitest";
import { evaluateCondition, substitute, substituteParams } from "./template";

describe("substitute", () => {
  it("replaces known variables and blanks unknown ones", () => {
    expect(substitute("Hello {{name}}, {{missing}}!", { name: "Ada" })).toBe("Hello Ada, !");
  });
  it("tolerates whitespace inside the braces", () => {
    expect(substitute("{{ input }} / {{result}}", { input: "a", result: "b" })).toBe("a / b");
  });
  it("leaves unrelated braces alone", () => {
    expect(substitute("{a} {{}} {{{x}}}", { x: "1" })).toBe("{a} {{}} {1}");
  });
  it("substitutes every param", () => {
    expect(substituteParams({ url: "https://x/?q={{clipboard}}", other: "static" }, { clipboard: "hi there" })).toEqual({
      url: "https://x/?q=hi there",
      other: "static",
    });
  });
});

describe("evaluateCondition", () => {
  it("handles string operators", () => {
    expect(evaluateCondition("hello", "equals", "hello")).toBe(true);
    expect(evaluateCondition("hello", "contains", "ell")).toBe(true);
    expect(evaluateCondition("hello", "startsWith", "he")).toBe(true);
    expect(evaluateCondition("hello", "matches regex", "^h.*o$")).toBe(true);
    expect(evaluateCondition("hello", "matches regex", "(")).toBe(false);
    expect(evaluateCondition("  ", "isEmpty", "")).toBe(true);
    expect(evaluateCondition("x", "isNotEmpty", "")).toBe(true);
  });
  it("compares numerically when both sides are numbers", () => {
    expect(evaluateCondition("10", ">", "9")).toBe(true);
    expect(evaluateCondition("10", "<", "9")).toBe(false);
    expect(evaluateCondition("b", ">", "a")).toBe(true);
  });
  it("is false for unknown operators", () => {
    expect(evaluateCondition("a", "nope", "a")).toBe(false);
  });
});
