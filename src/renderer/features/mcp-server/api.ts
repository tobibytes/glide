import { useCallback, useEffect, useState } from "react";
import { glide } from "../../lib/glide";
import type { McpServerState } from "../../../main/features/mcp-server/index";
import type { PendingRequest } from "../../../main/features/mcp-server/confirm";
import type { LogEntry } from "../../../main/features/mcp-server/requestlog";
import type { Snippet } from "../../../main/features/mcp-server/snippets";

export type { LogEntry, McpServerState, PendingRequest, Snippet };

export const ID = "mcp-server";
export const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>(ID, method, ...args);

export const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

/** Live server state; refreshes on the feature's state/pending events. */
export function useMcpState(): [McpServerState | null, () => void] {
  const [st, setSt] = useState<McpServerState | null>(null);
  const refresh = useCallback(() => void call<McpServerState>("state").then(setSt, () => undefined), []);
  useEffect(() => {
    refresh();
    return glide().onFeatureEvent((e) => {
      if (e.feature === ID && (e.event === "state" || e.event === "pending")) refresh();
    });
  }, [refresh]);
  return [st, refresh];
}

export function usePending(): PendingRequest[] | null {
  const [list, setList] = useState<PendingRequest[] | null>(null);
  useEffect(() => {
    void call<PendingRequest[]>("pending").then(setList, () => setList([]));
    return glide().onFeatureEvent((e) => {
      if (e.feature === ID && e.event === "pending" && Array.isArray(e.payload)) setList(e.payload as PendingRequest[]);
    });
  }, []);
  return list;
}

export function useLog(): [LogEntry[], () => void] {
  const [log, setLog] = useState<LogEntry[]>([]);
  const refresh = useCallback(() => void call<LogEntry[]>("log").then(setLog, () => undefined), []);
  useEffect(() => {
    refresh();
    return glide().onFeatureEvent((e) => {
      if (e.feature === ID && e.event === "log") refresh();
    });
  }, [refresh]);
  return [log, refresh];
}
