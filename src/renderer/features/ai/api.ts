/** Typed wrappers over window.glide.feature("ai", …) plus the streaming conversation hook. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type {
  AiCommandDef,
  AiErrorKind,
  AiSettings,
  AskRequest,
  AskStart,
  Chat,
  ChatMessage,
  ChatSummary,
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  KeyStatus,
  ModelInfo,
  TestResult,
} from "../../../main/features/ai/types";

export type { AiCommandDef, AiSettings, Chat, ChatMessage, ChatSummary, KeyStatus, ModelInfo, TestResult, AiErrorKind };

const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.glide.feature<T>("ai", method, ...args);

export const ai = {
  ask: (req: AskRequest) => call<AskStart>("ask", req),
  cancel: (requestId: string) => call<boolean>("cancel", requestId),
  listChats: () => call<ChatSummary[]>("listChats"),
  getChat: (id: string) => call<Chat | null>("getChat", id),
  saveChat: (chat: Partial<Chat> & { messages: ChatMessage[] }) => call<Chat>("saveChat", chat),
  deleteChat: (id: string) => call<boolean>("deleteChat", id),
  getSettings: () => call<AiSettings>("getSettings"),
  setSettings: (patch: Partial<AiSettings>) => call<AiSettings>("setSettings", patch),
  listModels: () => call<ModelInfo[]>("listModels"),
  listCommands: () => call<AiCommandDef[]>("listCommands"),
  hasApiKey: () => call<KeyStatus>("hasApiKey"),
  setApiKey: (key: string) => call<KeyStatus>("setApiKey", key),
  clearApiKey: () => call<KeyStatus>("clearApiKey"),
  testConnection: (model?: string) => call<TestResult>("testConnection", model),
  openChatWindow: (opts: { chatId?: string; prompt?: string; messages?: ChatMessage[]; title?: string } = {}) => call<{ ok: boolean; chatId?: string }>("openChatWindow", opts),
  takePending: () => call<{ chatId?: string; prompt?: string } | null>("takePending"),
  getSelection: () => call<{ text: string; source: "selection" | "clipboard" | "none" }>("getSelection"),
  copy: (text: string) => call<boolean>("copy", text),
  pasteText: (text: string) => call<ExecuteResult>("pasteText", text),
  openUrl: (url: string) => call<boolean>("openUrl", url),
};

/** Settings page id registered by this feature (settings sidebar uses feature ids). */
export const SETTINGS_PAGE = "ai";

export function newRequestId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface ConversationError {
  message: string;
  kind: AiErrorKind;
}

interface Options {
  model?: string;
  system?: string;
  /** Called when an answer finishes (not on error), with the full transcript. */
  onDone?(messages: ChatMessage[]): void;
}

/** Streams answers into a message list. One in-flight request per conversation. */
export function useConversation(opts: Options = {}) {
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<ConversationError | null>(null);
  const reqRef = useRef<string | null>(null);
  const msgsRef = useRef<ChatMessage[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const setMessages = useCallback((next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    const value = typeof next === "function" ? next(msgsRef.current) : next;
    msgsRef.current = value;
    setMessagesState(value);
  }, []);

  useEffect(
    () =>
      window.glide.onFeatureEvent((e) => {
        if (e.feature !== "ai") return;
        const p = e.payload as { requestId?: string } | undefined;
        if (!p?.requestId || p.requestId !== reqRef.current) return;
        if (e.event === "delta") {
          const { text } = p as DeltaEvent;
          setMessages((ms) => {
            const last = ms[ms.length - 1];
            if (!last || last.role !== "assistant") return [...ms, { role: "assistant", content: text, at: Date.now() }];
            return [...ms.slice(0, -1), { ...last, content: last.content + text }];
          });
        } else if (e.event === "done") {
          const d = p as DoneEvent;
          reqRef.current = null;
          setStreaming(false);
          setMessages((ms) => {
            const last = ms[ms.length - 1];
            if (last?.role === "assistant" && !last.content.trim()) return ms.slice(0, -1);
            if (last?.role === "assistant") return [...ms.slice(0, -1), { ...last, model: d.model }];
            return ms;
          });
          optsRef.current.onDone?.(msgsRef.current);
        } else if (e.event === "error") {
          const err = p as ErrorEvent;
          reqRef.current = null;
          setStreaming(false);
          setError({ message: err.message, kind: err.kind });
          setMessages((ms) => {
            const last = ms[ms.length - 1];
            return last?.role === "assistant" && !last.content.trim() ? ms.slice(0, -1) : ms;
          });
        }
      }),
    [setMessages],
  );

  /** Send `history` (ending in a user message) and stream the reply after it. */
  const send = useCallback(
    async (history: ChatMessage[], model?: string) => {
      if (reqRef.current) await ai.cancel(reqRef.current);
      const requestId = newRequestId();
      reqRef.current = requestId;
      setError(null);
      setMessages([...history, { role: "assistant", content: "", at: Date.now() }]);
      setStreaming(true);
      try {
        const res = await ai.ask({ requestId, messages: history, model: model ?? optsRef.current.model, system: optsRef.current.system });
        if (!res.ok && reqRef.current === requestId) {
          reqRef.current = null;
          setStreaming(false);
          setError({ message: res.error ?? "Request failed", kind: res.errorKind ?? "other" });
          setMessages(history);
        }
      } catch (err) {
        reqRef.current = null;
        setStreaming(false);
        setError({ message: err instanceof Error ? err.message : String(err), kind: "other" });
        setMessages(history);
      }
    },
    [setMessages],
  );

  const stop = useCallback(() => {
    if (reqRef.current) void ai.cancel(reqRef.current);
  }, []);

  // Cancel an in-flight request when the view/window goes away.
  useEffect(() => () => stop(), [stop]);

  return { messages, setMessages, streaming, error, setError, send, stop };
}

export function lastAnswer(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant" && messages[i].content.trim()) return messages[i].content;
  return "";
}
