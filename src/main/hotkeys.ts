import { globalShortcut } from "electron";

export interface HotkeyBinding {
  accel: string;
  handler: () => void;
}

// Only the accelerators this module registered. Feature modules register their own
// hotkeys through FeatureContext.registerHotkey; unregisterAll() here would drop them.
const owned = new Set<string>();

/** Replace the launcher and per-item shortcuts; returns accelerators that could not be registered. */
export function syncHotkeys(bindings: HotkeyBinding[]): string[] {
  for (const accel of owned) globalShortcut.unregister(accel);
  owned.clear();
  const seen = new Set<string>();
  const failed: string[] = [];
  for (const b of bindings) {
    const key = b.accel.trim();
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    try {
      if (globalShortcut.register(key, b.handler)) owned.add(key);
      else failed.push(key);
    } catch {
      failed.push(key);
    }
  }
  return failed;
}
