/**
 * Themes & Appearance: presets, accent, density, font size, radius, launcher width and
 * translucency. Settings live in Settings.features.appearance (the light/dark/system mode is the
 * global Settings.theme); renderers apply them as CSS variables when data changes, so every
 * window updates live. Main applies what CSS cannot: nativeTheme, vibrancy and the panel width.
 */
import { app, BrowserWindow, nativeTheme } from "electron";
import type { ItemAction } from "@shared/ipc";
import type { SearchItem, Settings } from "@shared/types";
import { setLauncherWidth } from "../../window";
import type { FeatureContext, FeatureModule } from "../types";
import { DEFAULT_APPEARANCE, normalizeAppearance, PRESETS, presetById, resolvePreset, type AppearanceSettings } from "./themes";

let ctx: FeatureContext | undefined;
let lastApplied = "";

const current = (): AppearanceSettings => normalizeAppearance(ctx?.settings({ ...DEFAULT_APPEARANCE }));
const mode = (): Settings["theme"] => ctx?.getGlobalSettings().theme ?? "system";

/** The launcher is the window whose page is the root route ("#/" or no hash). */
function launcherWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => {
    if (w.isDestroyed()) return false;
    const hash = new URL(w.webContents.getURL() || "about:blank").hash;
    return hash === "" || hash === "#/" || hash === "#";
  });
}

function applyNative(): void {
  const s = current();
  const m = mode();
  const key = JSON.stringify([m, s.vibrancy, s.translucency, s.width]);
  if (key === lastApplied) return;
  lastApplied = key;
  nativeTheme.themeSource = m;
  setLauncherWidth(s.width);
  const win = launcherWindow();
  if (!win) return;
  // Vibrancy only makes sense behind a see-through panel.
  try {
    win.setVibrancy(s.vibrancy && s.translucency > 0 ? "under-window" : null);
  } catch (err) {
    ctx?.log("vibrancy unavailable", err);
  }
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  if (w !== s.width) win.setBounds({ x: Math.round(x + (w - s.width) / 2), y, width: s.width, height: h }, false);
}

function setSettings(patch: unknown): AppearanceSettings {
  const next = normalizeAppearance({ ...current(), ...(typeof patch === "object" && patch !== null ? patch : {}) });
  ctx?.setSettings({ ...next });
  return next;
}

function setMode(m: unknown): Settings["theme"] {
  if (m === "system" || m === "dark" || m === "light") ctx?.store.setSettings({ theme: m });
  return mode();
}

/** Pick a preset: it becomes the dark or light slot (by its scheme) and the mode follows it unless "system" already shows it. */
function applyPreset(id: unknown): { ok: boolean; mode: Settings["theme"] } {
  const p = typeof id === "string" ? presetById(id) : undefined;
  if (!p) return { ok: false, mode: mode() };
  setSettings(p.scheme === "dark" ? { darkTheme: p.id } : { lightTheme: p.id });
  const m = mode();
  const systemScheme = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI || nativeTheme.shouldUseDarkColors ? "dark" : "light";
  if (!(m === "system" && systemScheme === p.scheme) && m !== p.scheme) setMode(p.scheme);
  return { ok: true, mode: mode() };
}

function toggleLightDark(): Settings["theme"] {
  const m = mode();
  const dark = m === "dark" || (m === "system" && nativeTheme.shouldUseDarkColors);
  return setMode(dark ? "light" : "dark");
}

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[]): SearchItem => ({
  id: `appearance:${id}`,
  kind: "command",
  kindLabel: "Appearance",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "appearance",
  data: { action: id },
});

export const feature: FeatureModule = {
  id: "appearance",
  start(c) {
    ctx = c;
    applyNative();
    c.store.on("change", () => applyNative());
    // The launcher is created after features start; apply vibrancy/width once it exists.
    app.on("browser-window-created", (_e, win) =>
      win.webContents.once("did-finish-load", () => {
        lastApplied = "";
        applyNative();
      }),
    );
  },
  items: () => {
    const s = current();
    const active = resolvePreset(mode(), nativeTheme.shouldUseDarkColors, s);
    return [
      item("switch", "Switch Theme", active.name, "🎨", ["theme", "appearance", "color", "scheme", "dark", "light", ...PRESETS.map((p) => p.name.toLowerCase())]),
      item("toggle", "Toggle Light/Dark Appearance", `Now: ${mode() === "system" ? "System" : mode() === "dark" ? "Dark" : "Light"}`, "🌓", ["dark mode", "light mode", "appearance", "theme", "night"]),
      item("settings", "Appearance Settings", "Themes, accent, density, fonts", "🖌️", ["appearance", "theme", "font", "density", "accent", "translucency", "vibrancy"]),
    ];
  },
  actions(i): ItemAction[] {
    switch (i.data?.action) {
      case "switch":
        return [{ id: "switch", title: "Switch Theme", shortcut: "⏎" }, { id: "settings", title: "Open Appearance Settings", shortcut: "⌘⏎" }];
      case "toggle":
        return [{ id: "toggle", title: "Toggle Light/Dark", shortcut: "⏎" }, { id: "system", title: "Follow System Appearance", shortcut: "⌘⏎" }];
      case "settings":
        return [{ id: "settings", title: "Open Appearance Settings", shortcut: "⏎" }];
      default:
        return [];
    }
  },
  async runAction(_scored, actionId) {
    if (actionId === "switch") return { ok: true, view: { id: "appearance.switch", props: { title: "Switch Theme" } } };
    if (actionId === "settings") return { ok: true, navigate: "appearance" };
    if (actionId === "system") {
      setMode("system");
      return { ok: true, message: "Following the system appearance" };
    }
    if (actionId === "toggle") {
      const m = toggleLightDark();
      return { ok: true, message: `Appearance: ${m === "dark" ? "Dark" : "Light"}` };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    get: () => ({ settings: current(), mode: mode(), systemDark: nativeTheme.shouldUseDarkColors, presets: PRESETS }),
    set: (patch) => setSettings(patch),
    setMode: (m) => setMode(m),
    applyPreset: (id) => applyPreset(id),
    toggle: () => toggleLightDark(),
    reset: () => setSettings({ ...DEFAULT_APPEARANCE }),
  },
};
