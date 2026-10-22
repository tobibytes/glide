/**
 * First-run onboarding: a dedicated window (#/onboarding/welcome) that walks a new user through
 * the hotkey, macOS permissions, AI, look & feel and a cheat sheet. Shown automatically once on a
 * fresh install (see firstrun.ts); reopen any time with the "Welcome to Glide" command.
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, nativeTheme, shell, systemPreferences } from "electron";
import { hotkeysSettled, isHotkeyActive } from "../../hotkeys";
import type { ExecuteResult } from "@shared/ipc";
import type { SearchItem } from "@shared/types";
import { HEADLESS } from "../../headless";
import type { PermissionStatus } from "../../native/helper";
import type { FeatureContext, FeatureModule } from "../types";
import { decideFirstRun, predatesLaunch, settingsCustomised, type FirstRunDecision } from "./firstrun";
import { isStep, normalizeOnboarding, ONBOARDING_DEFAULTS, type OnboardingSettings } from "./steps";
import { canonicalAccel, isPermissionKind, knownHotkeyConflict, parseFakePermissions, PERMISSION_PANES, permissionMap, type PermissionKind, type PermissionsSnapshot } from "./system";

export const ONBOARDING_ROUTE = "onboarding/welcome";
const SPOTLIGHT = "Command+Space";
/** When this process started (module load happens before the store touches the data dir). */
const launchedAt = Date.now() - process.uptime() * 1000;

let ctx: FeatureContext | null = null;
let win: BrowserWindow | null = null;
let decision: FirstRunDecision | null = null;
let openTimer: NodeJS.Timeout | undefined;

const settings = (): OnboardingSettings => normalizeOnboarding(ctx?.settings({ ...ONBOARDING_DEFAULTS }));

export interface OnboardingState {
  settings: OnboardingSettings;
  hotkey: string;
  /** Glide currently owns ⌘Space (keyboard feature's Spotlight takeover). */
  spotlightTakeover: boolean;
  helperAvailable: boolean;
  firstRun: FirstRunDecision | null;
}

function state(): OnboardingState {
  const c = ctx;
  const kb = (c?.getGlobalSettings().features?.keyboard ?? {}) as { spotlightTakeover?: unknown };
  return {
    settings: settings(),
    hotkey: c?.getGlobalSettings().hotkey ?? "",
    spotlightTakeover: kb.spotlightTakeover === true,
    helperAvailable: c?.helper.available() ?? false,
    firstRun: decision,
  };
}

/** mtimes of the data dir's files (top level and one level into features/). */
function dataMtimes(): number[] {
  const root = app.getPath("userData");
  const out: number[] = [];
  const scan = (dir: string, depth: number) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) out.push(st.mtimeMs);
        else if (st.isDirectory() && depth > 0) scan(p, depth - 1);
      } catch {
        /* vanished */
      }
    }
  };
  scan(root, 0);
  scan(path.join(root, "features"), 1);
  return out;
}

function decide(c: FeatureContext): FirstRunDecision {
  return decideFirstRun({
    onboarding: settings(),
    envSkip: process.env.GLIDE_SKIP_ONBOARDING === "1",
    dataPredatesLaunch: predatesLaunch(dataMtimes(), launchedAt),
    usageCount: c.store.getUsage().length,
    settingsCustomised: settingsCustomised(c.getGlobalSettings()),
  });
}

function persist(patch: Partial<OnboardingSettings>): OnboardingSettings {
  ctx?.setSettings(patch);
  return settings();
}

function openWindow(opts: { restart?: boolean } = {}): void {
  const c = ctx;
  if (!c) return;
  const s = settings();
  if (!s.completed && !s.skipped) persist({ started: true });
  else if (opts.restart) persist({ step: "welcome" });
  if (win && !win.isDestroyed()) {
    c.emit("open", { restart: opts.restart === true });
    win.show();
    win.focus();
    return;
  }
  const dark = nativeTheme.shouldUseDarkColors;
  const w = c.createWindow(ONBOARDING_ROUTE, {
    width: 720,
    height: 560,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    center: true,
    title: "Welcome to Glide",
    titleBarStyle: "hiddenInset",
    backgroundColor: dark ? "#161618" : "#f6f6f8",
  });
  w.once("ready-to-show", () => {
    w.show();
    w.focus();
  });
  w.on("closed", () => {
    if (win === w) win = null;
  });
  win = w;
}

