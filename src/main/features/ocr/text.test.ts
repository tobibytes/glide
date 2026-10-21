import { describe, expect, it } from "vitest";
import { assembleText, classifyPayload, extractLinks, isOpenable, stats, type RecognizedLine } from "./text";

const run = (text: string, x: number, y: number, width = 0.2, height = 0.05, confidence = 1): RecognizedLine => ({ text, confidence, box: { x, y, width, height } });

describe("assembleText", () => {
  it("orders rows top to bottom and runs left to right", () => {
    const lines = [run("world", 0.4, 0.1), run("second line", 0.1, 0.17), run("Hello", 0.1, 0.1)];
    expect(assembleText(lines)).toBe("Hello world\nsecond line");
  });
  it("separates paragraphs on large gaps", () => {
    const lines = [run("Title", 0.1, 0.05), run("Body one", 0.1, 0.3), run("Body two", 0.1, 0.36)];
    expect(assembleText(lines)).toBe("Title\n\nBody one\nBody two");
  });
  it("groups slightly misaligned runs on one row", () => {
    const lines = [run("A", 0.1, 0.1, 0.1, 0.05), run("B", 0.5, 0.115, 0.1, 0.05)];
    expect(assembleText(lines)).toBe("A B");
  });
  it("drops empty and low-confidence runs", () => {
    expect(assembleText([run(" ", 0, 0), run("noise", 0, 0.2, 0.1, 0.05, 0.1), run("ok", 0, 0.3)], 0.3)).toBe("ok");
    expect(assembleText([])).toBe("");
  });
});

describe("classifyPayload", () => {
  it("recognizes links, mail, phone and other schemes", () => {
    expect(classifyPayload("https://example.com/a?b=1")).toMatchObject({ kind: "url", url: "https://example.com/a?b=1" });
    expect(classifyPayload("www.example.com")).toMatchObject({ kind: "url", url: "https://www.example.com" });
    expect(classifyPayload("mailto:me@x.io?subject=hi")).toMatchObject({ kind: "email", label: "me@x.io" });
    expect(classifyPayload("me@x.io")).toMatchObject({ kind: "email", url: "mailto:me@x.io" });
    expect(classifyPayload("tel:+15551234")).toMatchObject({ kind: "phone", label: "+15551234" });
    expect(classifyPayload("otpauth://totp/x?secret=y")).toMatchObject({ kind: "uri" });
  });
  it("never opens dangerous schemes", () => {
    expect(classifyPayload("javascript:alert(1)")).toMatchObject({ kind: "text", url: null });
    expect(isOpenable("file:///etc/passwd")).toBe(false);
    expect(isOpenable("https://x.y")).toBe(true);
  });
  it("parses Wi-Fi codes with escapes", () => {
    const c = classifyPayload("WIFI:T:WPA;S:My\\;Net;P:pa\\:ss;;");
    expect(c.kind).toBe("wifi");
    expect(c.wifi).toEqual({ ssid: "My;Net", password: "pa:ss", security: "WPA" });
  });
  it("treats everything else as text", () => {
    expect(classifyPayload("just some words")).toMatchObject({ kind: "text", url: null, label: "just some words" });
    expect(classifyPayload("x".repeat(100)).label).toHaveLength(80);
  });
});

describe("extractLinks / stats", () => {
  it("finds links and emails", () => {
    expect(extractLinks("See https://a.com/x. Or www.b.org, mail c@d.io (https://a.com/x)")).toEqual(["https://a.com/x", "https://www.b.org", "mailto:c@d.io"]);
  });
  it("counts", () => {
    expect(stats("a b\n\nc")).toEqual({ lines: 2, words: 3, chars: 6 });
    expect(stats("")).toEqual({ lines: 0, words: 0, chars: 0 });
  });
});
