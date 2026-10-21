import os from "node:os";
import path from "node:path";
import { clipboard, shell } from "electron";
import type { ItemIcon, SearchItem } from "@shared/types";
import { asString, exec, execOk, osascript, zsh } from "../util/exec";

export const SYSTEM_SOURCE_ID = "system";
export const SETTINGS_SOURCE_ID = "settings";

export interface SystemCommand {
  id: string;
  title: string;
  subtitle?: string;
  icon: ItemIcon;
  keywords: string[];
  /** when set, a native confirmation dialog with this text is shown first */
  confirm?: string;
  run(): Promise<string | void>;
}

const emoji = (value: string): ItemIcon => ({ kind: "emoji", value });

const settingsPane = (id: string, title: string, pane: string, icon: string, keywords: string[]): SystemCommand => ({
  id,
  title,
  subtitle: "System Settings",
  icon: emoji(icon),
  keywords: ["settings", "preferences", "system", ...keywords],
  run: async () => {
    await shell.openExternal(`x-apple.systempreferences:${pane}`);
  },
});

const openFolder = (id: string, title: string, folder: string, icon: string, keywords: string[]): SystemCommand => ({
  id,
  title,
  subtitle: folder,
  icon: emoji(icon),
  keywords: ["open", "folder", "finder", ...keywords],
  run: async () => {
    const err = await shell.openPath(folder);
    if (err) throw new Error(err);
  },
});

async function localIp(): Promise<string | undefined> {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return undefined;
}

async function quitAllApps(): Promise<void> {
  // Keep Finder and ourselves alive; everything else gets a graceful quit.
  const self = path.basename(process.execPath);
  await osascript(`
tell application "System Events"
  set appNames to name of every application process whose visible is true and name is not "Finder" and name is not ${asString(self)} and name is not "Glide"
end tell
repeat with appName in appNames
  try
    tell application appName to quit
  end try
end repeat`);
}

async function toggleDoNotDisturb(): Promise<string> {
  // No public API: rely on a user-created Shortcut named "Toggle Do Not Disturb" (Apple's gallery ships one).
  const res = await exec("shortcuts", ["run", "Toggle Do Not Disturb"], { timeoutMs: 10_000 });
  if (res.code !== 0) throw new Error('Create a Shortcut named "Toggle Do Not Disturb" in Shortcuts.app to use this command');
  return "Toggled Do Not Disturb";
}

