import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMenuBarManager, menuKey, type TrayHandle } from "./core";
import type { MenuBarMenuItem } from "../../menubar";

interface FakeTray extends TrayHandle {
  calls: string[];
  menus: MenuBarMenuItem[][];
  destroyed: boolean;
}

function fakeFactory() {
  const trays = new Map<string, FakeTray>();
  const factory = (id: string): TrayHandle => {
    const t: FakeTray = {
      calls: [],
      menus: [],
      destroyed: false,
      setTitle: (x) => void t.calls.push(`title:${x}`),
      setIcon: (x) => void t.calls.push(`icon:${x ?? ""}`),
      setTooltip: (x) => void t.calls.push(`tooltip:${x}`),
      setMenu: (m) => {
        t.calls.push("menu");
        t.menus.push(m);
      },
      destroy: () => void (t.destroyed = true),
    };
    trays.set(id, t);
    return t;
  };
  return { trays, factory };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("menu-bar manager", () => {
  it("keeps state only until activated, then renders every registration", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.register({ id: "a", title: "A", menu: [{ title: "x" }] });
    expect(trays.size).toBe(0);
    expect(m.state()[0]).toMatchObject({ id: "a", title: "A", rendered: false });
    m.activate(factory);
    expect(trays.get("a")?.calls).toEqual(["title:A", "icon:", "menu"]);
    expect(m.state()[0]?.rendered).toBe(true);
  });

  it("headless (null factory) never creates trays but tracks specs", () => {
    const m = createMenuBarManager();
    m.activate(null);
    const h = m.register({ id: "a", title: "1", menu: [] });
    h.update({ title: "2", menu: [{ title: "Item", onClick: () => undefined }] });
    m.flush();
    expect(m.state()).toEqual([expect.objectContaining({ id: "a", title: "2", rendered: false, menu: [{ title: "Item", clickable: true }] })]);
  });

  it("diffs: a title-only change does not rebuild the menu", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.activate(factory);
    const h = m.register({ id: "t", title: "1:00", menu: [{ title: "Pause" }] });
    vi.advanceTimersByTime(300);
    h.update({ title: "0:59", menu: [{ title: "Pause" }] });
    const t = trays.get("t")!;
    expect(t.calls).toEqual(["title:1:00", "icon:", "menu", "title:0:59"]);
    expect(m.state()[0]?.renders).toEqual({ title: 2, icon: 1, tooltip: 0, menu: 1 });
  });

  it("new click closures are used without rebuilding the native menu", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.activate(factory);
    const first = vi.fn();
    const second = vi.fn();
    const h = m.register({ id: "c", menu: [{ title: "Go", onClick: first }] });
    h.update({ menu: [{ title: "Go", onClick: second }] });
    vi.advanceTimersByTime(1000);
    const t = trays.get("c")!;
    expect(t.menus).toHaveLength(1);
    t.menus[0]![0]!.onClick!();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("throttles to at most 4 renders per second and applies the latest spec on the trailing edge", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.activate(factory);
    const h = m.register({ id: "s", title: "0", menu: [] });
    for (let i = 1; i <= 100; i++) {
      h.update({ title: String(i), menu: [] });
      vi.advanceTimersByTime(10); // 100 updates over one second
    }
    vi.advanceTimersByTime(250);
    const titles = trays.get("s")!.calls.filter((c) => c.startsWith("title:"));
    expect(titles.length).toBeLessThanOrEqual(5); // initial + ≤ 4 in the following second
    expect(titles.at(-1)).toBe("title:100");
  });

  it("rebuilds the menu when its structure changes (submenus, checked, separators)", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.activate(factory);
    const menu: MenuBarMenuItem[] = [{ title: "A", submenu: [{ title: "B", checked: false }] }, { separator: true }];
    const h = m.register({ id: "m", menu });
    vi.advanceTimersByTime(300);
    h.update({ menu: [{ title: "A", submenu: [{ title: "B", checked: true }] }, { separator: true }] });
    expect(trays.get("m")!.menus).toHaveLength(2);
    expect(menuKey(menu)).not.toBe(menuKey(trays.get("m")!.menus[1]!));
  });

  it("remove() destroys the tray, cancels pending renders and ignores later updates", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.activate(factory);
    const h = m.register({ id: "r", title: "x", menu: [] });
    h.update({ title: "y", menu: [] }); // queued (throttled)
    h.remove();
    vi.advanceTimersByTime(1000);
    const t = trays.get("r")!;
    expect(t.destroyed).toBe(true);
    expect(t.calls).toEqual(["title:x", "icon:", "menu"]);
    h.update({ title: "z", menu: [] });
    expect(m.items()).toHaveLength(0);
  });

  it("re-registering an id replaces the spec and reuses the tray", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.activate(factory);
    m.register({ id: "d", title: "1", menu: [] });
    vi.advanceTimersByTime(300);
    m.register({ id: "d", title: "2", menu: [] });
    expect(m.items()).toEqual([{ id: "d", title: "2", menu: [] }]);
    expect(trays.size).toBe(1);
    expect(trays.get("d")!.calls).toContain("title:2");
  });

  it("click() dispatches by path into submenus", () => {
    const m = createMenuBarManager();
    const fn = vi.fn();
    m.register({ id: "p", menu: [{ title: "top" }, { title: "sub", submenu: [{ separator: true }, { title: "leaf", onClick: fn }] }] });
    expect(m.click("p", [1, 1])).toBe(true);
    expect(m.click("p", [0])).toBe(false);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("deactivate() destroys trays; activate() re-renders from scratch", () => {
    const m = createMenuBarManager();
    const { trays, factory } = fakeFactory();
    m.activate(factory);
    m.register({ id: "q", title: "x", menu: [] });
    const first = trays.get("q")!;
    m.deactivate();
    expect(first.destroyed).toBe(true);
    m.activate(factory);
    expect(trays.get("q")).not.toBe(first);
    expect(trays.get("q")!.calls).toEqual(["title:x", "icon:", "menu"]);
  });

  it("a throwing tray does not break the manager", () => {
    const onError = vi.fn();
    const m = createMenuBarManager({ onError });
    m.activate(() => {
      throw new Error("no status bar");
    });
    m.register({ id: "e", title: "x", menu: [] });
    expect(onError).toHaveBeenCalled();
    expect(m.state()[0]?.title).toBe("x");
  });
});
