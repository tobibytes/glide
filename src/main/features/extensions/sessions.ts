/**
 * One extension process per running command. Spawning is injected (Electron utilityProcess in the
 * app, child_process.fork in tests) so this module has no Electron dependency.
 */
import type { ChildMessage, InitPayload, JsonValue, ParentMessage, RequestMethod, ViewModel } from "../../../extension-api/types";

export interface ChildHandle {
  postMessage(msg: ParentMessage): void;
  onMessage(cb: (msg: ChildMessage) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface SessionInfo {
  id: string;
  extName: string;
  extTitle: string;
  commandName: string;
  commandTitle: string;
  mode: "view" | "no-view";
  /** "raycast" sessions run React components through the Raycast compatibility runtime. */
  runtime?: "glide" | "raycast";
}

export interface AlertRequest {
  id: string;
  title: string;
  message?: string;
  primaryTitle: string;
  dismissTitle: string;
  destructive: boolean;
}

export interface SessionEvent {
  sessionId: string;
  depth?: number;
  view?: ViewModel;
  kind?: "render" | "push" | "pop" | "toast" | "ended" | "alert" | "popToRoot" | "clearSearch";
  toast?: { style: string; title: string; message?: string; id?: string };
  alert?: AlertRequest;
}

export interface SessionDeps {
  spawn(info: SessionInfo): ChildHandle;
  onRequest(session: SessionInfo, method: RequestMethod, params: JsonValue[]): Promise<JsonValue | void>;
  emit(event: SessionEvent): void;
  log(...args: unknown[]): void;
  /** Idle limit in ms (no view mounted and no traffic). */
  idleMs?: number;
  /** Delay between the root view closing and the kill (a remount cancels it). */
  closeGraceMs?: number;
}

export interface Completion {
  ok: boolean;
  error?: string;
}

interface Session {
  info: SessionInfo;
  child: ChildHandle;
  views: ViewModel[];
  mounted: Set<number>;
  lastActivity: number;
  alive: boolean;
  done: boolean;
  completion: Promise<Completion>;
  complete(c: Completion): void;
  closeTimer?: ReturnType<typeof setTimeout>;
}

let seq = 0;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;
  private readonly graceMs: number;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: SessionDeps) {
    this.idleMs = deps.idleMs ?? 30_000;
    this.graceMs = deps.closeGraceMs ?? 1_500;
  }

  start(meta: Omit<SessionInfo, "id">, init: InitPayload): SessionInfo {
    const info: SessionInfo = { ...meta, id: `s${Date.now().toString(36)}${++seq}` };
    let complete!: (c: Completion) => void;
    const completion = new Promise<Completion>((r) => (complete = r));
    const child = this.deps.spawn(info);
    const session: Session = { info, child, views: [], mounted: new Set(), lastActivity: Date.now(), alive: true, done: false, completion, complete };
    this.sessions.set(info.id, session);
    child.onMessage((msg) => this.onChildMessage(session, msg));
    child.onExit((code) => {
      session.alive = false;
      session.complete({ ok: code === 0 || session.done, error: session.done ? undefined : `Extension process exited (code ${code ?? "?"})` });
      this.sessions.delete(info.id);
      this.deps.emit({ sessionId: info.id, kind: "ended" });
    });
    child.postMessage({ type: "init", init });
    this.ensureSweeper();
    return info;
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  view(id: string, depth: number): ViewModel | undefined {
    return this.sessions.get(id)?.views[depth];
  }

  /** Resolves when the command function returns or throws (no-view commands), or the process dies. */
  completion(id: string): Promise<Completion> {
    return this.sessions.get(id)?.completion ?? Promise.resolve({ ok: false, error: "Not running" });
  }

  invoke(id: string, depth: number, handler: string, args: JsonValue[]): boolean {
    const s = this.sessions.get(id);
    if (!s?.alive) return false;
    s.lastActivity = Date.now();
    s.child.postMessage({ type: "invoke", depth, handler, args });
    return true;
  }

  /**
   * The launcher renders only its top view, so a view unmounts both when it is popped and when
   * another view is pushed over it. Mounting depth d therefore also means everything deeper was popped.
   */
  mountView(id: string, depth: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.mounted.add(depth);
    s.lastActivity = Date.now();
    if (s.closeTimer) clearTimeout(s.closeTimer);
    s.closeTimer = undefined;
    for (const d of Array.from(s.mounted)) if (d > depth) s.mounted.delete(d);
    if (s.views.length > depth + 1) {
      s.views.length = depth + 1;
      if (s.alive) s.child.postMessage({ type: "closeView", depth: depth + 1 });
    }
  }

  /** A view left the screen; with none left the process is stopped after a short grace period. */
  unmountView(id: string, depth: number) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.mounted.delete(depth);
    s.lastActivity = Date.now();
    if (s.mounted.size) return;
    if (s.closeTimer) clearTimeout(s.closeTimer);
    s.closeTimer = setTimeout(() => {
      if (!s.mounted.size) this.kill(id);
    }, this.graceMs);
  }

