import { describe, expect, it } from "vitest";
import type { Workflow } from "@shared/types";
import { describeTrigger, isRiskyTarget, matchEvent, normalizeTrigger, validateAutomation, type Trigger } from "./model";

const wf = (id: string, types: Workflow["actions"][number]["type"][], extra: Partial<Workflow> = {}): Workflow => ({
  id,
  name: id,
  icon: { kind: "emoji", value: "⚙️" },
  actions: types.map((type, i) => ({ id: `${id}-${i}`, type, params: (type === "runWorkflow" ? { workflowId: "inner" } : {}) as Record<string, string> })),
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe("validation", () => {
  it("normalizes triggers and rejects bad input", () => {
    expect(normalizeTrigger({ kind: "time", time: "7:05", days: [5, 1, 1, 9] })).toEqual({ kind: "time", time: "07:05", days: [1, 5] });
    expect(normalizeTrigger({ kind: "time", time: "25:00", days: [] })).toBeNull();
    expect(normalizeTrigger({ kind: "interval", minutes: 0 })).toEqual({ kind: "interval", minutes: 1 });
    expect(normalizeTrigger({ kind: "interval", minutes: "30" })).toEqual({ kind: "interval", minutes: 30 });
    expect(normalizeTrigger({ kind: "folder", path: "  " })).toBeNull();
    expect(normalizeTrigger({ kind: "nope" })).toBeNull();
    expect(normalizeTrigger({ kind: "time", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ kind: "time", time: "09:00", days: [] });
  });
  it("validateAutomation fills defaults and requires a target", () => {
    const r = validateAutomation({ trigger: { kind: "launch" }, target: { kind: "workflow", workflowId: "w" } }, 5);
    expect(r.ok && r.automation).toMatchObject({ name: "When Glide launches", enabled: true, askBeforeRunning: false, createdAt: 5, log: [] });
    expect(validateAutomation({ trigger: { kind: "launch" }, target: { kind: "workflow" } }, 5)).toEqual({ ok: false, error: "Choose a workflow or command to run" });
    expect(validateAutomation({ trigger: { kind: "time", time: "x" }, target: { kind: "workflow", workflowId: "w" } }, 5)).toEqual({ ok: false, error: "Enter a time like 09:00" });
  });
});

describe("describeTrigger", () => {
  it.each<[Trigger, string]>([
    [{ kind: "time", time: "09:00", days: [] }, "Every day at 09:00"],
    [{ kind: "time", time: "09:00", days: [1, 2, 3, 4, 5] }, "Weekdays at 09:00"],
    [{ kind: "interval", minutes: 1 }, "Every minute"],
    [{ kind: "interval", minutes: 120 }, "Every 2 hours"],
    [{ kind: "app", event: "quit", app: "Safari" }, "When “Safari” quits"],
    [{ kind: "power", event: "below", percent: 20 }, "When battery drops to 20%"],
    [{ kind: "folder", path: "~/Downloads", event: "added" }, "When a file is added to ~/Downloads"],
  ])("%j → %s", (t, text) => expect(describeTrigger(t)).toBe(text));
});

describe("matchEvent", () => {
  it("apps: name (spaces/underscores alike), bundle id, or any", () => {
    const t: Trigger = { kind: "app", event: "launched", app: "Google Chrome" };
    expect(matchEvent(t, { type: "app", event: "launched", name: "Google_Chrome" }, "a")).toBe("Google_Chrome");
    expect(matchEvent(t, { type: "app", event: "quit", name: "Google Chrome" }, "a")).toBeNull();
    expect(matchEvent({ kind: "app", event: "activated", app: "com.apple.Safari" }, { type: "app", event: "activated", name: "Safari", bundleId: "com.apple.safari" }, "a")).toBe("Safari");
    expect(matchEvent({ kind: "app", event: "quit", app: "" }, { type: "app", event: "quit", name: "Notes" }, "a")).toBe("Notes");
  });
  it("wifi joined/left/changed", () => {
    const join: Trigger = { kind: "wifi", event: "joined", network: "Home" };
    expect(matchEvent(join, { type: "wifi", from: null, to: "home" }, "a")).toBe("home");
    expect(matchEvent(join, { type: "wifi", from: "Home", to: "Work" }, "a")).toBeNull();
    expect(matchEvent({ kind: "wifi", event: "left", network: "Home" }, { type: "wifi", from: "Home", to: null }, "a")).toBe("Home");
    expect(matchEvent({ kind: "wifi", event: "changed", network: "" }, { type: "wifi", from: "A", to: "B" }, "a")).toBe("B");
    expect(matchEvent({ kind: "wifi", event: "joined", network: "" }, { type: "wifi", from: "A", to: null }, "a")).toBeNull();
  });
  it("power thresholds fire on crossing only", () => {
    const below: Trigger = { kind: "power", event: "below", percent: 20 };
    const ev = (percent: number, prevPercent: number, source: "ac" | "battery" = "battery", prevSource: "ac" | "battery" = "battery") => ({ type: "power" as const, percent, prevPercent, source, prevSource });
    expect(matchEvent(below, ev(20, 21), "a")).toBe("20");
    expect(matchEvent(below, ev(19, 20), "a")).toBeNull(); // already below
    expect(matchEvent(below, ev(15, 15, "battery", "ac"), "a")).toBe("15"); // unplugged while low
    expect(matchEvent(below, ev(15, 16, "ac", "ac"), "a")).toBeNull(); // charging
    expect(matchEvent({ kind: "power", event: "above", percent: 80 }, ev(80, 79, "ac", "ac"), "a")).toBe("80");
    expect(matchEvent({ kind: "power", event: "ac", percent: 1 }, ev(50, 50, "ac", "battery"), "a")).toBe("50");
    expect(matchEvent({ kind: "power", event: "ac", percent: 1 }, ev(51, 50, "ac", "ac"), "a")).toBeNull();
  });
  it("folder: expands ~, passes the file, 'added' ignores plain changes", () => {
    const t: Trigger = { kind: "folder", path: "~/Downloads/", event: "added" };
    expect(matchEvent(t, { type: "folder", path: "/Users/me/Downloads", event: "added", file: "/Users/me/Downloads/a.pdf" }, "a", "/Users/me")).toBe("/Users/me/Downloads/a.pdf");
    expect(matchEvent(t, { type: "folder", path: "/Users/me/Downloads", event: "changed", file: "/Users/me/Downloads" }, "a", "/Users/me")).toBeNull();
    expect(matchEvent(t, { type: "folder", path: "/Users/me/Desktop", event: "added", file: "/x" }, "a", "/Users/me")).toBeNull();
  });
  it("hotkey only fires its own automation; time triggers never match events", () => {
    expect(matchEvent({ kind: "hotkey", accelerator: "Alt+A" }, { type: "hotkey", automationId: "a" }, "a")).toBe("");
    expect(matchEvent({ kind: "hotkey", accelerator: "Alt+A" }, { type: "hotkey", automationId: "b" }, "a")).toBeNull();
    expect(matchEvent({ kind: "interval", minutes: 1 }, { type: "launch" }, "a")).toBeNull();
    expect(matchEvent({ kind: "launch" }, { type: "launch" }, "a")).toBe("");
  });
});

describe("isRiskyTarget", () => {
  it("flags shell/AppleScript/typing workflows, nested ones and unknown commands", () => {
    const list = [wf("safe", ["setVariable", "showResult", "notify"]), wf("shell", ["runShell"]), wf("inner", ["typeText"]), wf("outer", ["runWorkflow"])];
    expect(isRiskyTarget({ kind: "workflow", workflowId: "safe" }, list)).toBe(false);
    expect(isRiskyTarget({ kind: "workflow", workflowId: "shell" }, list)).toBe(true);
    expect(isRiskyTarget({ kind: "workflow", workflowId: "outer" }, list)).toBe(true);
    expect(isRiskyTarget({ kind: "workflow", workflowId: "missing" }, list)).toBe(true);
    expect(isRiskyTarget({ kind: "command", itemId: "syscmds:sleep", title: "Sleep", argument: "" }, list)).toBe(true);
    expect(isRiskyTarget({ kind: "command", itemId: "app:/Applications/Safari.app", title: "Safari", argument: "" }, list)).toBe(false);
  });
});
