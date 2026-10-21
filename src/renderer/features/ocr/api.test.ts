import { describe, expect, it, vi } from "vitest";
vi.mock("../../lib/glide", () => ({ glide: () => ({}) }));
import { readResult, translatePrompt } from "./api";

describe("ocr view props", () => {
  it("reads a text result", () => {
    const r = readResult({ kind: "text", source: "clipboard", text: "hi", lines: 1, words: 1, chars: 2, links: ["https://a", 3], copied: true });
    expect(r).toEqual({ kind: "text", source: "clipboard", text: "hi", lines: 1, words: 1, chars: 2, links: ["https://a"], copied: true, permissionHint: false });
  });
  it("maps permission and garbage", () => {
    expect(readResult({ kind: "permission" })).toEqual({ kind: "permission" });
    expect(readResult({ kind: "text" })).toMatchObject({ kind: "error" });
    expect(readResult({ kind: "error", message: "boom", permissionHint: true })).toEqual({ kind: "error", message: "boom", permissionHint: true });
  });
  it("builds a translation prompt", () => {
    expect(translatePrompt("Bonjour", "")).toMatch(/into English/);
    expect(translatePrompt("Hello", "French")).toMatch(/into French[\s\S]*Hello$/);
  });
});