  kill(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (s.closeTimer) clearTimeout(s.closeTimer);
    s.complete({ ok: s.done, error: s.done ? undefined : "Stopped" });
    if (s.alive) {
      s.alive = false;
      try {
        s.child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  killAll() {
    for (const id of Array.from(this.sessions.keys())) this.kill(id);
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  running(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  private ensureSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), Math.min(5_000, this.idleMs));
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** Kill sessions with no mounted view and no traffic for idleMs. */
  sweep(now = Date.now()) {
    for (const s of Array.from(this.sessions.values())) {
      if (s.mounted.size === 0 && now - s.lastActivity > this.idleMs) {
        this.deps.log(`stopping idle ${s.info.extName}/${s.info.commandName}`);
        this.kill(s.info.id);
      }
    }
    if (!this.sessions.size && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  private setView(s: Session, depth: number, view: ViewModel, kind: "render" | "push") {
    s.views[depth] = view;
    this.deps.emit({ sessionId: s.info.id, depth, view, kind });
  }

  private onChildMessage(s: Session, msg: ChildMessage) {
    // Renders alone (e.g. a ticking clock) do not count as activity, so an unseen view still idles out.
    if (msg.type !== "render") s.lastActivity = Date.now();
    switch (msg.type) {
      case "render":
        if (s.info.mode === "no-view") return this.deps.log(`${s.info.extName}/${s.info.commandName}: render() ignored in a no-view command`);
        if (msg.depth > 0 && !s.views[msg.depth]) return; // render for a view that was already popped
        return this.setView(s, msg.depth, msg.view, "render");
      case "push":
        if (msg.depth > s.views.length) return; // its parent was popped meanwhile
        s.views.length = msg.depth;
        return this.setView(s, msg.depth, msg.view, "push");
      case "pop":
        return this.deps.emit({ sessionId: s.info.id, depth: msg.depth, kind: "pop" });
      case "request":
        void this.deps
          .onRequest(s.info, msg.method, msg.params)
          .then(
            (result) => ({ type: "response" as const, id: msg.id, result: result ?? null }),
            (err: unknown) => ({ type: "response" as const, id: msg.id, error: err instanceof Error ? err.message : String(err) }),
          )
          .then((res) => {
            if (s.alive) s.child.postMessage(res);
          });
        return;
      case "done":
        s.done = true;
        s.complete({ ok: true });
        if (s.info.mode === "no-view" || !s.views[0]) {
          // Nothing left to show: a view command that never rendered just ends.
          if (s.info.mode === "view") this.deps.emit({ sessionId: s.info.id, kind: "ended" });
          this.kill(s.info.id);
        }
        return;
      case "error": {
        this.deps.log(`${s.info.extName}/${s.info.commandName} error:`, msg.stack ?? msg.message);
        if (s.info.mode === "no-view") {
          s.complete({ ok: false, error: msg.message });
          this.kill(s.info.id);
        } else if (!s.views[0]) {
          this.setView(s, 0, errorView(s.info, msg.message, msg.stack), "render");
          s.complete({ ok: false, error: msg.message });
        } else this.deps.emit({ sessionId: s.info.id, kind: "toast", toast: { style: "failure", title: msg.message } });
        return;
      }
      case "log":
        return this.deps.log(`${s.info.extName}:`, msg.text);
    }
  }
}

export function errorView(info: SessionInfo, message: string, stack?: string): ViewModel {
  const trace = stack ? `\n\n\`\`\`\n${stack.split("\n").slice(0, 12).join("\n")}\n\`\`\`` : "";
  return {
    type: "detail",
    title: "Extension error",
    markdown: `# ${info.commandTitle} failed\n\n${message}${trace}`,
    metadata: [
      { label: "Extension", text: info.extTitle },
      { label: "Command", text: info.commandName },
    ],
    actions: [],
    isLoading: false,
  };
}
