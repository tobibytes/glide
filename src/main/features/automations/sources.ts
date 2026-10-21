/**
 * Event sources: turn system state changes into TriggerEvents. Each source only runs while an
 * enabled automation needs it (sync() is called on every list change), so idle cost is zero.
 * - apps: polls `lsappinfo visibleProcessList` (no helper, no permission prompt)
 * - Wi-Fi: polls `ipconfig getsummary` (+ `arp` for a router signature when the SSID is redacted)
 * - power: polls `pmset -g batt`, plus an immediate poll on Electron's on-ac/on-battery
 * - displays: Electron screen events; folders: fs.watch with debounce + directory diff; hotkeys: globalShortcut
 */
import fs from "node:fs";
import type { Display, PowerMonitor, Screen } from "electron";
import path from "node:path";
import { expandHome, type Automation, type TriggerEvent, type TriggerKind } from "./model";
import { diffApps, isInterestingFile, networkIdentity, parseArpMac, parseIpconfigSummary, parsePmset, parseVisibleProcessList, parseWifiDevice, type PowerState } from "./probes";

/** Electron types only (erased at runtime), so this module stays testable in plain node. */
export type ScreenLike = Pick<Screen, "on" | "removeListener">;
export type PowerMonitorLike = Pick<PowerMonitor, "on" | "removeListener">;

export interface SourceDeps {
  emit(e: TriggerEvent): void;
  /** stdout of a command (throws on failure) */
  run(cmd: string, args: string[]): Promise<string>;
  registerHotkey(key: string, accelerator: string | null, handler: () => void): boolean;
  screen?: ScreenLike;
  powerMonitor?: PowerMonitorLike;
  home: string;
  log(...args: unknown[]): void;
  intervals?: Partial<Record<"app" | "wifi" | "power", number>>;
  /** Wi‑Fi network name via the helper (null until Glide has Location access). */
  wifiSsid?: () => Promise<string | null>;
}

/** Polls `read`, diffing each snapshot against the previous one. The first read is the baseline. */
class Poller<S> {
  private timer: NodeJS.Timeout | undefined;
  private prev: S | undefined;
  private busy = false;
  constructor(
    private readonly everyMs: number,
    private readonly read: () => Promise<S | null>,
    private readonly compare: (prev: S, next: S) => void,
  ) {}
  start() {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.everyMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.prev = undefined;
  }
  get running() {
    return !!this.timer;
  }
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const next = await this.read();
      if (next === null) return;
      if (this.prev !== undefined) this.compare(this.prev, next);
      this.prev = next;
    } catch {
      // a failed probe just skips this round
    } finally {
      this.busy = false;
    }
  }
}

export class FolderWatcher {
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private known = new Set<string>();
  constructor(
    readonly dir: string,
    private readonly emit: (e: TriggerEvent) => void,
    private readonly debounceMs = 800,
  ) {}
  start(): boolean {
    try {
      this.known = new Set(fs.readdirSync(this.dir));
      this.watcher = fs.watch(this.dir, { persistent: false }, () => this.bump());
      this.watcher.on("error", () => this.stop());
      return true;
    } catch {
      return false;
    }
  }
  stop() {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private bump() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.scan(), this.debounceMs);
  }
  /** Exposed for tests: diff the directory now. */
  scan() {
    this.timer = undefined;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const added = names.filter((n) => !this.known.has(n) && isInterestingFile(n));
    this.known = new Set(names);
    if (added.length) for (const n of added) this.emit({ type: "folder", path: this.dir, event: "added", file: path.join(this.dir, n) });
    else this.emit({ type: "folder", path: this.dir, event: "changed", file: this.dir });
  }
}

export class EventSources {
  private readonly apps: Poller<string[]>;
  private readonly wifi: Poller<{ id: string | null }>;
  private readonly power: Poller<PowerState>;
  private folders = new Map<string, FolderWatcher>();
  private hotkeys = new Map<string, string>(); // automation id -> accelerator
  private displayOn = false;
  private wifiDevice: string | null | undefined;
  private readonly onAdded = (_e: unknown, d: Display) => this.deps.emit({ type: "display", event: "connected", name: displayName(d) });
  private readonly onRemoved = (_e: unknown, d: Display) => this.deps.emit({ type: "display", event: "disconnected", name: displayName(d) });
  private readonly onPowerChange = () => void this.power.poll();

  constructor(private readonly deps: SourceDeps) {
    const iv = deps.intervals ?? {};
    this.apps = new Poller(iv.app ?? 2000, () => this.readApps(), (prev, next) => {
      const d = diffApps(prev, next);
      for (const name of d.launched) deps.emit({ type: "app", event: "launched", name });
      for (const name of d.quit) deps.emit({ type: "app", event: "quit", name });
      if (d.activated) deps.emit({ type: "app", event: "activated", name: d.activated });
    });
    this.wifi = new Poller(iv.wifi ?? 10_000, () => this.readWifi(), (prev, next) => {
      if (prev.id !== next.id) deps.emit({ type: "wifi", from: prev.id, to: next.id });
    });
    this.power = new Poller(iv.power ?? 30_000, () => this.readPower(), (prev, next) => {
      if (prev.source !== next.source || prev.percent !== next.percent) deps.emit({ type: "power", source: next.source, percent: next.percent, prevSource: prev.source, prevPercent: prev.percent });
    });
  }