export const systemCommands: SystemCommand[] = [
  {
    id: "lockScreen",
    title: "Lock Screen",
    icon: emoji("🔒"),
    keywords: ["lock", "secure", "away"],
    run: () => osascript('tell application "System Events" to keystroke "q" using {command down, control down}').then(() => undefined),
  },
  { id: "sleep", title: "Sleep", icon: emoji("😴"), keywords: ["suspend", "nap"], run: () => execOk("pmset", ["sleepnow"]).then(() => undefined) },
  {
    id: "restart",
    title: "Restart",
    icon: emoji("🔄"),
    keywords: ["reboot"],
    confirm: "Restart your Mac now?",
    run: () => osascript('tell application "System Events" to restart').then(() => undefined),
  },
  {
    id: "shutDown",
    title: "Shut Down",
    icon: emoji("⏻"),
    keywords: ["power", "off", "halt"],
    confirm: "Shut down your Mac now?",
    run: () => osascript('tell application "System Events" to shut down').then(() => undefined),
  },
  {
    id: "emptyTrash",
    title: "Empty Trash",
    icon: emoji("🗑️"),
    keywords: ["bin", "delete", "clean"],
    confirm: "Permanently erase the items in the Trash?",
    run: () => osascript('tell application "Finder" to empty trash').then(() => "Trash emptied"),
  },
  {
    id: "toggleDarkMode",
    title: "Toggle Dark Mode",
    icon: emoji("🌗"),
    keywords: ["appearance", "theme", "light", "dark"],
    run: () => osascript('tell application "System Events" to tell appearance preferences to set dark mode to not dark mode').then(() => undefined),
  },
  {
    id: "showDesktop",
    title: "Show Desktop",
    subtitle: "Hide all windows",
    icon: emoji("🖥️"),
    keywords: ["hide", "windows", "desktop"],
    run: () =>
      osascript('tell application "System Events" to set visible of (every process whose visible is true and name is not "Finder") to false').then(
        () => undefined,
      ),
  },
  { id: "quitAllApps", title: "Quit All Apps", icon: emoji("🚪"), keywords: ["close", "quit", "everything"], confirm: "Quit all running applications?", run: quitAllApps },
  {
    id: "ejectAllDisks",
    title: "Eject All Disks",
    icon: emoji("⏏️"),
    keywords: ["unmount", "usb", "drive", "volume"],
    confirm: "Eject all external disks? Unsaved work on them may be lost.",
    run: () => osascript('tell application "Finder" to eject (every disk whose ejectable is true)').then(() => "Disks ejected"),
  },
  openFolder("openDownloads", "Open Downloads Folder", path.join(os.homedir(), "Downloads"), "📥", ["downloads"]),
  openFolder("openDocuments", "Open Documents Folder", path.join(os.homedir(), "Documents"), "📄", ["documents"]),
  openFolder("openDesktop", "Open Desktop Folder", path.join(os.homedir(), "Desktop"), "🗂️", ["desktop"]),
  {
    id: "startScreenSaver",
    title: "Start Screen Saver",
    icon: emoji("🌌"),
    keywords: ["screensaver", "idle"],
    run: () => execOk("open", ["-a", "ScreenSaverEngine"]).then(() => undefined),
  },
  { id: "toggleDnd", title: "Toggle Do Not Disturb", icon: emoji("🌙"), keywords: ["focus", "dnd", "notifications", "silence"], run: toggleDoNotDisturb },
  {
    id: "volumeUp",
    title: "Volume Up",
    icon: emoji("🔊"),
    keywords: ["sound", "louder", "audio"],
    run: () => osascript("set volume output volume (((output volume of (get volume settings)) + 10) mod 101)").then(() => undefined),
  },
  {
    id: "volumeDown",
    title: "Volume Down",
    icon: emoji("🔉"),
    keywords: ["sound", "quieter", "audio"],
    run: () =>
      osascript(`set v to (output volume of (get volume settings)) - 10
if v < 0 then set v to 0
set volume output volume v`).then(() => undefined),
  },
  {
    id: "volumeMute",
    title: "Toggle Mute",
    icon: emoji("🔇"),
    keywords: ["sound", "mute", "silence", "audio"],
    run: () => osascript("set volume output muted (not (output muted of (get volume settings)))").then(() => undefined),
  },
  {
    id: "copyIp",
    title: "Copy IP Address",
    subtitle: "Local IPv4 address",
    icon: emoji("🌐"),
    keywords: ["network", "ip", "address", "lan"],
    run: async () => {
      const ip = await localIp();
      if (!ip) throw new Error("No active network interface");
      await clipboard.writeText(ip);
      return `Copied ${ip}`;
    },
  },
  {
    id: "copyPublicIp",
    title: "Copy Public IP Address",
    icon: emoji("🛰️"),
    keywords: ["network", "ip", "address", "wan", "external"],
    run: async () => {
      const res = await zsh("curl -s --max-time 5 https://api.ipify.org", { timeoutMs: 8000 });
      const ip = res.stdout.trim();
      if (res.code !== 0 || !ip) throw new Error("Could not determine public IP");
      await clipboard.writeText(ip);
      return `Copied ${ip}`;
    },
  },
  settingsPane("settingsWifi", "Wi-Fi Settings", "com.apple.wifi-settings-extension", "📶", ["wifi", "wireless", "network"]),
  settingsPane("settingsBluetooth", "Bluetooth Settings", "com.apple.BluetoothSettings", "🔵", ["bluetooth", "airpods"]),
  settingsPane("settingsDisplay", "Display Settings", "com.apple.Displays-Settings.extension", "🖥️", ["display", "monitor", "resolution", "brightness"]),
  settingsPane("settingsSound", "Sound Settings", "com.apple.Sound-Settings.extension", "🔈", ["sound", "audio", "output", "input"]),
  settingsPane("settingsKeyboard", "Keyboard Settings", "com.apple.Keyboard-Settings.extension", "⌨️", ["keyboard", "shortcuts", "input"]),
];

export function findSystemCommand(command: string): SystemCommand | undefined {
  return systemCommands.find((c) => c.id === command);
}

export function systemItems(): SearchItem[] {
  return systemCommands.map((c) => ({
    id: `system:${c.id}`,
    kind: "system",
    title: c.title,
    subtitle: c.subtitle ?? "System Command",
    icon: c.icon,
    keywords: c.keywords,
    command: c.id,
    source: SYSTEM_SOURCE_ID,
  }));
}

/** Items that open a page inside Glide's own settings window (command = route). */
export function settingItems(): SearchItem[] {
  const make = (id: string, title: string, route: string, icon: string, keywords: string[]): SearchItem => ({
    id: `setting:${id}`,
    kind: "setting",
    title,
    subtitle: "Glide",
    icon: emoji(icon),
    keywords: ["glide", ...keywords],
    command: route,
    source: SETTINGS_SOURCE_ID,
  });
  return [
    make("general", "Glide Settings", "settings/general", "⚙️", ["preferences", "settings", "options"]),
    make("createWorkflow", "Create Workflow", "settings/workflows/new", "🧩", ["new", "workflow", "automation", "shortcut"]),
    make("createQuicklink", "Create Quicklink", "settings/quicklinks/new", "🔗", ["new", "quicklink", "link", "url"]),
    make("createSnippet", "Create Snippet", "settings/snippets/new", "✂️", ["new", "snippet", "text", "expansion"]),
    make("editHotkey", "Edit Hotkey", "settings/general#hotkey", "⌨️", ["hotkey", "shortcut", "keyboard", "trigger"]),
  ];
}
