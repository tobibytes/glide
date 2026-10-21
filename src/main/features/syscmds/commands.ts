/**
 * System commands missing from src/main/sources/system.ts, as data: each command is a list of
 * argv steps (no shell), so tests can check exactly what would run without running it.
 */

export interface Step {
  cmd: string;
  args: string[];
  /** stdin (for osascript -) */
  input?: string;
  /** A non-zero exit is fine (e.g. killall when the process is not running). */
  allowFail?: boolean;
}

export interface SysCommand {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  keywords: string[];
  /** Native confirmation text; the command runs only after the user confirms. */
  confirm?: string;
  /** Some commands need to read the current state first (booleans from `defaults read`). */
  read?: Step;
  steps(current: boolean | undefined): Step[];
  done(current: boolean | undefined): string;
}

const DEFAULTS = "/usr/bin/defaults";
const KILLALL = "/usr/bin/killall";
const OSASCRIPT = "/usr/bin/osascript";

const readBool = (domain: string, key: string): Step => ({ cmd: DEFAULTS, args: ["read", domain, key], allowFail: true });

/** `defaults read` prints 1/0, YES/NO or true/false; a missing key means the default. */
export function parseDefaultsBool(stdout: string | undefined, fallback: boolean): boolean {
  const t = (stdout ?? "").trim().toLowerCase();
  if (["1", "yes", "true"].includes(t)) return true;
  if (["0", "no", "false"].includes(t)) return false;
  return fallback;
}

export const SYS_COMMANDS: SysCommand[] = [
  {
    id: "toggleHiddenFiles",
    title: "Toggle Hidden Files",
    subtitle: "Show or hide dotfiles in Finder (restarts Finder)",
    icon: "👻",
    keywords: ["hidden", "dotfiles", "invisible", "finder", "show all files"],
    read: readBool("com.apple.finder", "AppleShowAllFiles"),
    steps: (shown) => [
      { cmd: DEFAULTS, args: ["write", "com.apple.finder", "AppleShowAllFiles", "-bool", String(!shown)] },
      { cmd: KILLALL, args: ["Finder"], allowFail: true },
    ],
    done: (shown) => (shown ? "Hidden files are now hidden" : "Hidden files are now shown"),
  },
  {
    id: "toggleDesktopIcons",
    title: "Toggle Desktop Icons",
    subtitle: "Hide or show files on the desktop (restarts Finder)",
    icon: "🗂️",
    keywords: ["desktop", "icons", "clean", "presentation", "hide"],
    read: readBool("com.apple.finder", "CreateDesktop"),
    steps: (visible) => [
      { cmd: DEFAULTS, args: ["write", "com.apple.finder", "CreateDesktop", "-bool", String(visible === false)] },
      { cmd: KILLALL, args: ["Finder"], allowFail: true },
    ],
    done: (visible) => (visible === false ? "Desktop icons shown" : "Desktop icons hidden"),
  },
  {
    id: "toggleDockAutohide",
    title: "Toggle Dock Auto-Hide",
    subtitle: "Automatically hide and show the Dock",
    icon: "⚓",
    keywords: ["dock", "autohide", "hide", "show"],
    steps: () => [{ cmd: OSASCRIPT, args: ["-"], input: 'tell application "System Events" to tell dock preferences to set autohide to not autohide' }],
    done: () => "Toggled Dock auto-hide",
  },
  {
    id: "restartFinder",
    title: "Restart Finder",
    subtitle: "Relaunch Finder",
    icon: "🔁",
    keywords: ["finder", "relaunch", "kill", "restart", "reload"],
    confirm: "Restart Finder? File copies in progress will be interrupted.",
    steps: () => [{ cmd: KILLALL, args: ["Finder"] }],
    done: () => "Finder restarted",
  },
  {
    id: "restartDock",
    title: "Restart Dock",
    subtitle: "Relaunch the Dock (fixes stuck Dock / Mission Control)",
    icon: "🔁",
    keywords: ["dock", "relaunch", "kill", "restart", "mission control"],
    steps: () => [{ cmd: KILLALL, args: ["Dock"] }],
    done: () => "Dock restarted",
  },
  {
    id: "sleepDisplays",
    title: "Sleep Displays",
    subtitle: "Turn the screens off; the Mac keeps running",
    icon: "🌑",
    keywords: ["display", "screen", "monitor", "off", "sleep"],
    steps: () => [{ cmd: "/usr/bin/pmset", args: ["displaysleepnow"] }],
    done: () => "",
  },
  {
    id: "logOut",
    title: "Log Out",
    subtitle: "Log out of your user account",
    icon: "🚪",
    keywords: ["logout", "sign out", "log off", "user"],
    confirm: "Log out now? Unsaved work in other apps may be lost.",
    // «event aevtrlgo» logs out without macOS showing a second confirmation dialog.
    steps: () => [{ cmd: OSASCRIPT, args: ["-"], input: 'tell application "loginwindow" to «event aevtrlgo»' }],
    done: () => "",
  },
];

export function findSysCommand(id: string): SysCommand | undefined {
  return SYS_COMMANDS.find((c) => c.id === id);
}

/** Default values macOS uses when the key was never written. */
export const READ_FALLBACK: Record<string, boolean> = { toggleHiddenFiles: false, toggleDesktopIcons: true };
