/**
 * Saved conversations (<dataDir>/conversations.json): list, search, load, delete. Callers pass
 * already-redacted records; this module only stores them. Writes are debounced and atomic.
 */
import fs from "node:fs";
import path from "node:path";
import type { MessageParam } from "./client";
import type { ConversationSummary, RunSnapshot } from "./types";

export const MAX_CONVERSATIONS = 100;
const MAX_RUNS = 50;
const WRITE_DELAY_MS = 300;

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  runs: RunSnapshot[];
  messages: MessageParam[];
}

interface FileShape {
  version: 1;
  conversations: ConversationRecord[];
}

function isRecord(v: unknown): v is ConversationRecord {
  const r = v as Partial<ConversationRecord> | null;
  return !!r && typeof r.id === "string" && typeof r.title === "string" && typeof r.updatedAt === "number" && Array.isArray(r.runs) && Array.isArray(r.messages);
}

export class ConversationStore {
  private list: ConversationRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private loaded = false;

  constructor(private readonly file: () => string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Partial<FileShape>;
      this.list = Array.isArray(raw.conversations) ? raw.conversations.filter(isRecord) : [];
    } catch {
      this.list = [];
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.loaded) return;
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const data: FileShape = { version: 1, conversations: this.list };
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  put(rec: ConversationRecord): void {
    this.load();
    const runs = rec.runs.slice(-MAX_RUNS);
    const next = { ...rec, runs };
    this.list = [next, ...this.list.filter((c) => c.id !== rec.id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
    this.schedule();
  }

  get(id: string): ConversationRecord | undefined {
    this.load();
    return this.list.find((c) => c.id === id);
  }

  delete(id: string): boolean {
    this.load();
    const before = this.list.length;
    this.list = this.list.filter((c) => c.id !== id);
    if (this.list.length === before) return false;
    this.schedule();
    return true;
  }

  clear(): number {
    this.load();
    const n = this.list.length;
    this.list = [];
    this.schedule();
    return n;
  }

  /** Newest first; every word of the query must appear in the title or a prompt/reply. */
  search(query: string, limit = MAX_CONVERSATIONS): ConversationSummary[] {
    this.load();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (c: ConversationRecord) =>
      [c.title, ...c.runs.flatMap((r) => r.entries.flatMap((e) => (e.kind === "prompt" || e.kind === "text" ? [e.text] : [])))].join("\n").toLowerCase();
    return this.list
      .filter((c) => !words.length || words.every((w) => hay(c).includes(w)))
      .slice(0, limit)
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, runs: c.runs.length, preview: c.runs.at(-1)?.prompt ?? "" }));
  }
}
