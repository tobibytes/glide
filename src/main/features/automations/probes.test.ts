import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { diffApps, isInterestingFile, networkIdentity, parseArpMac, parseIpconfigSummary, parsePmset, parseVisibleProcessList, parseWifiDevice } from "./probes";
import { EventSources, FolderWatcher } from "./sources";
import type { TriggerEvent } from "./model";

describe("parsers", () => {
  it("lsappinfo visibleProcessList", () => {
    expect(parseVisibleProcessList('ASN:0x0-0x4c44c4-"Ghostty": ASN:0x0-0x411411-"Google_Chrome": ASN:0x0-0xf00f-"Finder": \n')).toEqual(["Ghostty", "Google Chrome", "Finder"]);
  });
  it("diffApps", () => {
    expect(diffApps(["A", "B"], ["C", "A"])).toEqual({ launched: ["C"], quit: ["B"], activated: "C" });
    expect(diffApps(["A", "B"], ["A", "B"])).toEqual({ launched: [], quit: [], activated: null });
  });
  it("pmset", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t99%; discharging; 9:39 remaining present: true")).toEqual({ source: "battery", percent: 99 });
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;")).toEqual({ source: "ac", percent: 100 });
    expect(parsePmset("Now drawing from 'AC Power'\n")).toEqual({ source: "ac", percent: -1 });
    expect(parsePmset("")).toBeNull();
  });
  it("wifi device, summary, arp and identity", () => {
    expect(parseWifiDevice("Hardware Port: Ethernet\nDevice: en1\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: x")).toBe("en0");
    const redacted = parseIpconfigSummary("<dictionary> {\n  BSSID : <redacted>\n  SSID : <redacted>\n      Router : 10.0.0.1\n}");
    expect(redacted).toEqual({ connected: true, ssid: null, router: "10.0.0.1" });
    expect(networkIdentity(redacted, parseArpMac("? (10.0.0.1) at 8:3a:88:1:2:3 on en0 ifscope [ethernet]"))).toBe("Router 10.0.0.1 · 8:3a:88:1:2:3");
    expect(networkIdentity(parseIpconfigSummary("  SSID : Home\n  Router : 1.1.1.1"), null)).toBe("Home");
    expect(networkIdentity(parseIpconfigSummary("<dictionary> {\n}"), null)).toBeNull();
  });
  it("ignores hidden files and partial downloads", () => {
    expect(isInterestingFile("a.pdf")).toBe(true);
    expect(isInterestingFile(".DS_Store")).toBe(false);
    expect(isInterestingFile("big.iso.crdownload")).toBe(false);
  });
});

describe("FolderWatcher", () => {
  it("reports added files (with full path) and plain changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glide-fw-"));
    try {
      fs.writeFileSync(path.join(dir, "old.txt"), "x");
      const events: TriggerEvent[] = [];
      const w = new FolderWatcher(dir, (e) => events.push(e));
      expect(w.start()).toBe(true);
      fs.writeFileSync(path.join(dir, "new.txt"), "x");
      fs.writeFileSync(path.join(dir, ".hidden"), "x");
      w.scan();
      fs.writeFileSync(path.join(dir, "old.txt"), "y");
      w.scan();
      w.stop();
      expect(events).toEqual([
        { type: "folder", path: dir, event: "added", file: path.join(dir, "new.txt") },
        { type: "folder", path: dir, event: "changed", file: dir },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EventSources", () => {
  it("starts only the pollers enabled automations need, and diffs app snapshots into events", async () => {
    vi.useFakeTimers();
    const outputs = ['ASN:0-"Finder": ASN:0-"Notes":', 'ASN:0-"Safari": ASN:0-"Finder":'];
    const events: TriggerEvent[] = [];
    const run = vi.fn(async (cmd: string) => (cmd === "lsappinfo" ? (outputs.shift() ?? 'ASN:0-"Safari": ASN:0-"Finder":') : ""));
    const keys = new Map<string, string | null>();
    const src = new EventSources({ emit: (e) => events.push(e), run, registerHotkey: (k, a) => (keys.set(k, a), a !== "Bad+Key"), home: "/h", log: () => undefined, intervals: { app: 1000 } });
    const base = { enabled: true, askBeforeRunning: false, target: { kind: "workflow" as const, workflowId: "w" }, createdAt: 0, updatedAt: 0, log: [] };
    expect(src.sync([{ ...base, id: "x", name: "x", trigger: { kind: "launch" } }])).toEqual({});
    expect(src.active()).toEqual([]);
    const problems = src.sync([
      { ...base, id: "a", name: "a", trigger: { kind: "app", event: "launched", app: "" } },
      { ...base, id: "h", name: "h", trigger: { kind: "hotkey", accelerator: "Alt+A" } },
      { ...base, id: "bad", name: "bad", trigger: { kind: "hotkey", accelerator: "Bad+Key" } },
      { ...base, id: "f", name: "f", trigger: { kind: "folder", path: "/definitely/not/here", event: "added" } },
    ]);
    expect(Object.keys(problems).sort()).toEqual(["bad", "f"]);
    expect(src.active()).toEqual(["apps", "hotkey:Alt+A"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([
      { type: "app", event: "launched", name: "Safari" },
      { type: "app", event: "quit", name: "Notes" },
      { type: "app", event: "activated", name: "Safari" },
    ]);
    src.stop();
    expect(src.active()).toEqual([]);
    expect(keys.get("h")).toBeNull();
    vi.useRealTimers();
  });
});