function closeWindow(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

/** Set Glide's launcher hotkey and verify the OS accepted it; reverts on failure. */
async function setHotkey(accel: unknown): Promise<{ ok: boolean; hotkey: string; error?: string }> {
  const c = ctx;
  if (!c) throw new Error("Onboarding is not ready");
  const previous = c.getGlobalSettings().hotkey;
  if (typeof accel !== "string" || !accel.trim()) return { ok: false, hotkey: previous, error: "Press a key combination." };
  const next = accel.trim();
  if (canonicalAccel(next) === canonicalAccel(SPOTLIGHT)) return useCommandSpace();
  const conflict = knownHotkeyConflict(next);
  if (conflict) return { ok: false, hotkey: previous, error: conflict };
  // Leaving ⌘Space: give Spotlight its shortcut back (the user picked another hotkey on purpose).
  if (state().spotlightTakeover) await c.callFeature("keyboard", "setUseCommandSpace", false).catch((err) => c.log("restore Spotlight failed", err));
  c.store.setSettings({ hotkey: next });
  // index.ts re-registers shortcuts on store change; native registration answers asynchronously.
  await hotkeysSettled();
  if (!isHotkeyActive(next)) {
    c.store.setSettings({ hotkey: previous });
    return { ok: false, hotkey: previous, error: "Another app already uses that shortcut. Try a different combination." };
  }
  return { ok: true, hotkey: next };
}

/** Reuses the keyboard feature's "Use ⌘Space for Glide" (turns Spotlight's shortcut off via the helper). */
async function useCommandSpace(): Promise<{ ok: boolean; hotkey: string; error?: string }> {
  const c = ctx;
  if (!c) throw new Error("Onboarding is not ready");
  try {
    await c.callFeature("keyboard", "setUseCommandSpace", true);
  } catch (err) {
    return { ok: false, hotkey: c.getGlobalSettings().hotkey, error: err instanceof Error ? err.message : String(err) };
  }
  const hotkey = c.getGlobalSettings().hotkey;
  await hotkeysSettled();
  if (!isHotkeyActive(hotkey)) return { ok: false, hotkey, error: "⌘Space is still taken. Turn off Spotlight's shortcut in System Settings → Keyboard → Keyboard Shortcuts." };
  return { ok: true, hotkey };
}

/** Headless tests only: GLIDE_ONBOARDING_FAKE_PERMISSIONS names a JSON file re-read on every poll. */
function fakePermissions(): PermissionsSnapshot["status"] | null {
  const file = HEADLESS ? process.env.GLIDE_ONBOARDING_FAKE_PERMISSIONS : undefined;
  if (!file) return null;
  try {
    return parseFakePermissions(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** Read-only status for the checklist (never prompts). */
async function permissions(): Promise<PermissionsSnapshot> {
  const fake = fakePermissions();
  if (fake) return { source: "fake", status: fake, checkedAt: Date.now() };
  const c = ctx;
  let helper: PermissionStatus | null = null;
  if (c?.helper.available()) helper = await c.helper.call("permissions.status").catch(() => null);
  const fallback: { accessibility?: boolean; screen?: string } = {};
  if (process.platform === "darwin") {
    try {
      fallback.accessibility = systemPreferences.isTrustedAccessibilityClient(false);
      fallback.screen = systemPreferences.getMediaAccessStatus("screen");
    } catch {
      /* not available */
    }
  }
  return { source: helper ? "helper" : "fallback", status: permissionMap(helper, fallback), checkedAt: Date.now() };
}

const REQUESTABLE: Partial<Record<PermissionKind, "accessibility" | "inputMonitoring" | "calendar" | "reminders">> = {
  accessibility: "accessibility",
  inputMonitoring: "inputMonitoring",
  calendars: "calendar",
  reminders: "reminders",
};

/** "Open Settings" on a checklist row (explicit click only): register Glide in the list, open the pane. */
async function openPermissionSettings(kind: unknown): Promise<{ ok: boolean; url: string }> {
  if (!isPermissionKind(kind)) throw new Error("Unknown permission");
  const c = ctx;
  const req = REQUESTABLE[kind];
  const current = (await permissions()).status[kind];
  // Asking once adds Glide to the pane's list (macOS shows its own prompt for calendars/reminders).
  if (req && current !== "granted" && c?.helper.available()) await c.helper.call("permissions.request", { kind: req }).catch(() => null);
  const url = PERMISSION_PANES[kind];
  await shell.openExternal(url);
  return { ok: true, url };
}

const ITEM: SearchItem = {
  id: "onboarding.welcome",
  kind: "command",
  title: "Welcome to Glide",
  subtitle: "Setup tour: hotkey, permissions, AI and themes",
  icon: { kind: "emoji", value: "👋" },
  keywords: ["onboarding", "welcome", "tour", "setup", "getting started", "intro", "permissions", "first run"],
  feature: "onboarding",
  kindLabel: "Onboarding",
};

export const feature: FeatureModule = {
  id: "onboarding",
  start(c) {
    ctx = c;
    decision = decide(c);
    c.log(`first run: ${decision.reason}${decision.show ? " (opening)" : ""}`);
    // After the launcher window exists, so the tour is the window in front.
    if (decision.show) openTimer = setTimeout(() => openWindow(), 900);
  },
  stop() {
    if (openTimer) clearTimeout(openTimer);
    ctx = null;
  },
  items: () => [ITEM],
  actions: () => [{ id: "open", title: "Open Welcome Tour", icon: "👋" }],
  async runAction(): Promise<ExecuteResult> {
    openWindow({ restart: true });
    return { ok: true, hide: true };
  },
  methods: {
    getState: () => state(),
    setStep: (step: unknown) => {
      if (!isStep(step)) throw new Error("Unknown step");
      const s = settings();
      // After completion the tour can be replayed without becoming "in progress" again.
      return s.completed || s.skipped ? s : persist({ started: true, step });
    },
    /** Done / "Open Glide": never shown automatically again. */
    finish: (opts: unknown) => {
      const s = persist({ completed: true, started: false, step: "done", finishedAt: Date.now() });
      closeWindow();
      if (typeof opts === "object" && opts !== null && (opts as { openLauncher?: unknown }).openLauncher === true) ctx?.showLauncher();
      return s;
    },
    /** "Skip setup": never shown automatically again. */
    skip: () => {
      const s = persist({ skipped: true, started: false, finishedAt: Date.now() });
      closeWindow();
      return s;
    },
    open: () => {
      openWindow({ restart: true });
      return true;
    },
    close: () => {
      closeWindow();
      return true;
    },
    setHotkey: (accel: unknown) => setHotkey(accel),
    useCommandSpace: () => useCommandSpace(),
    checkHotkey: (accel: unknown) => (typeof accel === "string" ? knownHotkeyConflict(accel) : "Press a key combination."),
    permissions: () => permissions(),
    openPermissionSettings: (kind: unknown) => openPermissionSettings(kind),
  },
};
