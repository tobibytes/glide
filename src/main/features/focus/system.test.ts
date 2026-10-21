import { describe, expect, it } from "vitest";
import { isBrowser, parseLsappinfo } from "./system";

describe("parseLsappinfo", () => {
  it("parses name, bundle id and pid", () => {
    const out = '"CFBundleIdentifier"="com.google.Chrome"\n"LSDisplayName"="Google Chrome"\n"pid"=67901\n';
    expect(parseLsappinfo(out)).toEqual({ name: "Google Chrome", bundleId: "com.google.Chrome", pid: 67901 });
  });
  it("handles missing bundle ids and garbage", () => {
    expect(parseLsappinfo('"LSDisplayName"="tool"\n"pid"=5')).toEqual({ name: "tool", bundleId: null, pid: 5 });
    expect(parseLsappinfo("")).toBeNull();
  });
  it("knows browsers", () => {
    expect(isBrowser("com.apple.Safari")).toBe(true);
    expect(isBrowser("company.thebrowser.Browser")).toBe(true);
    expect(isBrowser("com.apple.mail")).toBe(false);
    expect(isBrowser(null)).toBe(false);
  });
});
