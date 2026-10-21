import { describe, expect, it } from "vitest";
import { calculatorItems, evaluate, formatNumber } from "./calculator";

describe("calculator", () => {
  it("evaluates basic arithmetic with precedence", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("(1 + 2) * 3")).toBe(9);
    expect(evaluate("10 / 4")).toBe(2.5);
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluate("-3 * -2")).toBe(6);
    expect(evaluate("1,000 + 1")).toBe(1001);
    expect(evaluate("3 × 4 ÷ 2")).toBe(6);
  });

  it("supports modulo and percentages", () => {
    expect(evaluate("17 % 5")).toBe(2);
    expect(evaluate("17 mod 5")).toBe(2);
    expect(evaluate("15% of 80")).toBe(12);
    expect(evaluate("80 + 15%")).toBe(92);
    expect(evaluate("200 - 10%")).toBe(180);
    expect(evaluate("50% * 4")).toBe(2);
  });

  it("supports functions and constants", () => {
    expect(evaluate("sqrt(16) + abs(-2)")).toBe(6);
    expect(evaluate("round(2.5)")).toBe(3);
    expect(evaluate("2 * pi")).toBeCloseTo(Math.PI * 2);
  });

  it("rejects non-math text and bare numbers", () => {
    expect(evaluate("safari")).toBeUndefined();
    expect(evaluate("42")).toBeUndefined();
    expect(evaluate("1 +")).toBeUndefined();
    expect(evaluate("(1 + 2")).toBeUndefined();
    expect(evaluate("2 * foo")).toBeUndefined();
    expect(evaluate("")).toBeUndefined();
  });

  it("formats numbers compactly", () => {
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1 / 3)).toBe("0.333333333333");
    expect(formatNumber(1 / 0)).toBe("∞");
  });

  it("produces a copyable calculator item", () => {
    const [item] = calculatorItems("6 * 7");
    expect(item?.item.kind).toBe("calculator");
    expect(item?.item.title).toBe("= 42");
    expect(item?.item.text).toBe("42");
    expect(item?.item.subtitle).toBe("Press Enter to copy");
    expect(calculatorItems("hello")).toEqual([]);
  });
});
