/**
 * The request log shown in Settings → MCP Server: who called what, when, and how it ended.
 * Arguments and results are never stored, only the call's plain-English summary (and for
 * clipboard/text tools not even that).
 */
import fs from "node:fs";
import path from "node:path";

export type LogOutcome = "ok" | "error" | "denied" | "timeout" | "off" | "rate-limited" | "invalid";

export interface LogEntry {
  id: string;
  at: number;
  client: string;
  tool: string;
  summary: string;
  outcome: LogOutcome;
  ms: number;
  error?: string;
  /** How it was allowed: without asking, by the user, or by an Always grant. */
  approval?: "auto" | "user" | "always";
}

export interface RequestLog {
  add(e: Omit<LogEntry, "id">): LogEntry;
  list(): LogEntry[];
  clear(): void;
}

const MAX = 300;

export function createRequestLog(opts: { file?: string; onChange?(): void } = {}): RequestLog {
  let entries: LogEntry[] = [];
  if (opts.file) {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.file, "utf8")) as unknown;
      if (Array.isArray(raw)) entries = raw.filter((e): e is LogEntry => !!e && typeof e === "object" && typeof (e as LogEntry).tool === "string").slice(-MAX);
    } catch {
      // first run
    }
  }
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (!opts.file || timer) return;
    const file = opts.file;
    timer = setTimeout(() => {
      timer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
      } catch {
        // the log is best effort
      }
    }, 300);
  };
  return {
    add(e) {
      const entry: LogEntry = { ...e, id: `${e.at.toString(36)}-${(++seq).toString(36)}` };
      entries.push(entry);
      if (entries.length > MAX) entries = entries.slice(-MAX);
      persist();
      opts.onChange?.();
      return entry;
    },
    list: () => [...entries].reverse(),
    clear() {
      entries = [];
      persist();
      opts.onChange?.();
    },
  };
}
