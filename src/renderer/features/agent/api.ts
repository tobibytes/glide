/** Typed wrappers over window.glide.feature("agent", …) and the live-conversation hook. */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentSettings, AgentStatus, ConversationSummary, ConversationView, RunSnapshot, SaveWorkflowResult, StartResult, ToolInfo, UndoResult,
} from "../../../main/features/agent/types";

export type {
  AgentSettings, AgentStatus, AgentStep, ConversationSummary, ConversationView, PlanItem, RunSnapshot, ToolInfo, TranscriptEntry,
} from "../../../main/features/agent/types";

const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.glide.feature<T>("agent", method, ...args);

export const agent = {
  start: (runId: string, prompt: string, conversationId?: string) => call<StartResult>("start", { runId, prompt, conversationId }),
  respond: (runId: string, confirmationId: string, approve: boolean) => call<boolean>("respond", runId, confirmationId, approve),
  cancel: (runId: string) => call<boolean>("cancel", runId),
  getRun: (runId: string) => call<RunSnapshot | null>("getRun", runId),
  activeRun: () => call<RunSnapshot | null>("activeRun"),
  getConversation: (id: string) => call<ConversationView | null>("getConversation", id),
  latestConversation: () => call<ConversationView | null>("latestConversation"),
  listConversations: (query: string) => call<ConversationSummary[]>("listConversations", query),
  deleteConversation: (id: string) => call<boolean>("deleteConversation", id),
  clearHistory: () => call<number>("clearHistory"),
  undo: (runId: string, stepId?: string) => call<UndoResult>("undo", runId, stepId),
  saveAsWorkflow: (runId: string, name?: string) => call<SaveWorkflowResult>("saveAsWorkflow", runId, name),
  openFromLauncher: (query: string) => call<boolean>("openFromLauncher", query),
  status: () => call<AgentStatus>("status"),
  getSettings: () => call<AgentSettings>("getSettings"),
  setSettings: (patch: Partial<AgentSettings>) => call<AgentSettings>("setSettings", patch),
  listTools: () => call<ToolInfo[]>("listTools"),
  openAiSettings: () => call<void>("openAiSettings"),
};

export function newRunId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface StartError {
  message: string;
  kind: string;
}

interface ConvState {
  id: string | null;
  title: string;
  runs: RunSnapshot[];
}

const EMPTY: ConvState = { id: null, title: "", runs: [] };

function upsert(runs: RunSnapshot[], snap: RunSnapshot): RunSnapshot[] {
  const i = runs.findIndex((r) => r.runId === snap.runId);
  if (i < 0) return [...runs, snap];
  const next = runs.slice();
  next[i] = snap;
  return next;
}

/** Follows one conversation: its runs' snapshots are pushed from main as the "run" event. */
export function useConversation() {
  const [conv, setConv] = useState<ConvState>(EMPTY);
  const [startError, setStartError] = useState<StartError | null>(null);
  const idRef = useRef<string | null>(null);
  const runIds = useRef(new Set<string>());

  useEffect(
    () =>
      window.glide.onFeatureEvent((e) => {
        if (e.feature !== "agent" || e.event !== "run") return;
        const snap = e.payload as RunSnapshot | undefined;
        if (!snap) return;
        const mine = runIds.current.has(snap.runId) || (!!snap.conversationId && snap.conversationId === idRef.current);
        if (!mine) return;
        runIds.current.add(snap.runId);
        if (snap.conversationId && !idRef.current) idRef.current = snap.conversationId;
        setConv((c) => ({ ...c, id: idRef.current, runs: upsert(c.runs, snap) }));
      }),
    [],
  );

  const show = useCallback((v: ConversationView | null) => {
    if (!v) return false;
    idRef.current = v.id;
    runIds.current = new Set(v.runs.map((r) => r.runId));
    setConv({ id: v.id, title: v.title, runs: v.runs });
    return true;
  }, []);

  const load = useCallback(async (id: string) => show(await agent.getConversation(id)), [show]);

  const attach = useCallback(
    async (runId: string) => {
      const snap = await agent.getRun(runId);
      if (!snap) return false;
      if (snap.conversationId && (await load(snap.conversationId))) return true;
      runIds.current = new Set([runId]);
      idRef.current = snap.conversationId ?? null;
      setConv({ id: idRef.current, title: snap.prompt, runs: [snap] });
      return true;
    },
    [load],
  );

  const reset = useCallback(() => {
    idRef.current = null;
    runIds.current = new Set();
    setStartError(null);
    setConv(EMPTY);
  }, []);

  const start = useCallback(async (prompt: string) => {
    const runId = newRunId();
    runIds.current.add(runId);
    setStartError(null);
    const optimistic: RunSnapshot = { runId, conversationId: idRef.current ?? undefined, prompt, status: "running", entries: [{ kind: "prompt", id: `${runId}-p`, text: prompt }], toolCalls: 0, maxToolCalls: 12, model: "", startedAt: Date.now() };
    setConv((c) => ({ ...c, title: c.title || prompt, runs: upsert(c.runs, optimistic) }));
    const drop = (message: string, kind: string) => {
      runIds.current.delete(runId);
      setConv((c) => ({ ...c, runs: c.runs.filter((r) => r.runId !== runId) }));
      setStartError({ message, kind });
    };
    try {
      const res = await agent.start(runId, prompt, idRef.current ?? undefined);
      if (!res.ok) return drop(res.error ?? "Could not start", res.errorKind ?? "other");
      if (res.conversationId) {
        idRef.current = res.conversationId;
        setConv((c) => ({ ...c, id: res.conversationId ?? null }));
      }
    } catch (err) {
      drop(err instanceof Error ? err.message : String(err), "other");
    }
  }, []);

  return { conv, startError, start, attach, load, show, reset };
}
