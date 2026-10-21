/**
 * Live wiring for the built-in extras: each one pulls data from its owning feature (through that
 * feature's exported methods, never its internals), builds a spec with ./specs, and registers or
 * removes its status item. Polling only runs while the extra is enabled.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { registerMenuBarItem, type MenuBarHandle } from "../../../menubar";
import type { FeatureContext, FeatureModule } from "../../types";
import { feature as timersFeature, type TimersState } from "../../timers";
import { feature as calendarFeature } from "../../calendar";
import { feature as clipboardFeature } from "../../clipboard";
import { feature as agentFeature } from "../../agent";
import type { ScheduleResult } from "../../calendar/types";
import type { ClipSummary } from "../../clipboard/model";
import type { RunSnapshot } from "../../agent/types";
import { average, cpuDeltas, parseVmStat, type CpuTimes, type MemoryInfo } from "../../sysmon/parse";
import { agentSpec, clipboardSpec, meetingSpec, sysmonSpec, timersSpec, type ExtraSpec, type TimerActions } from "./specs";

export type ExtraId = "timers" | "sysmon" | "meeting" | "clipboard" | "agent";

export interface ExtraInfo {
  id: ExtraId;
  title: string;
  description: string;
  icon: string;
  defaultOn: boolean;
}

export const EXTRAS: ExtraInfo[] = [
  { id: "timers", title: "Timers", description: "Countdown of the soonest timer, with pause / stop for each", icon: "⏱️", defaultOn: true },
  { id: "sysmon", title: "System Monitor", description: "CPU and memory usage, refreshed every 2 seconds", icon: "📈", defaultOn: false },
  { id: "meeting", title: "Next Meeting", description: "Time until your next event; today’s events with Join links", icon: "📅", defaultOn: false },
  { id: "clipboard", title: "Clipboard", description: "Paste any of your last 10 clipboard entries", icon: "📋", defaultOn: false },
  { id: "agent", title: "Glide Agent", description: "Ask the agent from the menu bar; shows a running task", icon: "🪄", defaultOn: false },
];

export const isExtraId = (v: unknown): v is ExtraId => EXTRAS.some((e) => e.id === v);

/** Call another feature's renderer-facing method from main (they are plain functions). */
export function callFeature<T>(f: FeatureModule, method: string, ...args: unknown[]): T | undefined {
  const fn = f.methods?.[method];
  return fn ? (fn(...args) as T) : undefined;
}

export interface ExtraRuntime {
  start(): void;
  stop(): void;
}

/** Shows / updates / hides one status item. */
function slot(id: ExtraId) {
  let handle: MenuBarHandle | undefined;
  return {
    show(spec: ExtraSpec | null) {
      if (!spec) {
        handle?.remove();
        handle = undefined;
      } else if (handle) handle.update(spec);
      else handle = registerMenuBarItem({ id, ...spec });
    },
  };
}

export const timerActions = (ctx: FeatureContext): TimerActions => ({
  toggle: (id) => void callFeature(timersFeature, "toggle", id),
  add: (id, ms) => void callFeature(timersFeature, "add", id, ms),
  stop: (id) => void callFeature(timersFeature, "stop", id),
  stopwatchToggle: (id) => void callFeature(timersFeature, "stopwatchToggle", id),
  stopwatchRemove: (id) => void callFeature(timersFeature, "stopwatchRemove", id),
  startPreset: (id) => void callFeature(timersFeature, "startPreset", id),
  show: () => ctx.openView({ id: "timers.list" }),
});

export function timersState(): TimersState | undefined {
  return callFeature<TimersState>(timersFeature, "state");
}

// --- shared calendar cache (Next Meeting extra + Glide menu) ---------------------------------------

let schedule: ScheduleResult | undefined;
let scheduleListeners = new Set<() => void>();
export const cachedSchedule = () => schedule;
export async function refreshSchedule(): Promise<ScheduleResult | undefined> {
  try {
    const r = await callFeature<Promise<ScheduleResult>>(calendarFeature, "schedule");
    if (r) schedule = r;
  } catch {
    // keep the previous result
  }
  for (const l of scheduleListeners) l();
  return schedule;
}
export function onSchedule(cb: () => void): () => void {
  scheduleListeners.add(cb);
  return () => void scheduleListeners.delete(cb);
}
export function resetScheduleCacheForTests(): void {
  schedule = undefined;
  scheduleListeners = new Set();
}

// --- runtimes --------------------------------------------------------------------------------------

