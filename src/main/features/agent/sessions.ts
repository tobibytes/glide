/**
 * Conversations in memory (this session) plus their saved copies: follow-up history, undo
 * closures, persistence with redaction, and resuming a saved conversation.
 */
import type { MessageParam } from "./client";
import { redactMessages, titleFor } from "./conversation";
import type { ConversationRecord, ConversationStore } from "./history";
import { redactRun, type SensitivityInfo } from "./safety";
import type { Undo } from "./tools";
import type { ConversationSummary, ConversationView, RunSnapshot } from "./types";

export interface LiveConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  runs: RunSnapshot[];
  /** Unredacted API history (memory only). */
  messages: MessageParam[];
  /** runId → stepId → undo closure (memory only; gone after a restart). */
  undos: Map<string, Map<string, Undo>>;
}

export interface SessionOptions {
  store: ConversationStore;
  sensitivity: () => SensitivityInfo;
  keepSensitive: () => boolean;
  saveHistory: () => boolean;
  now?: () => number;
}

export class Sessions {
  private live = new Map<string, LiveConversation>();
  constructor(private readonly o: SessionOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  create(id: string, prompt: string): LiveConversation {
    const t = this.now();
    const c: LiveConversation = { id, title: titleFor(prompt), createdAt: t, updatedAt: t, runs: [], messages: [], undos: new Map() };
    this.live.set(id, c);
    return c;
  }

  /** A conversation from this session, or a saved one loaded for resuming. */
  get(id: string): LiveConversation | undefined {
    const hit = this.live.get(id);
    if (hit) return hit;
    const rec = this.o.store.get(id);
    if (!rec) return undefined;
    const c: LiveConversation = { id: rec.id, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt, runs: rec.runs.map(dropStaleUndo), messages: rec.messages, undos: new Map() };
    this.live.set(id, c);
    return c;
  }

  /** The most recently used conversation of this session. */
  latest(): LiveConversation | undefined {
    return [...this.live.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  ofRun(runId: string): LiveConversation | undefined {
    for (const c of this.live.values()) if (c.runs.some((r) => r.runId === runId)) return c;
    return undefined;
  }

  putRun(c: LiveConversation, snap: RunSnapshot): void {
    const i = c.runs.findIndex((r) => r.runId === snap.runId);
    if (i >= 0) c.runs[i] = snap;
    else c.runs.push(snap);
    c.updatedAt = this.now();
  }

  view(c: LiveConversation): ConversationView {
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, runs: c.runs };
  }

  /** Saves the conversation (redacted unless the user opted in). No-op when history is off. */
  persist(c: LiveConversation): void {
    if (!this.o.saveHistory()) return;
    const keep = this.o.keepSensitive();
    const info = this.o.sensitivity();
    const runs = c.runs.filter((r) => r.status !== "running" && r.status !== "confirming");
    if (!runs.length) return;
    const rec: ConversationRecord = {
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      runs: keep ? runs : runs.map((r) => redactRun(r, info)),
      messages: redactMessages(c.messages, info, keep),
    };
    this.o.store.put(rec);
  }

  list(query: string): ConversationSummary[] {
    const saved = this.o.store.search(query);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const unsaved = [...this.live.values()]
      .filter((c) => c.runs.length && !saved.some((s) => s.id === c.id) && (!this.o.saveHistory() || !this.o.store.get(c.id)))
      .filter((c) => {
        const hay = [c.title, ...c.runs.map((r) => r.prompt)].join("\n").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, runs: c.runs.length, preview: c.runs.at(-1)?.prompt ?? "" }));
    return [...unsaved, ...saved].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): boolean {
    const a = this.live.delete(id);
    const b = this.o.store.delete(id);
    return a || b;
  }

  clear(): number {
    const n = this.o.store.clear();
    const live = this.live.size;
    this.live.clear();
    return Math.max(n, live);
  }
}

/** Undo closures don't survive a restart; don't offer undo for steps loaded from disk. */
function dropStaleUndo(r: RunSnapshot): RunSnapshot {
  const copy = JSON.parse(JSON.stringify(r)) as RunSnapshot;
  for (const e of copy.entries) {
    if (e.kind === "step" && e.step.undo?.state === "available") delete e.step.undo;
    if (e.kind === "summary") e.undoable = 0;
  }
  return copy;
}
