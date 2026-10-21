import { describe, expect, it } from "vitest";
import { canonicalAccel, knownHotkeyConflict, parseFakePermissions, PERMISSION_PANES, permissionMap } from "./system";

describe("hotkey conflicts", () => {
  it("canonicalises modifier aliases and order", () => {
    expect(canonicalAccel("Cmd+Space")).toBe("command+space");
    expect(canonicalAccel("Shift+Cmd+K")).toBe(canonicalAccel("Command+Shift+K"));
    expect(canonicalAccel("Alt+Space")).toBe("option+space");
  });

  it("flags macOS shortcuts and modifier-less keys", () => {
    expect(knownHotkeyConflict("Cmd+Space")).toMatch(/Spotlight/);
    expect(knownHotkeyConflict("Ctrl+Space")).toMatch(/input source/);
    expect(knownHotkeyConflict("Cmd+Q")).toMatch(/quits/);
    expect(knownHotkeyConflict("A")).toMatch(/modifier/);
    expect(knownHotkeyConflict("Shift+A")).toMatch(/capital/);
    expect(knownHotkeyConflict("F5")).toBeNull();
    expect(knownHotkeyConflict("Alt+Space")).toBeNull();
    expect(knownHotkeyConflict("Ctrl+Alt+Cmd+G")).toBeNull();
  });
});

describe("permission checklist", () => {
  it("maps helper status and Electron fallbacks", () => {
    const m = permissionMap({ accessibility: true, inputMonitoring: false, calendar: "notDetermined", reminders: "authorized" }, { screen: "denied" });
    expect(m).toEqual({ accessibility: "granted", inputMonitoring: "denied", screenRecording: "denied", calendars: "notDetermined", reminders: "granted" });
  });

  it("falls back to unknown without the helper", () => {
    expect(permissionMap(null, { accessibility: true, screen: "granted" })).toEqual({
      accessibility: "granted",
      inputMonitoring: "unknown",
      screenRecording: "granted",
      calendars: "unknown",
      reminders: "unknown",
    });
  });

  it("parses fakes and ignores junk", () => {
    expect(parseFakePermissions({ accessibility: true, screenRecording: "denied", calendars: "weird", nope: "granted" })).toEqual({
      accessibility: "granted",
      inputMonitoring: "unknown",
      screenRecording: "denied",
      calendars: "unknown",
      reminders: "unknown",
    });
    expect(parseFakePermissions(null)).toBeNull();
  });

  it("opens System Settings privacy panes", () => {
    for (const url of Object.values(PERMISSION_PANES)) expect(url).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/);
  });
});
