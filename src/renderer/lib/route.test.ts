import { describe, expect, it } from "vitest";
import { parseRoute, settingsHash } from "./route";

describe("parseRoute", () => {
  it("launcher", () => {
    expect(parseRoute("")).toEqual({ mode: "launcher" });
    expect(parseRoute("#/")).toEqual({ mode: "launcher" });
  });
  it("core settings pages", () => {
    expect(parseRoute("#/settings")).toEqual({ mode: "settings", page: "general", anchor: undefined });
    expect(parseRoute("#/settings/workflows/abc")).toEqual({ mode: "settings", page: "workflows", id: "abc", anchor: undefined });
    expect(parseRoute("settings/general#hotkey")).toEqual({ mode: "settings", page: "general", id: undefined, anchor: "hotkey" });
  });
  it("feature settings pages", () => {
    expect(parseRoute("#/settings/clipboard")).toEqual({ mode: "settings", page: "feature", id: "clipboard", anchor: undefined });
    expect(settingsHash("feature", "clipboard")).toBe("#/settings/clipboard");
  });
  it("feature windows", () => {
    expect(parseRoute("#/ai/chat")).toEqual({ mode: "window", route: "ai/chat" });
    expect(parseRoute("#/notes/floating?x=1")).toEqual({ mode: "window", route: "notes/floating" });
  });
});
