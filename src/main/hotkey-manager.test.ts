import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotkeyManager, type HotkeyManager, type ShortcutBackend } from "./hotkey-manager";
import type { HotkeySetResult, NativeHelper } from "./native/helper";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeHelper extends NativeHelper {
  up: boolean;
  calls: Array<{ method: string; params: unknown }>;
  answer: (bindings: Array<{ id: string; accelerator: string }>) => HotkeySetResult;
  emit(event: string, data: unknown): void;
}

function fakeHelper(opts: { up?: boolean; missing?: boolean } = {}): FakeHelper {
  const events = new EventEmitter();
  const h: FakeHelper = {
    up: opts.up ?? true,
    calls: [],
    answer: (bindings) => ({ registered: bindings.map((b) => b.id), failed: [] }),
    available: () => h.up,
    call: ((method: string, params?: unknown) => {
      h.calls.push({ method, params });
      if (opts.missing) return Promise.reject(new Error("Glide helper is not installed (expected /x). Run \"pnpm build:helper\"."));
      if (!h.up) return Promise.reject(new Error("Glide helper is not running (restarting)"));
      if (method === "ping") return Promise.resolve({ version: "test" });
      if (method === "hotkeys.set") return Promise.resolve(h.answer((params as { bindings: Array<{ id: string; accelerator: string }> }).bindings));
      return Promise.reject(new Error(`unexpected ${method}`));
    }) as NativeHelper["call"],
    on: ((event: string, cb: (d: unknown) => void) => {
      events.on(event, cb);
      return () => events.off(event, cb);
    }) as NativeHelper["on"],
    dispose: () => undefined,
    emit: (event, data) => events.emit(event, data),
  };
  return h;
}

function fakeElectron(taken: string[] = []) {
  const registered = new Map<string, () => void>();
  const backend: ShortcutBackend & { registered: Map<string, () => void>; log: string[] } = {
    registered,
    log: [],
    register: (accel, handler) => {
      backend.log.push(`+${accel}`);
      if (taken.includes(accel) || registered.has(accel)) return false;
      registered.set(accel, handler);
      return true;
    },
    unregister: (accel) => {
      backend.log.push(`-${accel}`);
      registered.delete(accel);
    },
  };
  return backend;
}

const setCalls = (h: FakeHelper) => h.calls.filter((c) => c.method === "hotkeys.set").map((c) => (c.params as { bindings: Array<{ id: string; accelerator: string }> }).bindings);

let mgr: HotkeyManager | null = null;
afterEach(() => {
  mgr?.dispose();
  mgr = null;
});

