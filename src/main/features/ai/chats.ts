import fs from "node:fs";
import path from "node:path";
import type { Chat, ChatMessage, ChatSummary } from "./types";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MESSAGES = 500;
const MAX_CONTENT = 400_000;

export function isChatId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Title from the first user message (Raycast-like). */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.replace(/\s+/g, " ").trim() ?? "";
  if (!first) return "New Chat";
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if ((r.role !== "user" && r.role !== "assistant") || typeof r.content !== "string") continue;
    out.push({
      role: r.role,
      content: r.content.slice(0, MAX_CONTENT),
      at: typeof r.at === "number" ? r.at : undefined,
      model: typeof r.model === "string" ? r.model : undefined,
    });
  }
  return out;
}

export function sanitizeChat(raw: unknown, now = Date.now()): Chat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = isChatId(r.id) ? r.id : newChatId();
  const messages = sanitizeMessages(r.messages);
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 120) : deriveTitle(messages);
  return {
    id,
    title,
    model: typeof r.model === "string" ? r.model : undefined,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
    updatedAt: now,
    messages,
  };
}

/** One JSON file per chat in <dir>/<id>.json. */
export class ChatStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!isChatId(id)) throw new Error("Invalid chat id");
    return path.join(this.dir, `${id}.json`);
  }

  list(): ChatSummary[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: ChatSummary[] = [];
    for (const n of names) {
      const chat = this.get(n.slice(0, -5));
      if (!chat) continue;
      const last = chat.messages[chat.messages.length - 1];
      out.push({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, messageCount: chat.messages.length, preview: (last?.content ?? "").slice(0, 140) });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Chat | null {
    if (!isChatId(id)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Record<string, unknown>;
      const chat = sanitizeChat({ ...parsed, id }, typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now());
      return chat;
    } catch {
      return null;
    }
  }

  save(raw: unknown): Chat {
    const chat = sanitizeChat(raw);
    if (!chat) throw new Error("Invalid chat");
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(chat.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(chat, null, 2));
    fs.renameSync(tmp, file);
    return chat;
  }

  delete(id: string): boolean {
    if (!isChatId(id)) return false;
    try {
      fs.unlinkSync(this.file(id));
      return true;
    } catch {
      return false;
    }
  }
}
