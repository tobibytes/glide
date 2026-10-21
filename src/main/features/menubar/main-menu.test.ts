import { describe, expect, it, vi } from "vitest";
import { buildMainMenu, topRecent, type MainMenuActions } from "./main-menu";

const NOW = new Date(2026, 9, 21, 10, 0).getTime();
const actions = (): MainMenuActions => ({
  open: vi.fn(), run: vi.fn(), join: vi.fn(), openCalendar: vi.fn(), focusToggle: vi.fn(), focusStop: vi.fn(), focusShow: vi.fn(), settings: vi.fn(), menuBarSettings: vi.fn(), quit: vi.fn(),
  timer: { toggle: vi.fn(), add: vi.fn(), stop: vi.fn(), stopwatchToggle: vi.fn(), stopwatchRemove: vi.fn(), startPreset: vi.fn(), show: vi.fn() },
});

describe("Glide menu", () => {
  it("minimal menu: Open, Settings, Menu Bar Settings, Quit", () => {
    const m = buildMainMenu({ now: NOW, recent: [] }, actions());
    expect(m.map((i) => i.title ?? "—")).toEqual(["Open Glide", "—", "Settings…", "Menu Bar Settings…", "—", "Quit Glide"]);
  });

  it("includes recents, running timers with pause/stop, next event and focus status", () => {
    const a = actions();
    const m = buildMainMenu(
      {
        now: NOW,
        hotkey: "Alt+Space",
        recent: [{ id: "app:safari", title: "Safari", icon: "🧭" }],
        timers: { timers: [{ id: "t1", name: "Tea", durationMs: 180_000, startedAt: NOW - 60_000, pausedAt: null, pausedMs: 0 }], stopwatches: [] },
        nextEvent: { id: "e", title: "Standup", start: new Date(NOW + 15 * 60_000).toISOString(), end: new Date(NOW + 30 * 60_000).toISOString(), allDay: false, calendar: "W", meeting: { url: "https://zoom.us/j/1", provider: "Zoom" } },
        focus: { goal: "Write", status: "running", remainingMs: 600_000 },
      },
      a,
    );
    const titles = m.map((i) => i.title);
    expect(m[0]).toMatchObject({ title: "Open Glide", shortcut: "Alt+Space" });
    expect(titles).toContain("Safari");
    expect(titles).toContain("Tea — 2:00");
    expect(titles).toContain("Standup in 15m");
    expect(titles).toContain("Focus: Write — 10:00 left");
    m.find((i) => i.title === "Safari")!.onClick!();
    expect(a.run).toHaveBeenCalledWith("app:safari");
    m.find((i) => i.title === "Tea — 2:00")!.submenu!.find((s) => s.title === "Stop Timer")!.onClick!();
    expect(a.timer.stop).toHaveBeenCalledWith("t1");
    m.find((i) => i.title === "Standup in 15m")!.onClick!();
    expect(a.join).toHaveBeenCalledWith("https://zoom.us/j/1");
    m.find((i) => i.title?.startsWith("Focus"))!.submenu![0]!.onClick!();
    expect(a.focusToggle).toHaveBeenCalled();
  });

  it("topRecent orders by score, skips unresolvable ids and caps at 5", () => {
    const recs = ["a", "b", "gone", "c", "d", "e", "f"].map((itemId, i) => ({ itemId, s: i }));
    const out = topRecent(recs, (r) => r.s, (id) => (id === "gone" ? undefined : { id, title: id.toUpperCase() }));
    expect(out.map((r) => r.id)).toEqual(["f", "e", "d", "c", "b"]);
  });
});