export function createExtras(ctx: FeatureContext): { runtimes: Record<ExtraId, ExtraRuntime>; timersTitle(title: string): void } {
  let timersTitle = "";
  let timersOn = false;
  const timersSlot = slot("timers");
  const renderTimers = () => {
    const s = timersState();
    timersSlot.show(timersOn && s ? timersSpec(s, timersTitle, Date.now(), timerActions(ctx)) : null);
  };

  const sysmonSlot = slot("sysmon");
  let sysTimer: NodeJS.Timeout | undefined;
  let prevCpu: CpuTimes[] = [];
  const cpuTimes = (): CpuTimes[] => os.cpus().map((c) => c.times);
  const readMemory = () =>
    new Promise<MemoryInfo | undefined>((resolve) =>
      execFile("/usr/bin/vm_stat", [], { timeout: 1500 }, (err, out) => resolve(err ? undefined : parseVmStat(String(out), os.totalmem()))),
    );
  const sampleSys = async () => {
    const next = cpuTimes();
    const cpu = prevCpu.length ? average(cpuDeltas(prevCpu, next)) : 0;
    prevCpu = next;
    const memory = await readMemory();
    if (!sysTimer) return; // stopped while vm_stat ran
    sysmonSlot.show(sysmonSpec({ cpu, cores: next.length, load: os.loadavg() as [number, number, number], ...(memory ? { memory } : {}) }, () => void ctx.executeItem("sysmon:open")));
  };

  const meetingSlot = slot("meeting");
  let meetingTimer: NodeJS.Timeout | undefined;
  let meetingOff: (() => void) | undefined;
  let meetingTicks = 0;
  const renderMeeting = () =>
    meetingSlot.show(
      meetingSpec(cachedSchedule(), Date.now(), {
        join: (url) => void callFeature(calendarFeature, "join", url),
        openCalendar: (iso) => void callFeature(calendarFeature, "openCalendar", iso),
        schedule: () => ctx.openView({ id: "calendar.schedule" }),
        // Permission prompts only ever follow this explicit menu click.
        requestAccess: () => void callFeature<Promise<unknown>>(calendarFeature, "requestAccess")?.then(() => refreshSchedule()),
        refresh: () => void refreshSchedule(),
      }),
    );

  const clipSlot = slot("clipboard");
  let clipTimer: NodeJS.Timeout | undefined;
  const renderClip = () => {
    const entries = callFeature<ClipSummary[]>(clipboardFeature, "list", { limit: 10 }) ?? [];
    clipSlot.show(
      clipboardSpec(
        entries,
        (id) => void callFeature<Promise<unknown>>(clipboardFeature, "paste", id),
        () => ctx.openView({ id: "clipboard.history" }),
      ),
    );
  };

  const agentSlot = slot("agent");
  let agentTimer: NodeJS.Timeout | undefined;
  const renderAgent = () => {
    const run = callFeature<RunSnapshot | null>(agentFeature, "activeRun") ?? null;
    agentSlot.show(
      agentSpec(run, {
        ask: (prompt) => void ctx.executeItem("agent:ask", prompt),
        cancel: (runId) => void callFeature(agentFeature, "cancel", runId),
      }),
    );
  };

  const safe = (fn: () => void) => () => {
    try {
      fn();
    } catch (err) {
      ctx.log("extra render failed", err);
    }
  };

  const runtimes: Record<ExtraId, ExtraRuntime> = {
    timers: {
      start() {
        timersOn = true;
        safe(renderTimers)();
      },
      stop() {
        timersOn = false;
        timersSlot.show(null);
      },
    },
    sysmon: {
      start() {
        if (sysTimer) return;
        prevCpu = cpuTimes();
        sysTimer = setInterval(() => void sampleSys().catch((err) => ctx.log("sysmon sample failed", err)), 2000);
        // First paint right away (CPU since the previous sample is unknown yet → 0 until the 2 s tick).
        void sampleSys();
      },
      stop() {
        clearInterval(sysTimer);
        sysTimer = undefined;
        sysmonSlot.show(null);
      },
    },
    meeting: {
      start() {
        if (meetingTimer) return;
        meetingOff = onSchedule(safe(renderMeeting));
        safe(renderMeeting)();
        void refreshSchedule();
        meetingTicks = 0;
        // Title has minute resolution: re-render every 30 s, re-fetch every 60 s.
        meetingTimer = setInterval(() => {
          if (++meetingTicks % 2 === 0) void refreshSchedule();
          else safe(renderMeeting)();
        }, 30_000);
      },
      stop() {
        clearInterval(meetingTimer);
        meetingTimer = undefined;
        meetingOff?.();
        meetingSlot.show(null);
      },
    },
    clipboard: {
      start() {
        if (clipTimer) return;
        safe(renderClip)();
        clipTimer = setInterval(safe(renderClip), 3000); // unchanged lists are diffed away
      },
      stop() {
        clearInterval(clipTimer);
        clipTimer = undefined;
        clipSlot.show(null);
      },
    },
    agent: {
      start() {
        if (agentTimer) return;
        safe(renderAgent)();
        agentTimer = setInterval(safe(renderAgent), 2000);
      },
      stop() {
        clearInterval(agentTimer);
        agentTimer = undefined;
        agentSlot.show(null);
      },
    },
  };

  return {
    runtimes,
    timersTitle(title) {
      timersTitle = title;
      if (timersOn) safe(renderTimers)();
    },
  };
}
