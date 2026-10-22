import { shell } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { PermissionStatus } from "../../native/helper";
import type { FeatureContext, FeatureModule } from "../types";
import { onExpansionChange } from "../../snippets/live";
import { onPasteStackInterceptChange, pasteStackIntercept } from "./pasteStack";
import { KEYBOARD_DEFAULTS, SPOTLIGHT_HOTKEY, buildKeyConfig, hotkeyAfterTakeover, snippetKeywords, type KeyboardSettings } from "./config";

const PANES = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  keyboardShortcuts: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Shortcuts",
} as const;

/** Snapshot rendered by the Keyboard settings page (also pushed as the "state" event). */
export interface KeyboardState {
  helperAvailable: boolean;
  permissions: PermissionStatus | null;
  settings: KeyboardSettings;
  /** Snippets that have a keyword (what expansion would watch for). */
  keywordCount: number;
  /** True when the helper's event tap is running with the current config. */
  active: boolean;
  spotlightShortcutEnabled: boolean | null;
  hotkey: string;
  lastError: string | null;
  expansions: number;
  /** ⌘V currently pastes the next Paste Stack item. */
  pasteStack: boolean;
}

let ctx: FeatureContext | null = null;
let permissions: PermissionStatus | null = null;
let lastSent = "";
let active = false;
let lastError: string | null = null;
let expansions = 0;
let sentPasteStack = false;
let spotlightEnabled: boolean | null = null;
let retryTimer: NodeJS.Timeout | undefined;
const unsubscribe: Array<() => void> = [];

const settings = (): KeyboardSettings => ctx?.settings(KEYBOARD_DEFAULTS) ?? KEYBOARD_DEFAULTS;

function state(): KeyboardState {
  return {
    helperAvailable: ctx?.helper.available() ?? false,
    permissions,
    settings: settings(),
    keywordCount: ctx ? snippetKeywords(ctx.getData().snippets).length : 0,
    active,
    spotlightShortcutEnabled: spotlightEnabled,
    hotkey: ctx?.getGlobalSettings().hotkey ?? "",
    lastError,
    expansions,
    pasteStack: active && sentPasteStack,
  };
}

const publish = () => ctx?.emit("state", state());

async function refreshPermissions(): Promise<void> {
  if (!ctx?.helper.available()) return;
  permissions = await ctx.helper.call("permissions.status").catch(() => permissions);
}

/** Send keys.configure when the effective config changed (helper replays it after restarts). */
async function configure(force = false): Promise<void> {
  const c = ctx;
  if (!c) return;
  if (!c.helper.available()) {
    // The helper may still be starting (or restarting): try again shortly.
    if (!retryTimer) retryTimer = setTimeout(() => ((retryTimer = undefined), void configure(force)), 1000);
    return;
  }
  if (!permissions) await refreshPermissions();
  const config = buildKeyConfig(settings(), c.getData().snippets, permissions?.accessibility === true, pasteStackIntercept());
  const key = JSON.stringify(config);
  if (!force && key === lastSent) return;
  lastSent = key;
  try {
    const r = await c.helper.call("keys.configure", config);
    const wanted = config.snippets.length > 0 || config.hyperKey !== "off" || config.pasteStack === true;
    active = r.ok && wanted;
    sentPasteStack = r.ok && config.pasteStack === true;
    lastError = r.ok ? null : (r.error ?? "Keyboard tap failed");
    if (!r.ok) lastSent = ""; // retry on the next change
  } catch (err) {
    lastSent = "";
    active = false;
    lastError = err instanceof Error ? err.message : String(err);
  }
  publish();
}

async function setUseCommandSpace(on: boolean): Promise<KeyboardState> {
  const c = ctx;
  if (!c) throw new Error("Keyboard feature is not ready");
  if (!c.helper.available()) throw new Error("The Glide helper is not running, so Spotlight's shortcut can't be changed.");
  const s = settings();
  if (on) {
    const r = await c.helper.call("system.setSpotlightShortcut", { enabled: false });
    if (!r.ok) throw new Error(r.error ?? "Could not turn off Spotlight's shortcut");
    const current = c.getGlobalSettings().hotkey;
    c.setSettings({ spotlightTakeover: true, previousHotkey: s.spotlightTakeover ? s.previousHotkey : current });
    c.store.setSettings({ hotkey: SPOTLIGHT_HOTKEY });
  } else {
    const r = await c.helper.call("system.setSpotlightShortcut", { enabled: true });
    if (!r.ok) throw new Error(r.error ?? "Could not restore Spotlight's shortcut");
    const restore = hotkeyAfterTakeover(s.previousHotkey);
    c.setSettings({ spotlightTakeover: false, previousHotkey: "" });
    if (c.getGlobalSettings().hotkey === SPOTLIGHT_HOTKEY) c.store.setSettings({ hotkey: restore });
  }
  spotlightEnabled = await c.helper.call("system.spotlightShortcut").then((r) => r.enabled).catch(() => spotlightEnabled);
  publish();
  return state();
}