describe("hotkey manager", () => {
  it("routes through the helper when it is available and dispatches hotkey.pressed", async () => {
    const helper = fakeHelper();
    const electron = fakeElectron();
    mgr = createHotkeyManager({ helper, electron, pollMs: 5, startupGraceMs: 50, log: () => undefined });
    const launcher = vi.fn();
    mgr.sync("core", [{ accel: "Alt+Space", handler: launcher }, { accel: "CommandOrControl+Shift+K", handler: () => undefined }]);
    await mgr.settled();
    expect(mgr.status().backend).toBe("native");
    expect(electron.registered.size).toBe(0);
    const last = setCalls(helper).at(-1)!;
    expect(last.map((b) => b.accelerator)).toEqual(["Alt+Space", "Shift+Cmd+K"]);
    expect(mgr.isActive("Option+Space")).toBe(true);
    helper.emit("hotkey.pressed", { id: last[0]!.id });
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it("feature slots and the core set share one hotkeys.set and replace only their own entries", async () => {
    const helper = fakeHelper();
    mgr = createHotkeyManager({ helper, electron: fakeElectron(), pollMs: 5, startupGraceMs: 50, log: () => undefined });
    mgr.sync("core", [{ accel: "Alt+Space", handler: () => undefined }]);
    expect(mgr.set("clipboard:open", "Cmd+Shift+V", () => undefined)).toBe(true);
    await mgr.settled();
    mgr.sync("core", [{ accel: "Cmd+Space", handler: () => undefined }]);
    await mgr.settled();
    expect(setCalls(helper).at(-1)!.map((b) => b.accelerator).sort()).toEqual(["Cmd+Space", "Shift+Cmd+V"]);
    mgr.set("clipboard:open", null, () => undefined);
    await mgr.settled();
    expect(setCalls(helper).at(-1)!.map((b) => b.accelerator)).toEqual(["Cmd+Space"]);
  });

  it("reports Carbon failures (in use by another app) and macOS shortcut conflicts", async () => {
    const helper = fakeHelper();
    helper.answer = (bindings) => ({
      registered: bindings.filter((b) => b.accelerator !== "Ctrl+Space").map((b) => b.id),
      failed: bindings.filter((b) => b.accelerator === "Ctrl+Space").map((b) => ({ id: b.id, reason: "in use by another app" })),
      conflicts: bindings.filter((b) => b.accelerator === "Cmd+Space").map((b) => ({ id: b.id, reason: "also a macOS shortcut" })),
    });
    const logged: string[] = [];
    mgr = createHotkeyManager({ helper, electron: fakeElectron(), pollMs: 5, startupGraceMs: 50, log: (...a) => logged.push(a.join(" ")) });
    mgr.sync("core", [{ accel: "Ctrl+Space", handler: () => undefined }, { accel: "Cmd+Space", handler: () => undefined }]);
    await mgr.settled();
    const st = mgr.status().hotkeys;
    expect(st.find((h) => h.accelerator === "Ctrl+Space")).toMatchObject({ state: "failed", reason: "in use by another app" });
    expect(st.find((h) => h.accelerator === "Cmd+Space")).toMatchObject({ state: "active", warning: "also a macOS shortcut" });
    expect(mgr.isActive("Ctrl+Space")).toBe(false);
    expect(logged.some((l) => l.includes("Ctrl+Space") && l.includes("in use"))).toBe(true);
  });

  it("returns parse errors and duplicates synchronously", () => {
    mgr = createHotkeyManager({ helper: null, electron: fakeElectron(), log: () => undefined });
    expect(mgr.sync("core", [{ accel: "Cmd+Foo", handler: () => undefined }, { accel: "Alt+Space", handler: () => undefined }])).toEqual(["Cmd+Foo"]);
    expect(mgr.set("x:y", "Option+Space", () => undefined)).toBe(false);
    expect(mgr.status().hotkeys.find((h) => h.id === "feature:x:y")?.reason).toBe("used by another Glide hotkey");
  });

  it("falls back to Electron immediately when the helper binary is missing", async () => {
    const helper = fakeHelper({ up: false, missing: true });
    const electron = fakeElectron(["Ctrl+Space"]);
    mgr = createHotkeyManager({ helper, electron, pollMs: 5, startupGraceMs: 5000, log: () => undefined });
    mgr.sync("core", [{ accel: "Alt+Space", handler: () => undefined }]);
    await sleep(10);
    expect(mgr.status().backend).toBe("electron");
    expect([...electron.registered.keys()]).toEqual(["Alt+Space"]);
    // Synchronous answers in Electron mode, including "in use" and modifier-only.
    expect(mgr.sync("core", [{ accel: "Ctrl+Space", handler: () => undefined }, { accel: "Double+Cmd", handler: () => undefined }])).toEqual(["Ctrl+Space", "Double+Cmd"]);
    expect(mgr.status().hotkeys.find((h) => h.accelerator === "Double+Cmd")?.reason).toMatch(/helper/);
    expect(mgr.status().hotkeys.find((h) => h.accelerator === "Ctrl+Space")?.reason).toBe("in use by another app");
    expect(setCalls(helper)).toHaveLength(0);
  });

  it("without any helper uses Electron with Hyper expanded and handlers wired", () => {
    const electron = fakeElectron();
    mgr = createHotkeyManager({ helper: null, electron, log: () => undefined });
    const h = vi.fn();
    expect(mgr.set("w:max", "Hyper+K", h)).toBe(true);
    electron.registered.get("Ctrl+Alt+Shift+Cmd+K")!();
    expect(h).toHaveBeenCalled();
  });

  it("uses Electron after the startup grace, then migrates to the helper and re-sends after a restart", async () => {
    const helper = fakeHelper({ up: false });
    const electron = fakeElectron();
    mgr = createHotkeyManager({ helper, electron, pollMs: 5, startupGraceMs: 30, log: () => undefined });
    mgr.sync("core", [{ accel: "Alt+Space", handler: () => undefined }]);
    expect(mgr.status().backend).toBe("pending");
    expect(electron.registered.size).toBe(0);
    await sleep(60);
    expect(mgr.status().backend).toBe("electron");
    expect(electron.registered.has("Alt+Space")).toBe(true);

    helper.up = true;
    await sleep(20);
    await mgr.settled();
    expect(mgr.status().backend).toBe("native");
    expect(electron.registered.size).toBe(0);
    const sends = setCalls(helper).length;
    expect(sends).toBeGreaterThan(0);

    // Helper restart (down briefly, then up): registrations are re-sent.
    helper.up = false;
    await sleep(12);
    helper.up = true;
    await sleep(20);
    await mgr.settled();
    expect(setCalls(helper).length).toBeGreaterThan(sends);
    expect(mgr.status().backend).toBe("native");
  });

  it("re-sends when Input Monitoring is granted", async () => {
    const helper = fakeHelper();
    let granted = false;
    helper.answer = (bindings) => ({
      registered: granted ? bindings.map((b) => b.id) : [],
      failed: granted ? [] : bindings.map((b) => ({ id: b.id, reason: "needs Input Monitoring" })),
    });
    mgr = createHotkeyManager({ helper, electron: fakeElectron(), pollMs: 5, startupGraceMs: 50, log: () => undefined });
    mgr.sync("core", [{ accel: "Double⌘", handler: () => undefined }]);
    await mgr.settled();
    expect(mgr.status().hotkeys[0]).toMatchObject({ state: "failed", reason: "needs Input Monitoring" });
    granted = true;
    helper.emit("permissions.changed", { accessibility: true, inputMonitoring: true, calendar: "notDetermined" });
    await mgr.settled();
    expect(mgr.status().hotkeys[0]).toMatchObject({ state: "active", accelerator: "Double⌘" });
  });

  it("headless: records hotkey.register and never calls hotkeys.set", async () => {
    const helper = fakeHelper();
    const records: Array<[string, unknown]> = [];
    mgr = createHotkeyManager({ helper, electron: fakeElectron(), headless: true, record: (k, d) => records.push([k, d]), pollMs: 5, startupGraceMs: 50, log: () => undefined });
    const h = vi.fn();
    mgr.sync("core", [{ accel: "Command+Space", handler: h }]);
    await mgr.settled();
    expect(setCalls(helper)).toHaveLength(0);
    expect(records).toEqual([["hotkey.register", { id: "core:Cmd+Space", accelerator: "Cmd+Space" }]]);
    expect(mgr.isActive("Cmd+Space")).toBe(true);
    helper.emit("hotkey.pressed", { id: "core:Cmd+Space" });
    expect(h).not.toHaveBeenCalled();
  });
});
