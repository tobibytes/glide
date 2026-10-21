/**
 * Launcher view "ai.chat" (Quick AI). The launcher search field is the follow-up input.
 * Keys are handled in a window capture listener so they win over the launcher's own handlers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Kbd } from "../../components/Kbd";
import type { ViewProps } from "../types";
import type { QuickAiProps } from "../../../main/features/ai/types";
import { ai, lastAnswer, SETTINGS_PAGE, type ChatMessage } from "./api";
import { useConversation } from "./api";
import { Markdown } from "./Markdown";
import { AddKeyState, ErrorNote, Thinking } from "./common";

interface Action {
  id: string;
  title: string;
  shortcut?: string;
  run(): void;
}

function readProps(p: Record<string, unknown>): QuickAiProps {
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { prompt: s(p.prompt), title: s(p.title), model: s(p.model), replaces: p.replaces === true, notice: s(p.notice) };
}

export function QuickAI(view: ViewProps) {
  const props = readProps(view.props);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [panel, setPanel] = useState(false);
  const [panelIndex, setPanelIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const conv = useConversation({ model: props.model });
  const { messages, streaming, error, send, stop } = conv;
  const answer = lastAnswer(messages);

  useEffect(() => {
    view.setPlaceholder(props.prompt ? "Ask a follow-up…" : "Ask AI anything…");
    void ai.hasApiKey().then((s) => setHasKey(s.hasKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hasKey && props.prompt?.trim() && !started.current) {
      started.current = true;
      void send([{ role: "user", content: props.prompt, at: Date.now() }]);
    }
  }, [hasKey, props.prompt, send]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const followUp = useCallback(
    (text: string) => {
      const history: ChatMessage[] = [...messages.filter((m) => m.content.trim()), { role: "user", content: text, at: Date.now() }];
      view.setQuery("");
      void send(history);
    },
    [messages, send, view],
  );

  const copy = useCallback(async () => {
    if (!answer) return;
    await ai.copy(answer);
    view.toast("Answer copied");
  }, [answer, view]);

  const paste = useCallback(async () => {
    if (!answer) return;
    const res = await ai.pasteText(answer);
    if (!res.ok) view.toast(res.error ?? "Paste failed", "error");
  }, [answer, view]);

  const continueInChat = useCallback(async () => {
    const msgs = messages.filter((m) => m.content.trim());
    if (streaming) stop();
    await ai.openChatWindow(msgs.length ? { messages: msgs, title: props.title } : { prompt: view.query });
  }, [messages, streaming, stop, props.title, view.query]);

  const regenerate = useCallback(() => {
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUser >= 0) void send(messages.slice(0, lastUser + 1));
  }, [messages, send]);

  const actions: Action[] = hasKey
    ? [
        ...(props.replaces ? [{ id: "replace", title: "Replace Selection", shortcut: "⏎", run: () => void paste() }] : []),
        { id: "copy", title: "Copy Answer", shortcut: "⌘C", run: () => void copy() },
        { id: "paste", title: props.replaces ? "Paste Answer" : "Paste to Frontmost App", shortcut: "⌘⇧V", run: () => void paste() },
        { id: "chat", title: "Continue in AI Chat", shortcut: "⌘⏎", run: () => void continueInChat() },
        { id: "regen", title: "Regenerate", shortcut: "⌘R", run: regenerate },
        ...(streaming ? [{ id: "stop", title: "Stop Generating", shortcut: "esc", run: stop }] : []),
        { id: "settings", title: "AI Settings…", run: () => window.glide.openSettings(SETTINGS_PAGE) },
      ]
    : [{ id: "settings", title: "Open Settings → AI", shortcut: "⏎", run: () => window.glide.openSettings(SETTINGS_PAGE) }];

  // Keep the latest closures for the capture listener.
  const live = useRef({ actions, panel, panelIndex, streaming, hasKey, answer, followUp, copy, paste, continueInChat, regenerate, stop, view, props });
  live.current = { actions, panel, panelIndex, streaming, hasKey, answer, followUp, copy, paste, continueInChat, regenerate, stop, view, props };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      const k = e.key;
      const mod = e.metaKey;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (s.panel) {
        if (k === "Escape" || (mod && k.toLowerCase() === "k")) {
          handled();
          setPanel(false);
        } else if (k === "ArrowDown" || (e.ctrlKey && (k === "j" || k === "n"))) {
          handled();
          setPanelIndex((i) => Math.min(s.actions.length - 1, i + 1));
        } else if (k === "ArrowUp" || (e.ctrlKey && (k === "k" || k === "p"))) {
          handled();
          setPanelIndex((i) => Math.max(0, i - 1));
        } else if (k === "Enter") {
          handled();
          setPanel(false);
          s.actions[s.panelIndex]?.run();
        }
        return;
      }
      if (k === "Escape") {
        handled();
        if (s.streaming) s.stop();
        else s.view.pop();
        return;
      }
      if (mod && k.toLowerCase() === "k") {
        handled();
        setPanelIndex(0);
        setPanel(true);
        return;
      }
      if (!s.hasKey) {
        if (k === "Enter") {
          handled();
          window.glide.openSettings(SETTINGS_PAGE);
        }
        return;
      }
      if (k === "Enter" && mod) {
        handled();
        void s.continueInChat();
        return;
      }
      if (k === "Enter" && !e.shiftKey && !e.altKey) {
        handled();
        const q = s.view.query.trim();
        if (q) s.followUp(q);
        else if (s.props.replaces && s.answer && !s.streaming) void s.paste();
        return;
      }
      if (mod && e.shiftKey && k.toLowerCase() === "v") {
        handled();
        void s.paste();
        return;
      }
      if (mod && !e.shiftKey && k.toLowerCase() === "c") {
        const input = document.activeElement as HTMLInputElement | null;
        const hasInputSel = !!input && typeof input.selectionStart === "number" && input.selectionStart !== input.selectionEnd;
        if (!hasInputSel && !window.getSelection()?.toString()) {
          handled();
          void s.copy();
        }
        return;
      }
      if (mod && k.toLowerCase() === "r") {
        handled();
        s.regenerate();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (hasKey === false) {
    return (
      <div className="ai-quick">
        <AddKeyState compact />
        <QuickFooter actions={actions} />
      </div>
    );
  }

  const shown = messages.filter((m, i) => m.content.trim() || i === messages.length - 1);
  return (
    <div className="ai-quick" data-testid="ai-quick">
      <div className="ai-quick__scroll" ref={scrollRef}>
        {props.title && <div className="ai-quick__title">{props.title}</div>}
        {props.notice && <div className="ai-quick__notice">{props.notice}</div>}
        {!shown.length && !error && <div className="ai-quick__empty">Type a question and press <Kbd keys="⏎" /></div>}
        {shown.map((m, i) =>
          m.role === "user" ? (
            // AI Commands carry the whole selection in the prompt; show the command title instead.
            props.title && i === 0 ? null : (
              <div key={i} className="ai-quick__q">
                {m.content}
              </div>
            )
          ) : (
            <div key={i} className="ai-quick__a" data-testid="ai-answer">
              {m.content ? <Markdown text={m.content} /> : streaming && <Thinking />}
            </div>
          ),
        )}
        {error && <ErrorNote message={error.message} kind={error.kind} />}
      </div>
      {panel && (
        <div className="ai-panel" role="menu">
          {actions.map((a, i) => (
            <div key={a.id} role="menuitem" className={`ai-panel__item ${i === panelIndex ? "ai-panel__item--on" : ""}`} onMouseMove={() => setPanelIndex(i)} onClick={() => (setPanel(false), a.run())}>
              <span>{a.title}</span>
              {a.shortcut && <Kbd keys={a.shortcut} />}
            </div>
          ))}
        </div>
      )}
      <QuickFooter actions={actions} streaming={streaming} />
    </div>
  );
}

function QuickFooter({ actions, streaming }: { actions: Action[]; streaming?: boolean }) {
  const primary = actions[0];
  return (
    <div className="ai-quick__footer">
      <span className="ai-quick__brand">{streaming ? "Generating…" : "Quick AI"}</span>
      <span className="ai-quick__hints">
        {streaming ? (
          <span>
            Stop <Kbd keys="esc" />
          </span>
        ) : (
          primary && (
            <span>
              {primary.title} <Kbd keys={primary.shortcut ?? "⏎"} />
            </span>
          )
        )}
        <span>
          Actions <Kbd keys="⌘K" />
        </span>
      </span>
    </div>
  );
}
