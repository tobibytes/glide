/** Pure parsers for vm_stat, pmset, netstat -ib and df -k, plus CPU tick deltas. */

export interface MemoryInfo {
  totalBytes: number;
  usedBytes: number; // app + wired + compressed (Activity Monitor's "Memory Used")
  appBytes: number;
  wiredBytes: number;
  compressedBytes: number;
  cachedBytes: number; // file-backed + purgeable
  freeBytes: number;
}

export function parseVmStat(out: string, totalBytes: number): MemoryInfo | undefined {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 0);
  if (!page) return undefined;
  const pages = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (m) pages.set(m[1]!.trim().toLowerCase(), Number(m[2]));
  }
  const get = (k: string) => (pages.get(k) ?? 0) * page;
  const anonymous = get("anonymous pages");
  const purgeable = get("pages purgeable");
  const app = Math.max(0, anonymous - purgeable);
  const wired = get("pages wired down");
  const compressed = get("pages occupied by compressor");
  const used = Math.min(totalBytes, app + wired + compressed);
  return {
    totalBytes,
    usedBytes: used,
    appBytes: app,
    wiredBytes: wired,
    compressedBytes: compressed,
    cachedBytes: get("file-backed pages") + purgeable,
    freeBytes: Math.max(0, totalBytes - used),
  };
}

export interface BatteryInfo {
  percent: number;
  state: "charging" | "discharging" | "charged" | "finishing charge" | "AC attached" | "unknown";
  source: "AC" | "Battery" | "UPS" | "unknown";
  /** minutes remaining, when pmset knows */
  remainingMin?: number;
}

/** Returns undefined on Macs without a battery. */
export function parsePmset(out: string): BatteryInfo | undefined {
  const m = /(\d+)%;\s*([^;]+);\s*([^\n]*)/.exec(out);
  if (!m) return undefined;
  const sourceRaw = /drawing from '([^']+)'/.exec(out)?.[1] ?? "";
  const source: BatteryInfo["source"] = /AC/.test(sourceRaw) ? "AC" : /Battery/.test(sourceRaw) ? "Battery" : /UPS/.test(sourceRaw) ? "UPS" : "unknown";
  const rawState = m[2]!.trim();
  const known = ["charging", "discharging", "charged", "finishing charge", "AC attached"] as const;
  const state = (known as readonly string[]).includes(rawState) ? (rawState as BatteryInfo["state"]) : "unknown";
  const t = /(\d+):(\d{2}) remaining/.exec(m[3]!);
  const remainingMin = t ? Number(t[1]) * 60 + Number(t[2]) : undefined;
  return { percent: Number(m[1]), state, source, ...(remainingMin !== undefined && remainingMin > 0 ? { remainingMin } : {}) };
}

export interface NetCounters {
  rxBytes: number;
  txBytes: number;
}

/** Sums the <Link#n> rows of `netstat -ib` for every interface except loopback. */
export function parseNetstat(out: string): NetCounters {
  let rx = 0;
  let tx = 0;
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.includes("<Link#")) continue;
    const cols = line.trim().split(/\s+/);
    const name = cols[0]!.replace(/\*$/, "");
    if (name.startsWith("lo") || seen.has(name)) continue;
    // From the right: Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll (the Address column may be empty).
    const n = cols.length;
    if (n < 8) continue;
    const ib = Number(cols[n - 5]);
    const ob = Number(cols[n - 2]);
    if (!Number.isFinite(ib) || !Number.isFinite(ob)) continue;
    seen.add(name);
    rx += ib;
    tx += ob;
  }
  return { rxBytes: rx, txBytes: tx };
}

export interface DiskInfo {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  mount: string;
}

/**
 * `df -k /`. On APFS the root volume's "Used" is just the sealed system snapshot,
 * so used = total − available (what Finder/About This Mac report).
 */
export function parseDf(out: string): DiskInfo | undefined {
  const lines = out.split("\n").filter((l) => l.trim());
  const row = lines.find((l) => !l.startsWith("Filesystem"));
  if (!row) return undefined;
  const cols = row.trim().split(/\s+/);
  const total = Number(cols[1]) * 1024;
  const avail = Number(cols[3]) * 1024;
  if (!Number.isFinite(total) || !Number.isFinite(avail) || total <= 0) return undefined;
  return { totalBytes: total, availableBytes: avail, usedBytes: Math.max(0, total - avail), mount: cols[cols.length - 1] ?? "/" };
}

export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/** Per-core busy fraction (0..1) between two os.cpus() samples. */
export function cpuDeltas(prev: readonly CpuTimes[], next: readonly CpuTimes[]): number[] {
  return next.map((n, i) => {
    const p = prev[i];
    if (!p) return 0;
    const busy = n.user - p.user + (n.nice - p.nice) + (n.sys - p.sys) + (n.irq - p.irq);
    const total = busy + (n.idle - p.idle);
    return total > 0 ? Math.min(1, Math.max(0, busy / total)) : 0;
  });
}

export const average = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function formatBytes(n: number, digits = 1): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits)} ${units[u]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(Math.max(0, bytesPerSec))}/s`;
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Keywords that surface the inline "CPU 23% · Mem 61%" row in root search. */
export function isSysmonQuery(q: string): boolean {
  const t = q.trim().toLowerCase();
  if (t.length < 3) return false;
  return ["cpu", "memory", "ram", "battery", "system", "sysmon", "disk", "uptime", "load"].some((k) => k.startsWith(t) || t.startsWith(k));
}
