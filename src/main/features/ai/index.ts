/**
 * AI feature: Quick AI (launcher view "ai.chat"), the AI Chat window ("ai/chat"),
 * AI Commands over selected text, and the Settings → AI page backend.
 * The Anthropic key stays in this process (see keystore.ts / client.ts).
 */
import { clipboard, safeStorage, shell, type BrowserWindow } from "electron";
import type { ExecuteResult, ItemAction } from "@shared/ipc";
import type { ScoredItem, SearchItem } from "@shared/types";
import { pasteFromClipboard } from "../../workflows/runtime";
import type { FeatureContext, FeatureModule } from "../types";
import { ChatStore, isChatId, newChatId, sanitizeChat, deriveTitle } from "./chats";
import { AiError, describeError, isAbort, streamAnswer, testKey } from "./client";
import { KeyStore } from "./keystore";
import { DEFAULT_MODEL, isKnownModel, MODELS } from "./models";
import { BUILTIN_COMMANDS, fillTemplate, sanitizeCommand } from "./templates";
import type { AiCommandDef, AiSettings, AskRequest, AskStart, ChatMessage, DoneEvent, Effort, ErrorEvent, QuickAiProps, TestResult } from "./types";

const ID = "ai";
const DEFAULTS: AiSettings = { model: DEFAULT_MODEL, effort: "medium", customCommands: [] };
const EFFORTS: Effort[] = ["low", "medium", "high"];
const SELECTION_TIMEOUT_MS = 3000;

let ctx: FeatureContext | undefined;
let keys: KeyStore | undefined;
let chats: ChatStore | undefined;
let chatWindow: BrowserWindow | undefined;
let pending: { chatId?: string; prompt?: string } | null = null;
const active = new Map<string, AbortController>();

function need<T>(v: T | undefined): T {
  if (!v) throw new Error("AI feature not started");
  return v;
}

function settings(): AiSettings {
  const s = need(ctx).settings(DEFAULTS);
  return {
    model: isKnownModel(s.model) ? s.model : DEFAULT_MODEL,
    effort: EFFORTS.includes(s.effort) ? s.effort : "medium",
    customCommands: Array.isArray(s.customCommands) ? s.customCommands.map(sanitizeCommand).filter((c): c is AiCommandDef => !!c) : [],
  };
}

