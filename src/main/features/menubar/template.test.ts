import { describe, expect, it, vi } from "vitest";
import { displayAccelerator, statusText, toMenuTemplate } from "./template";

describe("toMenuTemplate", () => {
  it("maps titles, subtitles, emoji icons, accelerators, enabled, checked, separators and submenus", () => {
    const click = vi.fn();
    const t = toMenuTemplate([
      { title: "Open", shortcut: "CommandOrControl+O", icon: "🚀", subtitle: "now", onClick: click },
      { separator: true },
      { title: "Off", enabled: false },
      { title: "Check", checked: true },
      { title: "More", submenu: [{ title: "Leaf" }] },
    ]);
    expect(t[0]).toMatchObject({ label: "🚀  Open", sublabel: "now", accelerator: "CommandOrControl+O", registerAccelerator: false });
    t[0]!.click!({} as never, undefined, {} as never);
    expect(click).toHaveBeenCalledOnce();
    expect(t[1]).toEqual({ type: "separator" });
    expect(t[2]).toMatchObject({ label: "Off", enabled: false });
    expect(t[3]).toMatchObject({ type: "checkbox", checked: true });
    expect(t[4]!.submenu).toEqual([{ label: "Leaf" }]);
  });

  it("resolves PNG icons through the image callback, never inline", () => {
    const img = {} as never;
    const t = toMenuTemplate([{ title: "x", icon: "/tmp/iconTemplate.png" }], () => img);
    expect(t[0]).toMatchObject({ label: "x", icon: img });
  });

  it("drops malformed accelerators", () => {
    expect(displayAccelerator("Cmd++")).toBeUndefined();
    expect(displayAccelerator("Alt+Space")).toBe("Alt+Space");
  });

  it("status text combines emoji and title, with a fallback dot", () => {
    expect(statusText("12m", "📅")).toBe("📅 12m");
    expect(statusText("", undefined)).toBe("•");
    expect(statusText("", "/x/iconTemplate.png")).toBe("");
  });
});
