/**
 * Process & Port Manager: "Kill Process" (live ps list sorted by CPU), "Kill Port"
 * and "port 3000" in root search (lsof listener lookup). Signals go through
 * process.kill; dangerous targets need an explicit confirmation from the UI.
 */
import { execFile } from "node:child_process";
import { app, clipboard } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import type { FeatureContext, FeatureModule } from "../types";
import { killRisk, lsofArgs, parseLsof, parsePortQuery, parsePs, PS_ARGS, sortByCpu, unkillable, type PortListener, type ProcessInfo } from "./parse";

let ctx: FeatureContext | undefined;

function run(cmd: string, args: readonly string[], timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args as string[], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // lsof exits 1 when nothing matches; the (empty) stdout is still the answer.
      resolve(err && !stdout ? "" : String(stdout));
    });
  });
}

export function selfPids(): number[] {
  const pids = new Set<number>([process.pid]);
  try {
    for (const m of app.getAppMetrics()) pids.add(m.pid);
  } catch {
    // app metrics unavailable before ready
  }
  return [...pids];
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  return sortByCpu(parsePs(await run("/bin/ps", PS_ARGS)));
}

export async function listeners(port?: number): Promise<PortListener[]> {
  const args = port ? lsofArgs(port) : ["-nP", "-iTCP", "-sTCP:LISTEN"];
  const list = parseLsof(await run("/usr/sbin/lsof", args, 6000));
  return list.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

export type Sig = "SIGTERM" | "SIGKILL";

export interface SignalResult extends ExecuteResult {
  needsConfirm?: boolean;
  reason?: string;
}

async function currentCommand(pid: number): Promise<string> {
  return (await run("/bin/ps", ["-o", "comm=", "-p", String(pid)])).trim();
}

/** Sends a signal after re-checking the pid still runs the expected command (pid reuse) and the risk policy. */
export async function sendSignal(pid: number, sig: Sig, opts: { confirmed?: boolean; expectedCommand?: string } = {}): Promise<SignalResult> {
  if (unkillable(pid)) return { ok: false, error: pid === 0 ? "kernel_task cannot be killed" : "launchd (PID 1) cannot be killed from Glide" };
  const command = await currentCommand(pid);
  if (!command) return { ok: false, error: `No process with PID ${pid} (it may have already quit)` };
  if (opts.expectedCommand && command !== opts.expectedCommand) return { ok: false, error: `PID ${pid} is now a different process; refresh and try again` };
  const name = command.split("/").pop() ?? command;
  const risk = killRisk({ pid, name, command }, selfPids());
  if ((risk.level === "warn" || sig === "SIGKILL") && !opts.confirmed) {
    return { ok: false, needsConfirm: true, reason: risk.level === "warn" ? risk.reason : `Force quitting ${name} may lose unsaved work.`, error: "Confirmation required" };
  }
  try {
    process.kill(pid, sig);
    ctx?.log(`${sig} sent to ${pid} (${name})`);
    return { ok: true, message: `${sig === "SIGKILL" ? "Force quit" : "Quit"} ${name} (PID ${pid})` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return { ok: false, error: `Permission denied: ${name} belongs to another user (Glide never asks for admin rights)` };
    if (code === "ESRCH") return { ok: false, error: `${name} already quit` };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function openActivityMonitor(): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    execFile("/usr/bin/open", ["-b", "com.apple.ActivityMonitor"], (err) => resolve(err ? { ok: false, error: "Could not open Activity Monitor" } : { ok: true, hide: true }));
  });
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));

const item = (id: string, title: string, subtitle: string, icon: string, keywords: string[], extra: Partial<SearchItem> = {}): SearchItem => ({
  id: `processes:${id}`,
  kind: "command",
  kindLabel: "Command",
  title,
  subtitle,
  icon: { kind: "emoji", value: icon },
  keywords,
  feature: "processes",
  data: { action: id },
  ...extra,
});

