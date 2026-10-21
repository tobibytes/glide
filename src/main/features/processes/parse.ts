/** Pure parsers for `ps` and `lsof` output plus the "dangerous to kill" policy. */

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cpu: number; // %CPU as reported by ps (can exceed 100 on multi-core)
  rssKb: number;
  user: string;
  /** Full executable path (or name for kernel tasks). */
  command: string;
  /** Display name: the .app bundle name when inside one, else the executable's basename. */
  name: string;
  /** Enclosing .app bundle path, used for the icon. */
  appPath?: string;
}

/** `ps -axo pid=,ppid=,%cpu=,rss=,user=,comm=` — user before comm because comm may contain spaces. */
export const PS_ARGS = ["-axo", "pid=,ppid=,%cpu=,rss=,user=,comm="] as const;

export function appBundleOf(command: string): string | undefined {
  const m = /^(.*?\.app)(?:\/|$)/.exec(command);
  return m?.[1];
}

export function processName(command: string): string {
  const exe = command.split("/").pop() || command;
  const app = appBundleOf(command);
  // The bundle's main executable shows as the app name; helpers keep their own name.
  if (app && command === `${app}/Contents/MacOS/${exe}`) return (app.split("/").pop() ?? app).replace(/\.app$/, "");
  return exe;
}

export function parsePs(out: string): ProcessInfo[] {
  const list: ProcessInfo[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line || /^PID\b/.test(line)) continue;
    const m = /^(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const command = m[6]!.trim();
    const appPath = appBundleOf(command);
    list.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]!.replace(",", ".")),
      rssKb: Number(m[4]),
      user: m[5]!,
      command,
      name: processName(command),
      ...(appPath ? { appPath } : {}),
    });
  }
  return list;
}

export function sortByCpu(list: ProcessInfo[]): ProcessInfo[] {
  return [...list].sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb || a.pid - b.pid);
}

export interface PortListener {
  command: string;
  pid: number;
  user: string;
  /** e.g. "*:3000", "127.0.0.1:3000", "[::1]:3000" */
  address: string;
  port: number;
  protocol: "IPv4" | "IPv6";
}

export const lsofArgs = (port: number) => ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"];

/** Parses `lsof -nP -iTCP:<port> -sTCP:LISTEN`; one row per pid+address (IPv4/IPv6 sockets of one pid are merged). */
export function parseLsof(out: string): PortListener[] {
  const seen = new Set<string>();
  const list: PortListener[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim() || line.startsWith("COMMAND")) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid)) continue;
    const proto = cols.find((c) => c === "IPv4" || c === "IPv6") as PortListener["protocol"] | undefined;
    // NAME is "<addr>:<port> (LISTEN)"; the address itself may contain colons (IPv6).
    const nameIdx = cols.findIndex((c) => c === "(LISTEN)");
    const name = nameIdx > 0 ? cols[nameIdx - 1]! : cols[cols.length - 1]!;
    const pm = /:(\d+)$/.exec(name);
    if (!pm) continue;
    const port = Number(pm[1]);
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ command: cols[0]!.replace(/\\x20/g, " "), pid, user: cols[2]!, address: name, port, protocol: proto ?? "IPv4" });
  }
  return list;
}

/** Parses "port 3000", "kill port 3000", ":3000", "port:3000". */
export function parsePortQuery(q: string): number | undefined {
  const m = /^\s*(?:kill\s+)?(?:port\s*:?\s*|:)(\d{1,5})\s*$/i.exec(q);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 65535 ? n : undefined;
}

const CRITICAL_NAMES = new Set(["kernel_task", "launchd", "WindowServer", "loginwindow", "Finder", "Dock", "SystemUIServer", "coreaudiod", "mds", "opendirectoryd", "securityd"]);

export type KillRisk = { level: "ok" } | { level: "warn"; reason: string };

/** Killing these logs you out, freezes the UI or kills Glide; require an explicit confirmation. */
export function killRisk(p: Pick<ProcessInfo, "pid" | "name" | "command">, selfPids: readonly number[]): KillRisk {
  if (p.pid <= 1) return { level: "warn", reason: p.pid === 0 ? "kernel_task is the kernel; it cannot be killed." : "launchd (PID 1) is the root of every process. Killing it restarts your Mac." };
  if (selfPids.includes(p.pid)) return { level: "warn", reason: "This is Glide itself. Glide will quit." };
  const base = p.command.split("/").pop() ?? p.name;
  if (CRITICAL_NAMES.has(base) || CRITICAL_NAMES.has(p.name)) {
    if (base === "WindowServer" || base === "loginwindow") return { level: "warn", reason: `${base} runs your login session. Killing it logs you out and closes every app without saving.` };
    return { level: "warn", reason: `${base} is a core macOS process; killing it may freeze or restart parts of the system.` };
  }
  return { level: "ok" };
}

/** Never send signals to these, even with confirmation. */
export function unkillable(pid: number): boolean {
  return !Number.isInteger(pid) || pid <= 1;
}

export function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(kb >= 100 * 1024 ? 0 : 1)} MB`;
  return `${kb} KB`;
}
