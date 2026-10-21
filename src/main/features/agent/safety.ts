/**
 * Safety policy that isn't tool-specific: the destructive-tool rate limit, the protected-process
 * list, and redaction of clipboard/selection content before a conversation is saved.
 */
import type { AgentTool } from "./tools";
import type { RunSnapshot } from "./types";

export const DESTRUCTIVE_LIMIT = 3;
export const DESTRUCTIVE_WINDOW_MS = 60_000;

/** Sliding-window limit shared by every run, so a looping model can't fire many kills/shortcuts. */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly limit = DESTRUCTIVE_LIMIT,
    private readonly windowMs = DESTRUCTIVE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a use and returns null, or returns why it is refused (nothing recorded). */
  take(): string | null {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.limit) {
      const wait = Math.ceil((this.windowMs - (t - this.hits[0]!)) / 1000);
      return `Rate limited: at most ${this.limit} actions like this per minute. Try again in ${wait} s.`;
    }
    this.hits.push(t);
    return null;
  }
}

/** Never signalled by the agent, even if the user approves. */
export const PROTECTED_PROCESS_NAMES: ReadonlySet<string> = new Set([
  "kernel_task", "launchd", "WindowServer", "loginwindow", "Finder", "Dock", "SystemUIServer", "coreaudiod", "mds", "mds_stores",
  "opendirectoryd", "securityd", "trustd", "cfprefsd", "distnoted", "logd", "notifyd", "powerd", "configd", "syslogd", "UserEventAgent",
  "coreservicesd", "fseventsd", "diskarbitrationd", "Glide", "Electron",
]);

export function isProtectedProcess(name: string, command: string): boolean {
  const base = command.split("/").pop() ?? command;
  if (PROTECTED_PROCESS_NAMES.has(name) || PROTECTED_PROCESS_NAMES.has(base)) return true;
  // Glide's own helpers ("Glide Helper (Renderer)", glide-helper) and anything inside Glide.app.
  return /(^|\/)Glide(\.app\/| Helper)/.test(command) || /^glide[-_ ]helper/i.test(base);
}

export const REDACTED = "[redacted — clipboard and selection text isn't saved in Glide Agent history]";

export interface SensitivityInfo {
  sensitiveResult: Set<string>;
  sensitiveArgs: Map<string, string[]>;
}

export function sensitivity(tools: Pick<AgentTool, "name" | "sensitiveResult" | "sensitiveArgs">[]): SensitivityInfo {
  const sensitiveResult = new Set<string>();
  const sensitiveArgs = new Map<string, string[]>();
  for (const t of tools) {
    if (t.sensitiveResult) sensitiveResult.add(t.name);
    if (t.sensitiveArgs?.length) sensitiveArgs.set(t.name, t.sensitiveArgs);
  }
  return { sensitiveResult, sensitiveArgs };
}

/** A copy of the run with clipboard/selection results and arguments replaced. */
export function redactRun(run: RunSnapshot, info: SensitivityInfo): RunSnapshot {
  const copy = JSON.parse(JSON.stringify(run)) as RunSnapshot;
  for (const e of copy.entries) {
    if (e.kind !== "step") continue;
    const st = e.step;
    if (info.sensitiveResult.has(st.tool) && st.result && st.status === "ok") st.result = REDACTED;
    const keys = info.sensitiveArgs.get(st.tool);
    if (keys) {
      let changed = false;
      for (const k of keys)
        if (typeof st.args[k] === "string") {
          st.args[k] = REDACTED;
          changed = true;
        }
      if (changed) {
        st.summary = `${st.title} (content redacted)`;
        delete st.workflow;
      }
    }
  }
  return copy;
}
