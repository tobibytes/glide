import { globalShortcut } from "electron";
import { HEADLESS, recordHeadless } from "./headless";
import { createHotkeyManager, type HotkeyManager, type HotkeyStatus } from "./hotkey-manager";
import type { NativeHelper } from "./native/helper";

export interface HotkeyBinding {
  accel: string;
  handler: () => void;
}

let manager: HotkeyManager | null = null;

const electronBackend = {
  register: (accel: string, handler: () => void) => globalShortcut.register(accel, handler),
  unregister: (accel: string) => globalShortcut.unregister(accel),
};

/** Call once at startup, before any hotkey is registered. Without a helper, Electron's globalShortcut is used. */
export function configureHotkeys(helper: NativeHelper | null): void {
  manager?.dispose();
  manager = createHotkeyManager({ helper, electron: electronBackend, headless: HEADLESS, record: recordHeadless });
}

function get(): HotkeyManager {
  manager ??= createHotkeyManager({ helper: null, electron: electronBackend, headless: HEADLESS, record: recordHeadless });
  return manager;
}

/** Replace the launcher and per-item shortcuts; returns accelerators known to have failed (more may fail asynchronously). */
export function syncHotkeys(bindings: HotkeyBinding[]): string[] {
  return get().sync("core", bindings);
}

/** FeatureContext.registerHotkey: set or clear one feature slot. */
export function registerFeatureHotkey(slot: string, accelerator: string | null, handler: () => void): boolean {
  return get().set(slot, accelerator, handler);
}

export function hotkeyStatus(): HotkeyStatus {
  return get().status();
}

export function isHotkeyActive(accelerator: string): boolean {
  return get().isActive(accelerator);
}

export function hotkeysSettled(): Promise<void> {
  return get().settled();
}

export function disposeHotkeys(): void {
  manager?.dispose();
  manager = null;
}
