import { BrowserWindow, shell } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import type { WindowAction } from "../../native/helper";
import type { FeatureContext, FeatureModule } from "../types";
import { SUGGESTED_HOTKEYS, WINDOW_COMMANDS, itemId } from "./commands";

const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const NEEDS_ACCESSIBILITY = "Glide needs Accessibility permission to move windows. Press ⌘K → Open Accessibility Settings, enable Glide, then try again.";
const DEFAULTS = { suggestedHotkeys: false };

let ctx: FeatureContext | null = null;
const registered = new Map<string, boolean>(); // accelerator -> registered OK

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Apply a window action to the app that was frontmost before Glide. */
export async function applyWindowAction(action: WindowAction): Promise<ExecuteResult> {
  const c = ctx;
  if (!c) return { ok: false, error: "Window management is not ready" };
  if (!c.helper.available()) return { ok: false, error: "Window management needs the Glide helper, which is not running." };
  const perms = await c.helper.call("permissions.status").catch(() => null);
  if (perms && !perms.accessibility) return { ok: false, error: NEEDS_ACCESSIBILITY };
  // Hide first so the target app is frontmost again; skip the wait when Glide isn't focused (global hotkey).
  if (BrowserWindow.getFocusedWindow()) {
    c.hideLauncher();
    await sleep(120);
  }
  const r = await c.helper.call("windows.apply", { action });
  if (!r.ok) return { ok: false, hide: true, error: r.error === "Accessibility permission required" ? NEEDS_ACCESSIBILITY : r.error };
  return { ok: true, hide: true };
}

function syncSuggestedHotkeys(): void {
  const c = ctx;
  if (!c) return;
  const on = c.settings(DEFAULTS).suggestedHotkeys === true;
  registered.clear();
  for (const h of SUGGESTED_HOTKEYS) {
    const ok = c.registerHotkey(h.action, on ? h.accelerator : null, () => void applyWindowAction(h.action).then((r) => r.ok || c.log(r.error)));
    if (on) registered.set(h.accelerator, ok);
  }
}

function state() {
  const on = ctx?.settings(DEFAULTS).suggestedHotkeys === true;
  return {
    suggestedHotkeys: on,
    hotkeys: SUGGESTED_HOTKEYS.map((h) => ({
      display: h.display,
      action: h.action,
      title: WINDOW_COMMANDS.find((c) => c.action === h.action)?.title ?? h.action,
      registered: on ? registered.get(h.accelerator) === true : false,
    })),
  };
}

export const feature: FeatureModule = {
  id: "windows",
  start(c) {
    ctx = c;
    syncSuggestedHotkeys();
    // The host's hotkey sync unregisters every global shortcut on each data change; re-assert ours.
    c.store.on("change", () => syncSuggestedHotkeys());
  },
  stop() {
    for (const h of SUGGESTED_HOTKEYS) ctx?.registerHotkey(h.action, null, () => undefined);
    ctx = null;
  },
  items(): SearchItem[] {
    const on = ctx?.settings(DEFAULTS).suggestedHotkeys === true;
    return WINDOW_COMMANDS.map((cmd) => {
      const suggested = on ? SUGGESTED_HOTKEYS.find((h) => h.action === cmd.action) : undefined;
      return {
        id: itemId(cmd.action),
        kind: "command",
        title: cmd.title,
        subtitle: "Window Management",
        icon: { kind: "symbol", value: cmd.glyph },
        keywords: cmd.keywords,
        feature: "windows",
        kindLabel: "Window",
        data: { action: cmd.action },
        ...(suggested ? { hotkey: suggested.display } : {}),
      };
    });
  },
  actions(item): ItemAction[] {
    return [
      { id: "apply", title: item.title, icon: "🪟" },
      { id: "open-accessibility", title: "Open Accessibility Settings", icon: "🔐", shortcut: "⌘⏎" },
      { id: "window-settings", title: "Window Management Settings…", icon: "⚙️" },
    ];
  },
  async runAction(scored, actionId) {
    if (actionId === "open-accessibility") {
      await shell.openExternal(ACCESSIBILITY_PANE);
      return { ok: true, hide: true };
    }
    if (actionId === "window-settings") {
      ctx?.openSettings("windows");
      return { ok: true, hide: true };
    }
    const action = scored.item.data?.action;
    if (typeof action !== "string" || !WINDOW_COMMANDS.some((c) => c.action === action)) return { ok: false, error: "Unknown window action" };
    return applyWindowAction(action as WindowAction);
  },
  methods: {
    getState: () => state(),
    setSuggestedHotkeys: (on: unknown) => {
      ctx?.setSettings({ suggestedHotkeys: on === true });
      syncSuggestedHotkeys();
      ctx?.refreshCatalogue();
      return state();
    },
    apply: (action: unknown) => (typeof action === "string" ? applyWindowAction(action as WindowAction) : { ok: false, error: "Invalid action" }),
    openAccessibilitySettings: () => shell.openExternal(ACCESSIBILITY_PANE),
  },
};