  /** Start/stop sources so exactly the ones enabled automations need are running. Returns per-automation problems. */
  sync(list: Automation[]): Record<string, string> {
    const problems: Record<string, string> = {};
    const enabled = list.filter((a) => a.enabled);
    const kinds = new Set<TriggerKind>(enabled.map((a) => a.trigger.kind));
    toggle(this.apps, kinds.has("app"));
    toggle(this.wifi, kinds.has("wifi"));
    toggle(this.power, kinds.has("power"));
    this.syncPowerEvents(kinds.has("power"));
    this.syncDisplays(kinds.has("display"));

    const wantDirs = new Map<string, string[]>();
    for (const a of enabled) if (a.trigger.kind === "folder") {
      const dir = path.resolve(expandHome(a.trigger.path, this.deps.home));
      wantDirs.set(dir, [...(wantDirs.get(dir) ?? []), a.id]);
    }
    for (const [dir, w] of this.folders) if (!wantDirs.has(dir)) {
      w.stop();
      this.folders.delete(dir);
    }
    for (const [dir, ids] of wantDirs) {
      if (this.folders.has(dir)) continue;
      const w = new FolderWatcher(dir, this.deps.emit);
      if (w.start()) this.folders.set(dir, w);
      else for (const id of ids) problems[id] = `Can't watch ${dir} (missing or not readable)`;
    }

    const wantKeys = new Map<string, string>();
    for (const a of enabled) if (a.trigger.kind === "hotkey") wantKeys.set(a.id, a.trigger.accelerator);
    for (const [id, accel] of this.hotkeys) if (wantKeys.get(id) !== accel) {
      this.deps.registerHotkey(id, null, () => undefined);
      this.hotkeys.delete(id);
    }
    for (const [id, accel] of wantKeys) {
      if (this.hotkeys.has(id)) continue;
      if (this.deps.registerHotkey(id, accel, () => this.deps.emit({ type: "hotkey", automationId: id }))) this.hotkeys.set(id, accel);
      else problems[id] = `macOS refused the hotkey ${accel} (already in use?)`;
    }
    return problems;
  }

  /** Current Wi-Fi identity for the editor's "Use Current Network" button. */
  async currentNetwork(): Promise<string | null> {
    return (await this.readWifi()).id;
  }

  active(): string[] {
    return [
      ...(this.apps.running ? ["apps"] : []),
      ...(this.wifi.running ? ["wifi"] : []),
      ...(this.power.running ? ["power"] : []),
      ...(this.displayOn ? ["displays"] : []),
      ...[...this.folders.keys()].map((d) => `folder:${d}`),
      ...[...this.hotkeys.values()].map((k) => `hotkey:${k}`),
    ];
  }

  stop() {
    this.apps.stop();
    this.wifi.stop();
    this.power.stop();
    this.syncPowerEvents(false);
    this.syncDisplays(false);
    for (const w of this.folders.values()) w.stop();
    this.folders.clear();
    for (const id of this.hotkeys.keys()) this.deps.registerHotkey(id, null, () => undefined);
    this.hotkeys.clear();
  }

  private syncDisplays(on: boolean) {
    const s = this.deps.screen;
    if (!s || on === this.displayOn) return;
    this.displayOn = on;
    if (on) {
      s.on("display-added", this.onAdded);
      s.on("display-removed", this.onRemoved);
    } else {
      s.removeListener("display-added", this.onAdded);
      s.removeListener("display-removed", this.onRemoved);
    }
  }

  private powerEventsOn = false;
  private syncPowerEvents(on: boolean) {
    const pm = this.deps.powerMonitor;
    if (!pm || on === this.powerEventsOn) return;
    this.powerEventsOn = on;
    if (on) {
      pm.on("on-ac", this.onPowerChange);
      pm.on("on-battery", this.onPowerChange);
    } else {
      pm.removeListener("on-ac", this.onPowerChange);
      pm.removeListener("on-battery", this.onPowerChange);
    }
  }

  private async readApps(): Promise<string[]> {
    return parseVisibleProcessList(await this.deps.run("lsappinfo", ["visibleProcessList"]));
  }

  private async readPower(): Promise<PowerState | null> {
    return parsePmset(await this.deps.run("pmset", ["-g", "batt"]));
  }

  private async readWifi(): Promise<{ id: string | null }> {
    const ssid = await this.deps.wifiSsid?.().catch(() => null);
    if (ssid) return { id: ssid };
    if (this.wifiDevice === undefined) {
      this.wifiDevice = await this.deps.run("networksetup", ["-listallhardwareports"]).then(parseWifiDevice, () => null);
    }
    const dev = this.wifiDevice ?? "en0";
    const summary = parseIpconfigSummary(await this.deps.run("ipconfig", ["getsummary", dev]).catch(() => ""));
    let mac: string | null = null;
    if (summary.connected && !summary.ssid && summary.router) mac = parseArpMac(await this.deps.run("arp", ["-n", summary.router]).catch(() => ""));
    return { id: networkIdentity(summary, mac) };
  }
}

function toggle(p: { start(): void; stop(): void }, on: boolean) {
  if (on) p.start();
  else p.stop();
}

function displayName(d: Pick<Display, "id" | "label" | "size">): string {
  return d.label || `Display ${d.id} (${d.size.width}×${d.size.height})`;
}
