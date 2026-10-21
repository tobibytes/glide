/**
 * System Monitor glance: CPU (per-core os.cpus() deltas + loadavg), memory (vm_stat),
 * disk (df -k /), battery (pmset), network throughput (netstat -ib deltas), uptime
 * and top processes. Sampling is pull-based: the view polls `sample` once a second,
 * so nothing runs in the background while the view is closed.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import type { ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { listProcesses } from "../processes";
import type { FeatureModule } from "../types";
import {
  average, cpuDeltas, formatUptime, isSysmonQuery, parseDf, parseNetstat, parsePmset, parseVmStat,
  type BatteryInfo, type CpuTimes, type DiskInfo, type MemoryInfo, type NetCounters,
} from "./parse";

export interface TopProcess {
  pid: number;
  name: string;
  cpu: number;
  rssKb: number;
}

export interface SysSample {
  at: number;
  cpu: { total: number; cores: number[]; load: [number, number, number]; model: string };
  memory?: MemoryInfo;
  disk?: DiskInfo;
  battery?: BatteryInfo;
  net: { rxPerSec: number; txPerSec: number; rxTotal: number; txTotal: number };
  uptimeSec: number;
  top: TopProcess[];
}

export interface SysState {
  sample: SysSample;
  /** oldest first, up to HISTORY samples */
  history: { cpu: number[]; mem: number[]; rx: number[]; tx: number[] };
}

const HISTORY = 60;
const WARM_PREFIXES = ["cpu", "memory", "ram", "battery", "system", "disk"];

function run(cmd: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout }, (err, stdout) => resolve(err && !stdout ? "" : String(stdout))));
}

const cpuTimes = (): CpuTimes[] => os.cpus().map((c) => c.times);

let prevCpu: CpuTimes[] = cpuTimes();
let prevNet: { c: NetCounters; at: number } | undefined;
let last: SysState | undefined;
let inflight: Promise<SysState> | undefined;
const history: SysState["history"] = { cpu: [], mem: [], rx: [], tx: [] };

const push = (arr: number[], v: number) => {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
};

export async function readMemory(): Promise<MemoryInfo | undefined> {
  return parseVmStat(await run("/usr/bin/vm_stat", []), os.totalmem());
}

export async function readBattery(): Promise<BatteryInfo | undefined> {
  return parsePmset(await run("/usr/bin/pmset", ["-g", "batt"]));
}

async function takeSample(withTop: boolean): Promise<SysState> {
  const now = Date.now();
  const nextCpu = cpuTimes();
  const cores = cpuDeltas(prevCpu, nextCpu);
  prevCpu = nextCpu;
  // The root-search glance skips netstat and ps to stay inside the 250 ms dynamic-item budget.
  const [memory, disk, battery, netOut, procs] = await Promise.all([
    readMemory(),
    run("/bin/df", ["-k", "/"]).then(parseDf),
    readBattery(),
    withTop ? run("/usr/sbin/netstat", ["-ib"]) : Promise.resolve(""),
    withTop ? listProcesses().catch(() => []) : Promise.resolve([]),
  ]);
  const net = netOut ? parseNetstat(netOut) : (prevNet?.c ?? { rxBytes: 0, txBytes: 0 });
  let rxPerSec = 0;
  let txPerSec = 0;
  if (netOut && prevNet && now > prevNet.at) {
    const dt = (now - prevNet.at) / 1000;
    // Counters reset when an interface goes away; clamp to 0 instead of a negative spike.
    rxPerSec = Math.max(0, (net.rxBytes - prevNet.c.rxBytes) / dt);
    txPerSec = Math.max(0, (net.txBytes - prevNet.c.txBytes) / dt);
  }
  if (netOut) prevNet = { c: net, at: now };
  const load = os.loadavg() as [number, number, number];
  const total = average(cores);
  const sample: SysSample = {
    at: now,
    cpu: { total, cores, load, model: os.cpus()[0]?.model ?? "" },
    ...(memory ? { memory } : {}),
    ...(disk ? { disk } : {}),
    ...(battery ? { battery } : {}),
    net: { rxPerSec, txPerSec, rxTotal: net.rxBytes, txTotal: net.txBytes },
    uptimeSec: os.uptime(),
    top: procs.slice(0, 5).map((p) => ({ pid: p.pid, name: p.name, cpu: p.cpu, rssKb: p.rssKb })),
  };
  if (withTop) {
    // Only the view's 1 s cadence feeds the sparklines, so they stay evenly spaced.
    push(history.cpu, total);
    push(history.mem, memory ? memory.usedBytes / memory.totalBytes : 0);
    push(history.rx, rxPerSec);
    push(history.tx, txPerSec);
  }
  last = { sample, history: { cpu: [...history.cpu], mem: [...history.mem], rx: [...history.rx], tx: [...history.tx] } };
  return last;
}

/** De-duplicates concurrent callers and keeps samples at least 500 ms apart so deltas stay meaningful. */
export function sample(withTop = true): Promise<SysState> {
  if (last && Date.now() - last.sample.at < 500 && (!withTop || last.sample.top.length)) return Promise.resolve(last);
  inflight ??= takeSample(withTop).finally(() => (inflight = undefined));
  return inflight;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

async function glanceRow(): Promise<ScoredItem[]> {
  // CPU is the average since the previous sample (at worst since app start): no waiting here.
  const s = (await sample(false)).sample;
  const parts = [`CPU ${pct(s.cpu.total)}`];
  if (s.memory) parts.push(`Mem ${pct(s.memory.usedBytes / s.memory.totalBytes)}`);
  if (s.battery) parts.push(`Battery ${s.battery.percent}%${s.battery.state === "charging" ? " ⚡︎" : ""}`);
  const sub = [`Load ${s.cpu.load[0].toFixed(2)}`];
  if (s.disk) sub.push(`Disk ${pct(s.disk.usedBytes / s.disk.totalBytes)} used`);
  sub.push(`Up ${formatUptime(s.uptimeSec)}`, "⏎ System Monitor");
  const item: SearchItem = {
    id: "sysmon:glance",
    kind: "calculator",
    kindLabel: "System",
    title: parts.join(" · "),
    subtitle: sub.join(" · "),
    icon: { kind: "emoji", value: "📈" },
    feature: "sysmon",
    data: { action: "open", noUsage: true },
  };
  return [{ item, score: 996, matchScore: 996, matchKind: "exact", frecency: 0, ranges: [] }];
}

export const feature: FeatureModule = {
  id: "sysmon",
  items() {
    return [
      {
        id: "sysmon:open",
        kind: "command",
        kindLabel: "Command",
        title: "System Monitor",
        subtitle: "CPU, memory, disk, battery, network",
        icon: { kind: "emoji", value: "📈" },
        keywords: ["system", "monitor", "cpu", "memory", "ram", "disk", "battery", "network", "uptime", "activity", "stats", "load"],
        feature: "sysmon",
        data: { action: "open" },
      },
    ];
  },
  dynamicItems(query) {
    if (isSysmonQuery(query)) return glanceRow();
    // Typing "c"/"me"/"ba"… warms the exec'd tools so the glance row is ready one keystroke later.
    const t = query.trim().toLowerCase();
    if (t.length > 0 && t.length < 3 && WARM_PREFIXES.some((k) => k.startsWith(t))) void sample(false).catch(() => undefined);
    return [];
  },
  actions(): ItemAction[] {
    return [{ id: "open", title: "Open System Monitor", shortcut: "⏎" }];
  },
  async runAction(_item, actionId) {
    if (actionId === "open") return { ok: true, view: { id: "sysmon.monitor" } };
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    sample: () => sample(true),
  },
};
