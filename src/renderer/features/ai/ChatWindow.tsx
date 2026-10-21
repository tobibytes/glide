/** Window route "ai/chat": two-pane chat app (chat list + conversation). Keyboard-first, ⌘K palette. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "../../components/Kbd";
import { ai, lastAnswer, useConversation, SETTINGS_PAGE, type Chat, type ChatMessage, type ChatSummary, type ModelInfo } from "./api";
import { Markdown } from "./Markdown";
import { AddKeyState, ErrorNote, Thinking } from "./common";

function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.replace(/<selection>[\s\S]*?<\/selection>/g, "").replace(/\s+/g, " ").trim() ?? "";
  if (!first) return "New Chat";
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface PaletteAction {
  id: string;
  title: string;
  shortcut?: string;
  section: string;
  run(): void;
}

export function ChatWindow() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [chatId, setChatId] = useState<string | null>(null);
  const [title, setTitle] = useState("New Chat");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<{ text: string; source: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatIdRef = useRef<string | null>(null);
  const titleRef = useRef("New Chat");
  const createdRef = useRef(Date.now());
  const modelRef = useRef("");
  chatIdRef.current = chatId;
  titleRef.current = title;
  modelRef.current = model;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
  }, []);

  const refreshList = useCallback(async () => setChats(await ai.listChats()), []);

  const persist = useCallback(
    async (messages: ChatMessage[]) => {
      if (!messages.some((m) => m.content.trim())) return;
      const id = chatIdRef.current ?? newChatId();
      const t = titleRef.current === "New Chat" ? titleFrom(messages) : titleRef.current;
      const saved = await ai.saveChat({ id, title: t, model: modelRef.current, createdAt: createdRef.current, messages: messages.filter((m) => m.content.trim()) });
      chatIdRef.current = saved.id;
      setChatId(saved.id);
      setTitle(saved.title);
      void refreshList();
    },
    [refreshList],
  );

  const conv = useConversation({ onDone: (msgs) => void persist(msgs) });
  const { messages, setMessages, streaming, error, setError, send, stop } = conv;

  const newChat = useCallback(() => {
    stop();
    setChatId(null);
    setTitle("New Chat");
    createdRef.current = Date.now();
    setMessages([]);
    setError(null);
    setAttachment(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [stop, setMessages, setError]);

  const openChat = useCallback(
    async (id: string) => {
      stop();
      const chat: Chat | null = await ai.getChat(id);
      if (!chat) return showToast("Chat not found");
      setChatId(chat.id);
      setTitle(chat.title);
      createdRef.current = chat.createdAt;
      if (chat.model) setModel(chat.model);
      setMessages(chat.messages);
      setError(null);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    },
    [stop, setMessages, setError, showToast],
  );

  const submit = useCallback(
    async (text: string) => {
      const body = text.trim();
      if ((!body && !attachment) || streaming) return;
      const content = attachment ? `${body || "Help me with this text."}\n\n<selection>\n${attachment.text}\n</selection>` : body;
      const history: ChatMessage[] = [...messages.filter((m) => m.content.trim()), { role: "user", content, at: Date.now() }];
      setDraft("");
      setAttachment(null);
      await persist(history);
      void send(history, modelRef.current || undefined);
    },
    [attachment, streaming, messages, persist, send],
  );

  const handlePending = useCallback(
    async (p: { chatId?: string; prompt?: string } | null) => {
      if (!p) return;
      if (p.chatId) await openChat(p.chatId);
      else newChat();
      if (p.prompt) {
        const history: ChatMessage[] = [{ role: "user", content: p.prompt, at: Date.now() }];
        chatIdRef.current = null;
        await persist(history);
        void send(history, modelRef.current || undefined);
      }
    },
    [openChat, newChat, persist, send],
  );

  // Boot
  useEffect(() => {
    document.title = "AI Chat";
    document.body.classList.add("ai-window-body");
    void (async () => {
      const [status, s, ms] = await Promise.all([ai.hasApiKey(), ai.getSettings(), ai.listModels()]);
      setHasKey(status.hasKey);
      setModels(ms);
      setModel(s.model);
      modelRef.current = s.model;
      await refreshList();
      await handlePending(await ai.takePending());
    })();
    const offEvt = window.glide.onFeatureEvent((e) => {
      if (e.feature === "ai" && e.event === "openChat") void ai.takePending().then(handlePending);
    });
    const onFocus = () => void ai.hasApiKey().then((st) => setHasKey(st.hasKey));
    window.addEventListener("focus", onFocus);
    return () => {
      offEvt();
      window.removeEventListener("focus", onFocus);
      document.body.classList.remove("ai-window-body");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? chats.filter((c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)) : chats;
  }, [chats, search]);

  useEffect(() => setHighlight(0), [search]);

  const useSelection = useCallback(async () => {
    const sel = await ai.getSelection();
    if (sel.source === "none") return showToast("No selected text or clipboard text found");
    setAttachment({ text: sel.text, source: sel.source });
    showToast(sel.source === "clipboard" ? "No selection found — attached clipboard text" : "Selection attached");
    composerRef.current?.focus();
  }, [showToast]);

  const deleteChat = useCallback(
    async (id: string | null) => {
      if (!id) return;
      const c = chats.find((x) => x.id === id);
      if (!confirm(`Delete “${c?.title ?? "this chat"}”?`)) return;
      await ai.deleteChat(id);
      if (id === chatIdRef.current) newChat();
      await refreshList();
    },
    [chats, newChat, refreshList],
  );

  const commitRename = useCallback(
    async (id: string, value: string) => {
      setRenaming(null);
      const name = value.trim();
      if (!name) return;
      const chat = await ai.getChat(id);
      if (!chat) return;
      await ai.saveChat({ ...chat, title: name });
      if (id === chatIdRef.current) setTitle(name);
      await refreshList();
    },
    [refreshList],
  );

  const changeModel = useCallback(
    async (id: string) => {
      setModel(id);
      modelRef.current = id;
      if (chatIdRef.current && messages.length) await persist(messages);
      showToast(`Model: ${models.find((m) => m.id === id)?.label ?? id}`);
    },
    [messages, models, persist, showToast],
  );

  const copyLast = useCallback(async () => {
    const a = lastAnswer(messages);
    if (!a) return;
    await ai.copy(a);
    showToast("Answer copied");
  }, [messages, showToast]);

  const moveChat = useCallback(
    (dir: 1 | -1) => {
      if (!chats.length) return;
      const idx = chats.findIndex((c) => c.id === chatIdRef.current);
      const next = chats[Math.min(chats.length - 1, Math.max(0, idx < 0 ? 0 : idx + dir))];
      if (next) void openChat(next.id);
    },
    [chats, openChat],
  );

  const actions: PaletteAction[] = useMemo(
    () => [
      { id: "new", section: "Chat", title: "New Chat", shortcut: "⌘N", run: newChat },
      ...(streaming ? [{ id: "stop", section: "Chat", title: "Stop Generating", shortcut: "⌘.", run: stop }] : []),
      { id: "copy", section: "Chat", title: "Copy Last Answer", shortcut: "⌘⇧C", run: () => void copyLast() },
      { id: "sel", section: "Chat", title: "Use Selection", shortcut: "⌘⇧S", run: () => void useSelection() },
      ...(chatId
        ? [
            { id: "rename", section: "Chat", title: "Rename Chat", shortcut: "⌘R", run: () => setRenaming(chatId) },
            { id: "delete", section: "Chat", title: "Delete Chat", shortcut: "⌘⌫", run: () => void deleteChat(chatId) },
          ]
        : []),
      { id: "search", section: "Navigate", title: "Search Chats", shortcut: "⌘F", run: () => searchRef.current?.focus() },
      { id: "compose", section: "Navigate", title: "Focus Composer", shortcut: "⌘L", run: () => composerRef.current?.focus() },
      { id: "next", section: "Navigate", title: "Next Chat", shortcut: "⌥⌘↓", run: () => moveChat(1) },
      { id: "prev", section: "Navigate", title: "Previous Chat", shortcut: "⌥⌘↑", run: () => moveChat(-1) },
      ...models.map((m) => ({ id: `model:${m.id}`, section: "Model", title: `${m.id === model ? "✓ " : ""}${m.label} — ${m.description}`, run: () => void changeModel(m.id) })),
      { id: "settings", section: "Glide", title: "AI Settings…", run: () => window.glide.openSettings(SETTINGS_PAGE) },
    ],
    [newChat, streaming, stop, copyLast, useSelection, chatId, deleteChat, moveChat, models, model, changeModel],
  );

  const paletteItems = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    return q ? actions.filter((a) => a.title.toLowerCase().includes(q) || a.section.toLowerCase().includes(q)) : actions;
  }, [actions, paletteQuery]);

  const openPalette = () => {
    setPaletteQuery("");
    setPaletteIndex(0);
    setPalette(true);
  };

  // Global shortcuts
  const live = useRef({ actions, streaming, palette, renaming, chatId, newChat, stop, copyLast, useSelection, deleteChat, moveChat });
  live.current = { actions, streaming, palette, renaming, chatId, newChat, stop, copyLast, useSelection, deleteChat, moveChat };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (s.palette) return; // the palette input handles its own keys
      const k = e.key.toLowerCase();
      const mod = e.metaKey;
      const h = () => e.preventDefault();
      if (mod && k === "k") return h(), openPalette();
      if (mod && !e.shiftKey && k === "n") return h(), s.newChat();
      if (mod && k === "f") return h(), searchRef.current?.focus();
      if (mod && k === "l") return h(), composerRef.current?.focus();
      if (mod && k === ".") return h(), s.stop();
      if (mod && e.shiftKey && k === "c") return h(), void s.copyLast();
      if (mod && e.shiftKey && k === "s") return h(), void s.useSelection();
      if (mod && k === "r" && s.chatId) return h(), setRenaming(s.chatId);
      if (mod && k === "backspace" && s.chatId && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") return h(), void s.deleteChat(s.chatId);
      if (mod && e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) return h(), s.moveChat(e.key === "ArrowDown" ? 1 : -1);
      if (mod && k === "w") return h(), window.close();
      if (e.key === "Escape" && s.streaming) return h(), s.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "j" || e.key === "n"))) {
      e.preventDefault();
      setHighlight((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "k" || e.key === "p"))) {
      e.preventDefault();
      setHighlight((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = filtered[highlight];
      if (c) void openChat(c.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (search) setSearch("");
      else composerRef.current?.focus();
    }
  };

  const onPaletteKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      setPalette(false);
      composerRef.current?.focus();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "j" || e.key === "n"))) {
      e.preventDefault();
      setPaletteIndex((i) => Math.min(paletteItems.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "k" || e.key === "p"))) {
      e.preventDefault();
      setPaletteIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = paletteItems[paletteIndex];
      setPalette(false);
      if (a) a.run();
      if (a?.id !== "search" && a?.id !== "rename") requestAnimationFrame(() => composerRef.current?.focus());
    }
  };

  const shown = messages.filter((m, i) => m.content.trim() || i === messages.length - 1);
  const modelLabel = models.find((m) => m.id === model)?.label ?? model;

  return (
    <div className="ai-win" data-testid="ai-chat-window">
      <aside className="ai-win__side">
        <div className="ai-win__sidetop drag" />
        <div className="ai-win__searchrow">
          <input ref={searchRef} className="ai-win__search" placeholder="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} aria-label="Search chats" />
          <button type="button" className="ai-iconbtn" title="New Chat (⌘N)" onClick={newChat}>
            ＋
          </button>
        </div>
        <div className="ai-win__list" role="listbox" aria-label="Chats">
          {filtered.length === 0 && <div className="ai-win__listempty">{search ? "No matching chats" : "No chats yet"}</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={c.id === chatId}
              className={`ai-chatrow ${c.id === chatId ? "ai-chatrow--on" : ""} ${document.activeElement === searchRef.current && i === highlight ? "ai-chatrow--hl" : ""}`}
              onClick={() => void openChat(c.id)}
              onDoubleClick={() => setRenaming(c.id)}
            >
              {renaming === c.id ? (
                <input
                  className="ai-chatrow__rename"
                  autoFocus
                  defaultValue={c.title}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(c.id, e.currentTarget.value);
                    if (e.key === "Escape") setRenaming(null);
                    e.stopPropagation();
                  }}
                  onBlur={(e) => void commitRename(c.id, e.currentTarget.value)}
                />
              ) : (
                <>
                  <div className="ai-chatrow__title">{c.title}</div>
                  <div className="ai-chatrow__meta">
                    <span className="ai-chatrow__preview">{c.preview}</span>
                    <span>{relTime(c.updatedAt)}</span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="ai-win__sidefoot">
          <span>
            <Kbd keys="⌘N" /> New
          </span>
          <span>
            <Kbd keys="⌘K" /> Actions
          </span>
        </div>
      </aside>

      <main className="ai-win__main">
        <header className="ai-win__head drag">
          <div className="ai-win__title">{title}</div>
          <select className="ai-win__model no-drag" value={model} onChange={(e) => void changeModel(e.target.value)} aria-label="Model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </header>

        {hasKey === false ? (
          <AddKeyState />
        ) : (
          <>
            <div className="ai-win__scroll" ref={scrollRef}>
              {shown.length === 0 && (
                <div className="ai-win__empty">
                  <div className="ai-win__emptyicon">💬</div>
                  <div>Ask {modelLabel || "Claude"} anything</div>
                  <div className="ai-win__emptyhint">
                    <Kbd keys="⏎" /> send · <Kbd keys="⇧⏎" /> new line · <Kbd keys="⌘⇧S" /> use selection · <Kbd keys="⌘K" /> actions
                  </div>
                </div>
              )}
              {shown.map((m, i) => (
                <div key={i} className={`ai-msg ai-msg--${m.role}`}>
                  <div className="ai-msg__who">{m.role === "user" ? "You" : models.find((x) => x.id === m.model)?.label ?? "Claude"}</div>
                  {m.role === "user" ? (
                    <UserContent text={m.content} />
                  ) : m.content ? (
                    <Markdown text={m.content} />
                  ) : (
                    streaming && <Thinking />
                  )}
                </div>
              ))}
              {error && <ErrorNote message={error.message} kind={error.kind} />}
            </div>

            <div className="ai-composer">
              {attachment && (
                <div className="ai-composer__att">
                  <span className="ai-composer__atttag">{attachment.source === "clipboard" ? "Clipboard" : "Selection"}</span>
                  <span className="ai-composer__atttext">{attachment.text.slice(0, 200)}</span>
                  <button type="button" className="ai-iconbtn" title="Remove attachment" onClick={() => setAttachment(null)}>
                    ✕
                  </button>
                </div>
              )}
              <textarea
                ref={composerRef}
                className="ai-composer__input"
                placeholder={streaming ? "Generating… (⌘. to stop)" : "Message Claude…"}
                value={draft}
                rows={Math.min(8, Math.max(1, draft.split("\n").length))}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit(draft);
                  }
                }}
                autoFocus
                aria-label="Message"
              />
              <div className="ai-composer__bar">
                <button type="button" className="ai-btn" onClick={() => void useSelection()} title="Attach the selected text (⌘⇧S)">
                  Use Selection
                </button>
                <span className="ai-composer__spacer" />
                {streaming ? (
                  <button type="button" className="ai-btn ai-btn--danger" onClick={stop} data-testid="ai-stop">
                    Stop <Kbd keys="⌘." />
                  </button>
                ) : (
                  <button type="button" className="ai-btn ai-btn--primary" onClick={() => void submit(draft)} disabled={!draft.trim() && !attachment}>
                    Send <Kbd keys="⏎" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {palette && (
        <div className="ai-palette__backdrop" onMouseDown={() => setPalette(false)}>
          <div className="ai-palette" onMouseDown={(e) => e.stopPropagation()}>
            <input className="ai-palette__input" autoFocus placeholder="Search actions…" value={paletteQuery} onChange={(e) => (setPaletteQuery(e.target.value), setPaletteIndex(0))} onKeyDown={onPaletteKey} />
            <div className="ai-palette__list">
              {paletteItems.map((a, i) => (
                <div key={a.id}>
                  {a.section !== paletteItems[i - 1]?.section && <div className="section-header">{a.section}</div>}
                  <div className={`ai-panel__item ${i === paletteIndex ? "ai-panel__item--on" : ""}`} onMouseMove={() => setPaletteIndex(i)} onClick={() => (setPalette(false), a.run())}>
                    <span>{a.title}</span>
                    {a.shortcut && <Kbd keys={a.shortcut} />}
                  </div>
                </div>
              ))}
              {!paletteItems.length && <div className="ai-win__listempty">No actions</div>}
            </div>
          </div>
        </div>
      )}
      {toast && <div className="ai-toast">{toast}</div>}
    </div>
  );
}

/** User messages are plain text; an attached selection is shown as a quoted block. */
function UserContent({ text }: { text: string }) {
  const m = /^([\s\S]*?)\n\n<selection>\n([\s\S]*)\n<\/selection>$/.exec(text);
  if (!m) return <div className="ai-msg__text">{text}</div>;
  return (
    <div className="ai-msg__text">
      {m[1]}
      <div className="ai-msg__sel">{m[2]}</div>
    </div>
  );
}