async function portRows(query: string): Promise<ScoredItem[]> {
  const port = parsePortQuery(query);
  if (!port) return [];
  const found = await listeners(port);
  const base = { matchScore: 997, matchKind: "exact" as const, frecency: 0, ranges: [] };
  if (!found.length)
    return [{ ...base, score: 997, item: { id: `processes:port:${port}`, kind: "calculator", kindLabel: "Port", title: `Nothing is listening on port ${port}`, subtitle: "TCP · LISTEN", icon: { kind: "emoji", value: "🔌" }, feature: "processes", data: { action: "portView", port, noUsage: true } } }];
  return found.slice(0, 3).map((l, i) => ({
    ...base,
    score: 997 - i,
    item: {
      id: `processes:port:${port}:${l.pid}`,
      kind: "calculator",
      kindLabel: "Port",
      title: `Port ${port} — ${l.command} (PID ${l.pid})`,
      subtitle: `${l.address} · ${l.user} · ⏎ show · ⌘⏎ kill…`,
      icon: { kind: "emoji", value: "🔌" },
      feature: "processes",
      data: { action: "portView", port, pid: l.pid, noUsage: true },
    },
  }));
}

export const feature: FeatureModule = {
  id: "processes",
  start(c) {
    ctx = c;
  },
  items() {
    return [
      item("list", "Kill Process", "Processes sorted by CPU · quit or force quit", "💀", ["process", "processes", "kill", "quit", "force quit", "task manager", "cpu", "memory", "pid"]),
      item("ports", "Kill Port", "Find what listens on a TCP port and stop it", "🔌", ["port", "ports", "listen", "lsof", "kill port", "server", "localhost"], { acceptsArgument: true }),
    ];
  },
  dynamicItems(query) {
    return portRows(query);
  },
  actions(i): ItemAction[] {
    if (i.data?.action === "portView")
      return [
        { id: "portView", title: "Show Port", shortcut: "⏎" },
        { id: "portKill", title: "Kill Listener…", shortcut: "⌘⏎", destructive: true },
      ];
    if (i.data?.action === "ports") return [{ id: "ports", title: "Show Listening Ports", shortcut: "⏎" }];
    return [
      { id: "list", title: "Show Processes", shortcut: "⏎" },
      { id: "activity", title: "Open Activity Monitor", shortcut: "⌘⏎" },
    ];
  },
  async runAction(scored, actionId) {
    const d = scored.item.data ?? {};
    switch (actionId) {
      case "list":
        return { ok: true, view: { id: "processes.list" } };
      case "activity":
        return openActivityMonitor();
      case "ports": {
        const port = parsePortQuery(`port ${scored.argument ?? ""}`);
        return { ok: true, view: { id: "processes.ports", props: port ? { port } : {} } };
      }
      case "portView":
        return { ok: true, view: { id: "processes.ports", props: { port: num(d.port) } } };
      case "portKill":
        // Kill needs a confirmation, which lives in the view.
        return { ok: true, view: { id: "processes.ports", props: { port: num(d.port), confirmPid: num(d.pid) || undefined } } };
    }
    return { ok: false, error: `Unknown action ${actionId}` };
  },
  methods: {
    list: async () => ({ processes: await listProcesses(), selfPids: selfPids(), at: Date.now() }),
    listeners: (port: unknown) => listeners(Number.isInteger(num(port)) && num(port) > 0 ? num(port) : undefined),
    signal: (pid: unknown, sig: unknown, opts: unknown) => {
      const o = (opts ?? {}) as { confirmed?: unknown; expectedCommand?: unknown };
      return sendSignal(num(pid), sig === "SIGKILL" ? "SIGKILL" : "SIGTERM", {
        confirmed: o.confirmed === true,
        ...(typeof o.expectedCommand === "string" ? { expectedCommand: o.expectedCommand } : {}),
      });
    },
    /** Risk for a live pid (looked up via ps, since lsof truncates command names). */
    risk: async (pid: unknown) => {
      const p = num(pid);
      const command = await currentCommand(p);
      return killRisk({ pid: p, name: command.split("/").pop() ?? command, command }, selfPids());
    },
    copy: (text: unknown) => {
      clipboard.writeText(String(text ?? ""));
      return true;
    },
    activityMonitor: () => openActivityMonitor(),
  },
};
