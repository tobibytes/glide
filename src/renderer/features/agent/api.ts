/** Typed wrappers over window.glide.feature("agent", …) and the live-run hook. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSettings, AgentStatus, RunSnapshot, StartResult, ToolInfo } from "../../../main/features/agent/types";

export type { AgentSettings, AgentStatus, AgentStep, RunSnapshot, ToolInfo, TranscriptEntry } from "../../../main/features/agent/types";

const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.glide.feature<T>("agent", method, ...args);

export const agent = {
  start: (runId: string, prompt: string) => call<StartResult>("start", { runId, prompt }),
  respond: (runId: string, confirmationId: string, approve: boolean) => call<boolean>("respond", runId, confirmationId, approve),
  cancel: (runId: string) => call<boolean>("cancel", runId),
  getRun: (runId: string) => call<RunSnapshot | null>("getRun", runId),
  activeRun: () => call<RunSnapshot | null>("activeRun"),
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

/** Follows one run's snapshots (pushed from main as the "run" event). */
export function useAgentRun() {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [startError, setStartError] = useState<StartError | null>(null);
  const idRef = useRef<string | null>(null);

  useEffect(
    () =>
      window.glide.onFeatureEvent((e) => {
        if (e.feature !== "agent" || e.event !== "run") return;
        const snap = e.payload as RunSnapshot | undefined;
        if (snap && snap.runId === idRef.current) setRun(snap);
      }),
    [],
  );

  const attach = useCallback(async (runId: string) => {
    idRef.current = runId;
    const snap = await agent.getRun(runId);
    if (snap && idRef.current === runId) setRun(snap);
    return !!snap;
  }, []);

  const start = useCallback(async (prompt: string) => {
    const runId = newRunId();
    idRef.current = runId;
    setStartError(null);
    setRun({ runId, prompt, status: "running", entries: [{ kind: "prompt", id: "p", text: prompt }], toolCalls: 0, maxToolCalls: 12, model: "", startedAt: Date.now() });
    try {
      const res = await agent.start(runId, prompt);
      if (!res.ok) {
        idRef.current = null;
        setRun(null);
        setStartError({ message: res.error ?? "Could not start", kind: res.errorKind ?? "other" });
      }
    } catch (err) {
      idRef.current = null;
      setRun(null);
      setStartError({ message: err instanceof Error ? err.message : String(err), kind: "other" });
    }
  }, []);

  return { run, startError, start, attach };
}
