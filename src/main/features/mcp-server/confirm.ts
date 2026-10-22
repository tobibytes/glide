/**
 * Pending confirmations for state-changing MCP calls. Each request waits for the user's
 * Allow / Deny / Always in Glide (launcher view "mcp-server.confirm") and is denied when it
 * times out, when too many are already waiting, or when the server stops.
 */
export type Decision = "allow" | "deny" | "always";
export type Outcome = Decision | "timeout";

export interface PendingRequest {
  id: string;
  client: string;
  tool: string;
  toolTitle: string;
  /** Plain-English description of exactly what the call will do. */
  summary: string;
  createdAt: number;
  expiresAt: number;
}

export interface Confirmations {
  request(r: Omit<PendingRequest, "id" | "createdAt" | "expiresAt">): Promise<Outcome>;
  respond(id: string, decision: Decision): boolean;
  pending(): PendingRequest[];
  /** Deny everything still waiting (server stopped / disabled). */
  denyAll(): void;
}

export interface ConfirmDeps {
  timeoutMs(): number;
  onChange(list: PendingRequest[]): void;
  /** Called once per new request (show the launcher view, a notification). */
  onRequest?(r: PendingRequest): void;
  maxPending?: number;
  now?(): number;
}

export function createConfirmations(deps: ConfirmDeps): Confirmations {
  const now = deps.now ?? Date.now;
  const max = deps.maxPending ?? 5;
  const waiting = new Map<string, { req: PendingRequest; resolve(o: Outcome): void; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0;
  const list = () => [...waiting.values()].map((w) => w.req);
  const settle = (id: string, o: Outcome) => {
    const w = waiting.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    waiting.delete(id);
    w.resolve(o);
    deps.onChange(list());
    return true;
  };
  return {
    request(r) {
      if (waiting.size >= max) return Promise.resolve<Outcome>("deny");
      const t = now();
      const ms = Math.max(1000, deps.timeoutMs());
      const req: PendingRequest = { ...r, id: `req-${t.toString(36)}-${(++seq).toString(36)}`, createdAt: t, expiresAt: t + ms };
      return new Promise<Outcome>((resolve) => {
        const timer = setTimeout(() => settle(req.id, "timeout"), ms);
        waiting.set(req.id, { req, resolve, timer });
        deps.onChange(list());
        deps.onRequest?.(req);
      });
    },
    respond: (id, decision) => (decision === "allow" || decision === "deny" || decision === "always" ? settle(id, decision) : false),
    pending: list,
    denyAll() {
      for (const id of [...waiting.keys()]) settle(id, "deny");
    },
  };
}
