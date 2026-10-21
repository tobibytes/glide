import { describe, expect, it, vi } from "vitest";
import type { ScheduleEvent, ScheduleResult } from "../../calendar/types";
import type { Timer } from "../../timers/model";
import { DEFAULT_PRESETS } from "../../timers/model";
import { agentSpec, clipboardSpec, meetingSpec, meetingTitle, nextEvent, sysmonSpec, sysmonTitle, timersSpec, truncate, untilLabel, type TimerActions } from "./specs";

const NOW = new Date(2026, 9, 21, 10, 0, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m).toISOString();
const ev = (p: Partial<ScheduleEvent>): ScheduleEvent => ({ id: "e", title: "Standup", start: at(10, 30), end: at(11), allDay: false, calendar: "Work", meeting: null, ...p });
const actions = (): TimerActions => ({ toggle: vi.fn(), add: vi.fn(), stop: vi.fn(), stopwatchToggle: vi.fn(), stopwatchRemove: vi.fn(), startPreset: vi.fn(), show: vi.fn() });
const timer = (p: Partial<Timer> = {}): Timer => ({ id: "t1", name: "Tea", durationMs: 180_000, startedAt: NOW - 60_000, pausedAt: null, pausedMs: 0, ...p });

describe("title formatting", () => {
  it("system monitor shows CPU and memory percentages, clamped", () => {
    expect(sysmonTitle(0.123)).toBe("CPU 12%");
    expect(sysmonTitle(1.4, { totalBytes: 100, usedBytes: 63 } as never)).toBe("CPU 100% · MEM 63%");
  });

  it("until-label uses minutes then hours", () => {
    expect(untilLabel(NOW - 1, NOW)).toBe("now");
    expect(untilLabel(NOW + 4.2 * 60_000, NOW)).toBe("in 5m");
    expect(untilLabel(NOW + 60 * 60_000, NOW)).toBe("in 1h");
    expect(untilLabel(NOW + 80 * 60_000, NOW)).toBe("in 1h 20m");
  });

  it("meeting title is the next not-ended timed event today, truncated", () => {
    const events = [ev({ id: "a", title: "All hands", allDay: true, start: at(0), end: at(23, 59) }), ev({ id: "b", title: "Done", start: at(8), end: at(9) }), ev({ id: "c", title: "A very long planning meeting title" })];
    expect(nextEvent(events, NOW)?.id).toBe("c");
    expect(meetingTitle(events, NOW)).toBe("A very long plann… in 30m");
    expect(meetingTitle([ev({ start: at(9, 45), end: at(10, 15) })], NOW)).toBe("Standup now");
    expect(meetingTitle([], NOW)).toBe("");
  });

  it("truncate collapses whitespace", () => {
    expect(truncate("  a\n b  ", 10)).toBe("a b");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("timers extra", () => {
  it("is hidden without timers or when the timers feature hides the menu-bar countdown", () => {
    const base = { timers: [], stopwatches: [], presets: DEFAULT_PRESETS, settings: { showInMenuBar: true } };
    expect(timersSpec(base, "", NOW, actions())).toBeNull();
    expect(timersSpec({ ...base, timers: [timer()], settings: { showInMenuBar: false } }, "⏱ 2:00", NOW, actions())).toBeNull();
  });

  it("uses the shim title and offers pause / stop per timer", () => {
    const a = actions();
    const spec = timersSpec({ timers: [timer()], stopwatches: [], presets: DEFAULT_PRESETS, settings: { showInMenuBar: true } }, "⏱ 2:00", NOW, a)!;
    expect(spec.title).toBe("⏱ 2:00");
    const row = spec.menu[0]!;
    expect(row.title).toBe("Tea");
    expect(row.submenu?.map((s) => s.title)).toEqual(["Pause", "Add 1 Minute", "Add 5 Minutes", undefined, "Stop Timer"]);
    row.submenu![0]!.onClick!();
    row.submenu![4]!.onClick!();
    expect(a.toggle).toHaveBeenCalledWith("t1");
    expect(a.stop).toHaveBeenCalledWith("t1");
    expect(spec.menu.find((m) => m.title === "Start Preset")?.submenu?.length).toBe(DEFAULT_PRESETS.length);
  });

  it("menu rows carry no ticking countdown, so the menu is stable second to second", () => {
    const s = { timers: [timer()], stopwatches: [], presets: [], settings: { showInMenuBar: true } };
    const a = timersSpec(s, "⏱ 2:00", NOW, actions())!;
    const b = timersSpec(s, "⏱ 1:59", NOW + 1000, actions())!;
    expect(JSON.stringify(a.menu)).toBe(JSON.stringify(b.menu));
  });
});

describe("meeting extra", () => {
  const a = { join: vi.fn(), openCalendar: vi.fn(), schedule: vi.fn(), requestAccess: vi.fn(), refresh: vi.fn() };
  const ok = (events: ScheduleEvent[]): ScheduleResult => ({ status: "ok", from: at(0), to: at(23), events });

  it("lists today's events with Join links and a Join-next shortcut", () => {
    const spec = meetingSpec(ok([ev({ meeting: { url: "https://meet.google.com/abc-defg-hij", provider: "Google Meet" } }), ev({ id: "x", title: "Lunch", start: at(12), end: at(13) })]), NOW, a);
    expect(spec.title).toBe("Standup in 30m");
    expect(spec.menu[0]).toMatchObject({ title: "Join “Standup”", subtitle: "Google Meet" });
    spec.menu[0]!.onClick!();
    expect(a.join).toHaveBeenCalledWith("https://meet.google.com/abc-defg-hij");
    const lunch = spec.menu.find((m) => m.title?.includes("Lunch"))!;
    lunch.onClick!();
    expect(a.openCalendar).toHaveBeenCalled();
  });

  it("explains a missing permission and offers the explicit grant action", () => {
    const spec = meetingSpec({ status: "notDetermined", message: "Glide needs permission", from: "", to: "", events: [] }, NOW, a);
    expect(spec.title).toBe("");
    expect(spec.menu.map((m) => m.title)).toContain("Grant Calendar Access…");
  });
});

describe("clipboard, sysmon and agent extras", () => {
  it("clipboard shows at most 10 entries with ⌘1…⌘0 and pastes on click", () => {
    const paste = vi.fn();
    const entries = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, type: "text" as const, title: `entry ${i}`, pinned: i === 0 }));
    const spec = clipboardSpec(entries, paste, vi.fn());
    const rows = spec.menu.filter((m) => m.onClick && m.shortcut);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ icon: "📌", shortcut: "CommandOrControl+1" });
    expect(rows[9]?.shortcut).toBe("CommandOrControl+0");
    rows[3]!.onClick!();
    expect(paste).toHaveBeenCalledWith("c3");
  });

  it("sysmon spec lists CPU, load and memory", () => {
    const spec = sysmonSpec({ cpu: 0.5, cores: 8, load: [1, 2, 3], memory: { totalBytes: 16 * 2 ** 30, usedBytes: 8 * 2 ** 30 } as never }, vi.fn());
    expect(spec.title).toBe("CPU 50% · MEM 50%");
    expect(spec.menu.map((m) => m.title)).toEqual(["CPU 50%", "Load 1.00  2.00  3.00", "Memory 50%", undefined, "Open System Monitor…"]);
  });

  it("agent spec shows quick entry, suggestions and a running task", () => {
    const ask = vi.fn();
    const cancel = vi.fn();
    const idle = agentSpec(null, { ask, cancel });
    expect(idle.title).toBe("");
    idle.menu[0]!.onClick!();
    idle.menu[1]!.submenu![0]!.onClick!();
    expect(ask).toHaveBeenNthCalledWith(2, "Arrange my windows side by side");
    const busy = agentSpec({ runId: "r1", prompt: "tidy windows", status: "running" }, { ask, cancel });
    expect(busy.title).toBe("…");
    busy.menu.find((m) => m.title === "Cancel Run")!.onClick!();
    expect(cancel).toHaveBeenCalledWith("r1");
  });
});