async function requestPermission(kind: unknown): Promise<KeyboardState> {
  const c = ctx;
  if (kind !== "accessibility" && kind !== "inputMonitoring") throw new Error("Unknown permission");
  if (c?.helper.available()) permissions = await c.helper.call("permissions.request", { kind }).catch(() => permissions);
  await shell.openExternal(PANES[kind]);
  publish();
  return state();
}

async function toggleExpansion(): Promise<ExecuteResult> {
  const on = !settings().expandSnippets;
  ctx?.setSettings({ expandSnippets: on });
  await configure();
  if (on && permissions && !permissions.accessibility) {
    return { ok: true, message: "Snippet expansion is on — grant Accessibility in Keyboard settings for it to work" };
  }
  return { ok: true, message: on ? "Snippet expansion turned on" : "Snippet expansion turned off" };
}

export const feature: FeatureModule = {
  id: "keyboard",
  start(c) {
    ctx = c;
    unsubscribe.push(
      c.helper.on("permissions.changed", (p) => {
        permissions = p;
        void configure();
        publish();
      }),
      c.helper.on("keys.tapFailed", ({ reason }) => {
        lastError = reason;
        active = false;
        publish();
      }),
      c.helper.on("snippet.expanded", () => {
        expansions += 1;
      }),
    );
    // Re-send whenever snippets or our settings change (configure() skips identical configs).
    c.store.on("change", () => void configure());
    // Snippet prefix/exclusions/placeholders changed (src/main/snippets keeps them fresh).
    unsubscribe.push(onExpansionChange(() => void configure()));
    // The Paste Stack gained its first item or ran empty: start/stop intercepting ⌘V.
    unsubscribe.push(onPasteStackInterceptChange(() => void configure()));
    setTimeout(() => {
      void (async () => {
        await refreshPermissions();
        if (c.helper.available()) spotlightEnabled = await c.helper.call("system.spotlightShortcut").then((r) => r.enabled).catch(() => null);
        await configure();
      })();
    }, 300);
  },
  stop() {
    for (const off of unsubscribe.splice(0)) off();
    if (retryTimer) clearTimeout(retryTimer);
    ctx = null;
  },
  items: () => [
    {
      id: "keyboard.toggle-expansion",
      kind: "command",
      title: "Toggle Snippet Expansion",
      subtitle: settings().expandSnippets ? "Keyword expansion is on" : "Keyword expansion is off",
      icon: { kind: "symbol", value: "keyboard" },
      keywords: ["snippet", "expand", "expansion", "keyword", "text replacement", "typing"],
      feature: "keyboard",
      kindLabel: "Keyboard",
    },
    {
      id: "keyboard.settings",
      kind: "command",
      title: "Open Keyboard Settings",
      subtitle: "Snippet expansion, Hyper key, ⌘Space",
      icon: { kind: "symbol", value: "keyboard" },
      keywords: ["hyper", "caps lock", "spotlight", "command space", "permissions", "input monitoring", "accessibility"],
      feature: "keyboard",
      kindLabel: "Keyboard",
    },
  ],
  actions: (item) =>
    item.id === "keyboard.toggle-expansion"
      ? [
          { id: "toggle", title: "Toggle Snippet Expansion", icon: "⌨️" },
          { id: "settings", title: "Open Keyboard Settings", icon: "⚙️", shortcut: "⌘⏎" },
        ]
      : [{ id: "settings", title: "Open Keyboard Settings", icon: "⚙️" }],
  async runAction(_item, actionId) {
    if (actionId === "toggle") return toggleExpansion();
    ctx?.openSettings("keyboard");
    return { ok: true, hide: true };
  },
  methods: {
    getState: async () => {
      await refreshPermissions();
      return state();
    },
    setExpandSnippets: async (on: unknown) => {
      ctx?.setSettings({ expandSnippets: on === true });
      await configure();
      return state();
    },
    setHyperKey: async (mode: unknown) => {
      if (mode !== "off" && mode !== "capslock") throw new Error("Invalid Hyper key mode");
      ctx?.setSettings({ hyperKey: mode });
      await configure();
      return state();
    },
    setUseCommandSpace: (on: unknown) => setUseCommandSpace(on === true),
    requestPermission: (kind: unknown) => requestPermission(kind),
    openKeyboardShortcuts: () => shell.openExternal(PANES.keyboardShortcuts),
  },
};
