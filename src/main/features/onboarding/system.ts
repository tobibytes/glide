/** Hotkey conflicts and the permission checklist model (pure). */
import type { PermissionStatus } from "../../native/helper";

const MOD_ALIASES: Record<string, string> = {
  cmd: "command", command: "command", cmdorctrl: "command", commandorcontrol: "command", super: "command", meta: "command",
  ctrl: "control", control: "control",
  alt: "option", option: "option", altgr: "option",
  shift: "shift",
};
const MOD_ORDER = ["control", "option", "shift", "command"];

/** Canonical lower-case form ("Cmd+Space" and "Command+Space" → "command+space"). */
export function canonicalAccel(accel: string): string {
  const parts = accel.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = parts.filter((p) => MOD_ALIASES[p]).map((p) => MOD_ALIASES[p]);
  const keys = parts.filter((p) => !MOD_ALIASES[p]);
  const uniq = [...new Set(mods)].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...uniq, ...keys].join("+");
}

const KNOWN: Record<string, string> = {
  "command+space": "Spotlight uses ⌘Space. Choose “Use ⌘Space” to hand it over to Glide.",
  "option+command+space": "Finder's search window uses ⌥⌘Space.",
  "control+space": "macOS uses ⌃Space to switch input sources.",
  "control+option+space": "macOS uses ⌃⌥Space to switch to the next input source.",
  "command+tab": "⌘Tab is the app switcher.",
  "command+q": "⌘Q quits the front app.",
  "command+w": "⌘W closes windows in every app.",
  "command+h": "⌘H hides the front app.",
  "command+m": "⌘M minimises windows in every app.",
  "command+c": "⌘C is Copy.",
  "command+v": "⌘V is Paste.",
  "command+x": "⌘X is Cut.",
  "command+z": "⌘Z is Undo.",
  "command+a": "⌘A is Select All.",
  "command+s": "⌘S is Save.",
  "shift+command+3": "⇧⌘3 takes a screenshot.",
  "shift+command+4": "⇧⌘4 takes a screenshot.",
  "shift+command+5": "⇧⌘5 opens the screenshot toolbar.",
};

/** A known clash with a macOS or near-universal app shortcut, or null. */
export function knownHotkeyConflict(accel: string): string | null {
  const c = canonicalAccel(accel);
  if (!c) return "Press a key combination.";
  if (KNOWN[c]) return KNOWN[c];
  const parts = c.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.length === 0 && !/^f\d{1,2}$/.test(key)) return "Add a modifier (⌘, ⌥, ⌃ or ⇧) so typing isn't intercepted.";
  if (mods.length === 1 && mods[0] === "shift") return "⇧ alone would capture capital letters while you type.";
  return null;
}

export type PermissionKind = "accessibility" | "inputMonitoring" | "screenRecording" | "calendars" | "reminders";
export type PermissionState = "granted" | "denied" | "notDetermined" | "unknown";

export const PERMISSION_KINDS: PermissionKind[] = ["accessibility", "inputMonitoring", "screenRecording", "calendars", "reminders"];

export const PERMISSION_PANES: Record<PermissionKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  reminders: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
};

export const isPermissionKind = (v: unknown): v is PermissionKind => typeof v === "string" && (PERMISSION_KINDS as string[]).includes(v);

export type PermissionMap = Record<PermissionKind, PermissionState>;

export interface PermissionsSnapshot {
  /** Where the statuses came from: the Swift helper, Electron fallbacks only, or a test fake. */
  source: "helper" | "fallback" | "fake";
  status: PermissionMap;
  checkedAt: number;
}

const fromAuth = (v: string | undefined): PermissionState =>
  v === "authorized" || v === "granted" || v === "fullAccess" ? "granted" : v === "denied" || v === "restricted" ? "denied" : v === "notDetermined" || v === "not-determined" ? "notDetermined" : "unknown";

const fromBool = (v: boolean | undefined): PermissionState => (v === true ? "granted" : v === false ? "denied" : "unknown");

/**
 * Merge the helper's answer (may be null when it isn't running) with Electron's read-only
 * fallbacks (Accessibility trust, screen-capture media status).
 */
export function permissionMap(helper: PermissionStatus | null, fallback: { accessibility?: boolean; screen?: string }): PermissionMap {
  return {
    accessibility: helper ? fromBool(helper.accessibility) : fromBool(fallback.accessibility),
    inputMonitoring: helper ? fromBool(helper.inputMonitoring) : "unknown",
    screenRecording: fromAuth(fallback.screen),
    calendars: helper ? fromAuth(helper.calendar) : "unknown",
    reminders: helper ? fromAuth(helper.reminders) : "unknown",
  };
}

/** Parse a test fake ({ accessibility: "granted", … }); unknown kinds/values are ignored. */
export function parseFakePermissions(raw: unknown): PermissionMap | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out = Object.fromEntries(PERMISSION_KINDS.map((k) => [k, "unknown"])) as PermissionMap;
  for (const k of PERMISSION_KINDS) {
    const v = r[k];
    if (v === "granted" || v === "denied" || v === "notDetermined" || v === "unknown") out[k] = v;
    else if (typeof v === "boolean") out[k] = fromBool(v);
  }
  return out;
}
