/** Parsers for the system tools the event sources poll (pure; exercised by probes.test.ts). */

export interface AppSnapshot {
  /** visible (Dock) apps, front-most first */
  apps: string[];
}

/**
 * `lsappinfo visibleProcessList` prints `ASN:0x0-0x1001-"Finder": ASN:…-"Google_Chrome": …`, ordered front to back.
 * lsappinfo writes spaces in names as underscores; matching in model.ts treats "_" and " " alike.
 */
export function parseVisibleProcessList(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/ASN:[^"]*"([^"]*)"/g)) {
    const name = m[1]!.replace(/_/g, " ").trim();
    if (name) out.push(name);
  }
  return out;
}

export interface AppDiff {
  launched: string[];
  quit: string[];
  activated: string | null;
}

export function diffApps(prev: string[], next: string[]): AppDiff {
  const before = new Set(prev);
  const after = new Set(next);
  return {
    launched: next.filter((n) => !before.has(n)),
    quit: prev.filter((n) => !after.has(n)),
    activated: next[0] !== undefined && next[0] !== prev[0] ? next[0] : null,
  };
}

export interface PowerState {
  source: "ac" | "battery";
  /** -1 when the Mac has no battery */
  percent: number;
}

/** `pmset -g batt`: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=…)\t99%; discharging; …" */
export function parsePmset(text: string): PowerState | null {
  const src = /drawing from '([^']+)'/.exec(text)?.[1];
  if (!src) return null;
  const pct = /(\d{1,3})%/.exec(text)?.[1];
  return { source: /AC/i.test(src) ? "ac" : "battery", percent: pct ? Number(pct) : -1 };
}

/** `networksetup -listallhardwareports` → the Wi-Fi device (en0 on most Macs). */
export function parseWifiDevice(text: string): string | null {
  const m = /Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/.exec(text);
  return m ? m[1]! : null;
}

export interface WifiSummary {
  connected: boolean;
  /** null when macOS redacts it (no Location permission) */
  ssid: string | null;
  router: string | null;
}

/** `ipconfig getsummary <dev>`; macOS 14.4+ prints "SSID : <redacted>" unless Location Services allows it. */
export function parseIpconfigSummary(text: string): WifiSummary {
  const ssidLine = /^\s*SSID : (.*)$/m.exec(text)?.[1]?.trim();
  const router = /^\s*Router : (\S+)$/m.exec(text)?.[1] ?? null;
  const connected = ssidLine !== undefined;
  return { connected, ssid: connected && ssidLine && ssidLine !== "<redacted>" ? ssidLine : null, router };
}

/** `arp -n <ip>` → "? (10.0.0.1) at aa:bb:cc:dd:ee:ff on en0 …" */
export function parseArpMac(text: string): string | null {
  return /\bat ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

/**
 * The name we match Wi-Fi triggers against: the SSID when macOS reveals it, otherwise a stable
 * router signature ("Router 10.0.0.1 · aa:bb:…") so automations still work without Location access.
 */
export function networkIdentity(summary: WifiSummary, routerMac: string | null): string | null {
  if (!summary.connected) return null;
  if (summary.ssid) return summary.ssid;
  if (summary.router) return routerMac ? `Router ${summary.router} · ${routerMac}` : `Router ${summary.router}`;
  return "Unknown network";
}

/** Files we never report as "added": hidden files and in-progress downloads. */
export function isInterestingFile(name: string): boolean {
  return !name.startsWith(".") && !/\.(crdownload|download|part|partial|tmp)$/i.test(name) && name !== "Icon\r";
}