function allCommands(): AiCommandDef[] {
  // items() can be read before start(); custom commands appear on the next refresh.
  return ctx ? [...BUILTIN_COMMANDS, ...settings().customCommands] : BUILTIN_COMMANDS;
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

function isRequestId(v: unknown): v is string {
  return typeof v === "string" && /^[\w-]{1,100}$/.test(v);
}

function ask(raw: unknown): AskStart {
  const req = raw as Partial<AskRequest> | undefined;
  if (!req || !isRequestId(req.requestId) || !Array.isArray(req.messages)) return { ok: false, error: "Invalid request", errorKind: "bad-request" };
  const apiKey = need(keys).read();
  if (!apiKey) return { ok: false, error: "Add your API key in Settings → AI", errorKind: "no-key" };
  const requestId = req.requestId;
  const messages = sanitizeChat({ messages: req.messages })?.messages ?? [];
  const s = settings();
  const model = isKnownModel(req.model) ? req.model : s.model;
  const controller = new AbortController();
  active.get(requestId)?.abort();
  active.set(requestId, controller);
  const c = need(ctx);
  let text = "";
  void streamAnswer(
    { apiKey, model, effort: s.effort, messages, system: typeof req.system === "string" ? req.system.slice(0, 20_000) : undefined, signal: controller.signal },
    {
      onText: (delta) => {
        text += delta;
        c.emit("delta", { requestId, text: delta });
      },
    },
  )
    .then((out) => {
      const done: DoneEvent = { requestId, text: out.text, model: out.model, stopReason: out.stopReason };
      c.emit("done", done);
    })
    .catch((err: unknown) => {
      if (isAbort(err) || controller.signal.aborted) {
        const done: DoneEvent = { requestId, text, model, stopReason: null, cancelled: true };
        c.emit("done", done);
        return;
      }
      const e = describeError(err);
      const payload: ErrorEvent = { requestId, message: e.message, kind: e.kind };
      c.emit("error", payload);
    })
    .finally(() => {
      if (active.get(requestId) === controller) active.delete(requestId);
    });
  return { ok: true };
}

function cancel(requestId: unknown): boolean {
  if (!isRequestId(requestId)) return false;
  const c = active.get(requestId);
  c?.abort();
  return !!c;
}

async function testConnection(model: unknown): Promise<TestResult> {
  const apiKey = need(keys).read();
  if (!apiKey) return { ok: false, message: "No API key saved yet.", kind: "no-key" };
  try {
    const name = await testKey(apiKey, isKnownModel(model) ? model : settings().model);
    return { ok: true, message: `Connected — ${name} is available.` };
  } catch (err) {
    const e = describeError(err);
    return { ok: false, message: e.message, kind: e.kind };
  }
}

// ---------------------------------------------------------------------------
// Selection, clipboard and paste
// ---------------------------------------------------------------------------

type SelectionRead = { text: string; source: "selection" | "clipboard" | "none"; note?: string };

const SELECTION_REASONS: Record<string, string> = {
  "no-accessibility": "Glide needs Accessibility permission to read selected text",
  "no-target-app": "no app to read from",
  "no-focused-element": "nothing is focused there",
  "no-selected-text": "it didn't report a selection",
  timeout: "it took too long to answer",
};

/** Selected text of the app behind Glide via Accessibility, else the clipboard (with the reason why). */
async function readSelection(): Promise<SelectionRead> {
  const c = need(ctx);
  let note: string | undefined;
  if (c.helper.available()) {
    const res = await helperSelection();
    if (res.text?.trim()) return { text: res.text, source: "selection" };
    const why = SELECTION_REASONS[res.reason ?? ""] ?? "it didn't report a selection";
    note = `Couldn't read the selection${res.app ? ` in ${res.app}` : ""} (${why})`;
  } else note = "The Glide helper isn't running";
  const clip = await clipboard.readText();
  return clip.trim() ? { text: clip, source: "clipboard", note } : { text: "", source: "none", note };
}

async function helperSelection(): Promise<{ text: string | null; app?: string; reason?: string }> {
  try {
    const timeout = new Promise<{ text: null; reason: string }>((resolve) => setTimeout(() => resolve({ text: null, reason: "timeout" }), SELECTION_TIMEOUT_MS));
    return await Promise.race([need(ctx).helper.call("selection.text"), timeout]);
  } catch {
    return { text: null };
  }
}

async function pasteText(text: unknown): Promise<ExecuteResult> {
  if (typeof text !== "string" || !text) return { ok: false, error: "Nothing to paste" };
  const c = need(ctx);
  c.hideLauncher();
  await new Promise((r) => setTimeout(r, 120)); // let the previous app regain focus
  if (c.helper.available()) {
    try {
      const res = await c.helper.call("keys.paste", { text });
      if (res.ok) return { ok: true, hide: true };
    } catch {
      /* fall back to clipboard + ⌘V */
    }
  }
  await clipboard.writeText(text);
  try {
    await pasteFromClipboard();
    return { ok: true, hide: true };
  } catch (err) {
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)} — the answer is on your clipboard.` };
  }
}

function openUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return false;
  void shell.openExternal(parsed.toString());
  return true;
}

// ---------------------------------------------------------------------------
// Chat window
// ---------------------------------------------------------------------------

function openChatWindow(opts: { chatId?: unknown; prompt?: unknown; messages?: unknown; title?: unknown } = {}): { ok: boolean; chatId?: string } {
  const c = need(ctx);
  let chatId = isChatId(opts.chatId) ? opts.chatId : undefined;
  if (Array.isArray(opts.messages) && opts.messages.length) {
    const msgs = sanitizeChat({ messages: opts.messages })?.messages ?? [];
    const saved = need(chats).save({ id: newChatId(), title: typeof opts.title === "string" ? opts.title : deriveTitle(msgs), messages: msgs, model: settings().model });
    chatId = saved.id;
  }
  pending = { chatId, prompt: typeof opts.prompt === "string" && opts.prompt.trim() ? opts.prompt : undefined };
  c.hideLauncher();
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    c.emit("openChat", pending);
    return { ok: true, chatId };
  }
  const win = c.createWindow("ai/chat", {
    width: 880,
    height: 640,
    minWidth: 620,
    minHeight: 420,
    title: "AI Chat",
    titleBarStyle: "hiddenInset",
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (chatWindow === win) chatWindow = undefined;
  });
  chatWindow = win;
  return { ok: true, chatId };
}

function takePending(): { chatId?: string; prompt?: string } | null {
  const p = pending;
  pending = null;
  return p;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function setSettings(patch: unknown): AiSettings {
  if (!patch || typeof patch !== "object") return settings();
  const p = patch as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (isKnownModel(p.model)) out.model = p.model;
  if (typeof p.effort === "string" && (EFFORTS as string[]).includes(p.effort)) out.effort = p.effort;
  if (Array.isArray(p.customCommands)) {
    const seen = new Set(BUILTIN_COMMANDS.map((b) => b.id));
    const list: AiCommandDef[] = [];
    for (const raw of p.customCommands) {
      const cmd = sanitizeCommand(raw);
      if (!cmd) continue;
      let id = cmd.id;
      for (let n = 2; seen.has(id); n++) id = `${cmd.id}-${n}`;
      seen.add(id);
      list.push({ ...cmd, id, builtin: false });
    }
    out.customCommands = list;
  }
  const c = need(ctx);
  c.setSettings(out);
  if (out.customCommands) c.refreshCatalogue();
  return settings();
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

type ItemType = "chat" | "quick" | "ask" | "command";

function itemType(item: SearchItem): ItemType | undefined {
  const t = item.data?.type;
  return t === "chat" || t === "quick" || t === "ask" || t === "command" ? t : undefined;
}

function commandItem(cmd: AiCommandDef): SearchItem {
  return {
    id: `ai:command:${cmd.id}`,
    kind: "command",
    kindLabel: "AI Command",
    feature: ID,
    title: cmd.name,
    subtitle: cmd.builtin ? "AI Command · uses selected text" : "Custom AI Command",
    icon: { kind: "emoji", value: cmd.icon },
    keywords: ["ai", "selection", "text", ...(cmd.acceptsArgument ? ["translate"] : [])],
    acceptsArgument: !!cmd.acceptsArgument,
    data: { type: "command", commandId: cmd.id },
  };
}

function items(): SearchItem[] {
  return [
    {
      id: "ai:chat",
      kind: "command",
      kindLabel: "AI",
      feature: ID,
      title: "AI Chat",
      subtitle: "Chat with Claude in a window",
      icon: { kind: "emoji", value: "💬" },
      keywords: ["ai", "claude", "chat", "gpt", "assistant"],
      data: { type: "chat" },
    },
    {
      id: "ai:quick",
      kind: "command",
      kindLabel: "AI",
      feature: ID,
      title: "Quick AI",
      subtitle: "Ask Claude right here",
      icon: { kind: "emoji", value: "✨" },
      keywords: ["ai", "ask", "claude", "question"],
      acceptsArgument: true,
      data: { type: "quick" },
    },
    ...allCommands().map(commandItem),
  ];
}

function actions(item: SearchItem): ItemAction[] {
  switch (itemType(item)) {
    case "chat":
      return [{ id: "open", title: "Open AI Chat", icon: "💬" }];
    case "quick":
    case "ask":
      return [
        { id: "ask", title: "Ask AI", icon: "✨" },
        { id: "askInChat", title: "Ask in AI Chat", shortcut: "⌘⏎", icon: "💬" },
      ];
    case "command":
      return [
        { id: "run", title: "Run AI Command", icon: "✨" },
        { id: "editCommands", title: "Edit AI Commands…", shortcut: "⌘E", icon: "✎" },
      ];
    default:
      return [];
  }
}

async function runCommand(cmd: AiCommandDef, argument: string | undefined): Promise<ExecuteResult> {
  if (cmd.acceptsArgument && !argument) return { ok: false, error: `${cmd.name} needs an argument — press Tab and type it` };
  const sel = await readSelection();
  if (sel.source === "none") return { ok: false, error: "Select some text (or copy it) first, then run the command again." };
  const props: QuickAiProps = {
    prompt: fillTemplate(cmd.prompt, { selection: sel.text, argument }),
    title: cmd.acceptsArgument && argument ? `${cmd.name.replace(/\s*…$/, "")} ${argument}` : cmd.name,
    model: cmd.model || undefined,
    replaces: !!cmd.replaces && sel.source === "selection",
    notice: sel.source === "clipboard" ? `${sel.note ?? "No selected text found"} — used the clipboard instead.` : undefined,
  };
  return { ok: true, view: { id: "ai.chat", props: { ...props } } };
}

async function runAction(scored: ScoredItem, actionId: string): Promise<ExecuteResult> {
  const item = scored.item;
  const argument = scored.argument?.trim() || undefined;
  const prompt = argument ?? (typeof item.data?.prompt === "string" ? item.data.prompt : "");
  switch (actionId) {
    case "open":
      openChatWindow();
      return { ok: true, hide: true };
    case "ask":
      return { ok: true, view: { id: "ai.chat", props: { prompt } } };
    case "askInChat":
      openChatWindow({ prompt });
      return { ok: true, hide: true };
    case "editCommands":
      return { ok: true, navigate: "settings/ai" };
    case "run": {
      const cmd = allCommands().find((c) => c.id === item.data?.commandId);
      if (!cmd) return { ok: false, error: "AI command not found" };
      return runCommand(cmd, argument);
    }
  }
  return { ok: false, error: `Unknown action ${actionId}` };
}

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
    keys = new KeyStore(() => c.dataDir(), safeStorage);
    chats = new ChatStore(`${c.dataDir()}/chats`);
  },
  stop() {
    for (const c of active.values()) c.abort();
    active.clear();
  },
  items,
  actions,
  runAction,
  methods: {
    ask: (req) => ask(req),
    cancel: (id) => cancel(id),
    listChats: () => need(chats).list(),
    getChat: (id) => (isChatId(id) ? need(chats).get(id) : null),
    saveChat: (chat) => need(chats).save(chat),
    deleteChat: (id) => (isChatId(id) ? need(chats).delete(id) : false),
    getSettings: () => settings(),
    setSettings: (patch) => setSettings(patch),
    listModels: () => MODELS,
    listCommands: () => allCommands(),
    hasApiKey: () => need(keys).status(),
    setApiKey: (key) => need(keys).set(key),
    clearApiKey: () => need(keys).clear(),
    testConnection: (model) => testConnection(model),
    openChatWindow: (opts) => openChatWindow((opts ?? {}) as Parameters<typeof openChatWindow>[0]),
    takePending: () => takePending(),
    getSelection: () => readSelection(),
    copy: async (text) => {
      if (typeof text !== "string") return false;
      await clipboard.writeText(text);
      return true;
    },
    pasteText: (text) => pasteText(text),
    openUrl: (url) => openUrl(url),
  },
};

export { AiError };
