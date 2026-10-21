/**
 * Launcher view "agent.run": a conversation with Glide Agent. The launcher search field is the
 * request input (⏎ sends a follow-up that keeps the conversation's context); the transcript of
 * every request (prompt, plan, Claude's text, each tool call with status, the summary) is a
 * NavList so j/k/⌃J/⌃K/gg/G and ⌘K work.
 * Keys (window capture listener, so they win over the launcher's own handlers):
 *   confirmation pending: ⏎ run · ⌘⏎ run & don't ask again · esc cancel
 *   running: esc stop
 *   otherwise: ⌘N new conversation · ⌘Y history · ⌘Z undo the last request · ⌘S save it as a workflow
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "../../components/Kbd";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { agent, useConversation, type AgentStatus, type AgentStep, type RunSnapshot, type TranscriptEntry } from "./api";

type Row = NavItem & { entry: TranscriptEntry; run: RunSnapshot };

export const STATUS_ICON: Record<AgentStep["status"], string> = {
  queued: "○",
  awaiting: "?",
  running: "◌",
  ok: "✓",
  error: "✕",
  declined: "⊘",
  skipped: "–",
};

interface Props {
  prompt?: string;
  runId?: string;
  conversationId?: string;
  fresh?: boolean;
}

function readProps(p: Record<string, unknown>): Props {
  return {
    prompt: typeof p.prompt === "string" && p.prompt.trim() ? p.prompt : undefined,
    runId: typeof p.runId === "string" ? p.runId : undefined,
    conversationId: typeof p.conversationId === "string" ? p.conversationId : undefined,
    fresh: p.fresh === true,
  };
}

function argsText(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (!keys.length) return "";
  return keys.map((k) => `${k}: ${typeof args[k] === "string" ? (args[k] as string) : JSON.stringify(args[k])}`).join(" · ");
}

const stepsOf = (run: RunSnapshot): AgentStep[] => run.entries.flatMap((e) => (e.kind === "step" ? [e.step] : []));
const undoableOf = (run: RunSnapshot) => stepsOf(run).filter((s) => s.undo?.state === "available").length;
const isBusy = (run: RunSnapshot | undefined) => run?.status === "running" || run?.status === "confirming";

const PLACEHOLDER_IDLE = "What should Glide do? e.g. put Safari left and Notes right, start a 25 min timer";

export function AgentView(view: ViewProps) {
  const props = readProps(view.props);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const { conv, startError, start, attach, load, show, reset } = useConversation();
  const started = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void agent.status().then(setStatus);
  }, []);

  // Start the prompt we were opened with, resume a conversation, or re-attach to a run.
  useEffect(() => {
    if (!status || started.current) return;
    started.current = true;
    void (async () => {
      if (props.runId && (await attach(props.runId))) return;
      if (props.conversationId && (await load(props.conversationId))) {
        if (props.prompt && status.hasKey) await start(props.prompt);
        return;
      }
      if (props.prompt) {
        if (status.hasKey) await start(props.prompt);
        return;
      }
      const active = await agent.activeRun();
      if (active && (await attach(active.runId))) return;
      // Reopening the agent keeps this session's conversation (⌘N starts a new one).
      if (!props.fresh) show(await agent.latestConversation());
    })();
  }, [status, props.runId, props.prompt, props.conversationId, props.fresh, attach, load, show, start]);

  const last = conv.runs.at(-1);
  const busy = isBusy(last);
  const confirming = last?.status === "confirming" ? last.confirmation : undefined;

  useEffect(() => {
    view.setPlaceholder(confirming ? "Press ⏎ to run these actions, esc to cancel" : busy ? "Working… (esc to stop)" : conv.runs.length ? "Follow up, or ⌘N for a new conversation…" : PLACEHOLDER_IDLE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, busy, conv.runs.length]);

  const pendingSteps = useMemo(() => (confirming && last ? stepsOf(last).filter((s) => confirming.stepIds.includes(s.id)) : []), [confirming, last]);

  const submit = useCallback(
    (text: string) => {
      view.setQuery("");
      void start(text);
    },
    [start, view],
  );

  const answer = useCallback(
    async (approve: boolean, always = false) => {
      if (!last?.confirmation) return;
      if (approve && always) {
        const s = await agent.getSettings();
        const allow = { ...s.allow };
        for (const st of pendingSteps) allow[st.tool] = true;
        const saved = await agent.setSettings({ allow });
        const skipped = pendingSteps.filter((st) => !saved.allow[st.tool]).map((st) => st.title);
        view.toast(skipped.length ? `${[...new Set(skipped)].join(", ")} will always ask` : `Won't ask again for ${[...new Set(pendingSteps.map((st) => st.title))].join(", ")}`);
      }
      await agent.respond(last.runId, last.confirmation.id, approve);
    },
    [last, pendingSteps, view],
  );

  const newConversation = useCallback(() => {
    if (busy && last) void agent.cancel(last.runId);
    reset();
    view.setQuery("");
    view.toast("New conversation");
  }, [busy, last, reset, view]);

  const undoRun = useCallback(
    async (run: RunSnapshot | undefined, stepId?: string) => {
      const target = run ?? [...conv.runs].reverse().find((r) => undoableOf(r) > 0);
      if (!target) return view.toast("Nothing to undo");
      const r = await agent.undo(target.runId, stepId);
      view.toast(r.message, r.ok ? "info" : "error");
    },
    [conv.runs, view],
  );

  const saveWorkflow = useCallback(
    async (run: RunSnapshot | undefined) => {
      const target = run ?? [...conv.runs].reverse().find((r) => r.status === "done");
      if (!target) return view.toast("Nothing to save yet");
      const name = view.query.trim();
      const r = await agent.saveAsWorkflow(target.runId, name || undefined);
      if (r.ok) {
        if (name) view.setQuery("");
        view.toast(`Saved workflow “${r.name}” (${r.actions} action${r.actions === 1 ? "" : "s"})`);
      } else view.toast(r.error ?? "Couldn't save", "error");
    },
    [conv.runs, view],
  );

  const openHistory = useCallback(() => view.push({ id: "agent.history" }), [view]);

  const live = useRef({ last, confirming, busy, status, view, submit, answer, newConversation, undoRun, saveWorkflow, openHistory });
  live.current = { last, confirming, busy, status, view, submit, answer, newConversation, undoRun, saveWorkflow, openHistory };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.isComposing) return;
      // Ignore keys while the ⌘K panel or another dialog is open.
      if (document.querySelector(".actions[role='dialog']")) return;
      if (s.confirming) {
        if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
          handled();
          void s.answer(true, e.metaKey);
        } else if (e.key === "Escape") {
          handled();
          void s.answer(false);
        }
        return;
      }
      if (s.busy) {
        if (e.key === "Escape") {
          handled();
          if (s.last) void agent.cancel(s.last.runId);
        } else if (e.key === "Enter" && s.view.query.trim()) {
          handled();
          s.view.toast("Glide Agent is still working — press esc to stop it first");
        }
        return;
      }
      if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === "n") return handled(), s.newConversation();
        if (k === "y") return handled(), s.openHistory();
        if (k === "s") return handled(), void s.saveWorkflow(undefined);
        if (k === "z" && !s.view.query) return handled(), void s.undoRun(undefined);
      }
      if (s.status && !s.status.hasKey && e.key === "Enter") {
        handled();
        void agent.openAiSettings();
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.shiftKey && !e.altKey && s.view.query.trim()) {
        handled();
        s.submit(s.view.query.trim());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Keep the newest entry in view while the run is going.
  const count = conv.runs.reduce((n, r) => n + r.entries.length, 0);
  const lastEntry = last?.entries.at(-1);
  const lastLen = lastEntry?.kind === "text" ? lastEntry.text.length : 0;
  useEffect(() => {
    if (!busy) return;
    const list = rootRef.current?.querySelector(".navlist__items");
    if (list) list.scrollTop = list.scrollHeight;
  }, [busy, count, lastLen]);

  const rows: Row[] = useMemo(() => conv.runs.flatMap((run) => run.entries.map((entry) => ({ id: `${run.runId}:${entry.id}`, entry, run }))), [conv.runs]);

  const rowActions = useCallback(
    (row: Row): NavAction[] => {
      const list: NavAction[] = [];
      const e = row.entry;
      const text = e.kind === "step" ? (e.step.result ?? "") : e.kind === "plan" ? e.items.map((i) => i.text).join("\n") : e.text;
      if (text) list.push({ id: "copy", title: e.kind === "step" ? "Copy Result" : "Copy Text", shortcut: "⌘C", icon: "📋", run: () => void navigator.clipboard.writeText(text).then(() => view.toast("Copied")) });
      if (e.kind === "step" && e.step.undo?.state === "available") {
        const st = e.step;
        list.push({ id: "undo-step", title: `Undo: ${st.undo!.summary}`, icon: "↶", run: () => void undoRun(row.run, st.id) });
      }
      if (!isBusy(row.run) && undoableOf(row.run) > 0) list.push({ id: "undo", title: "Undo This Request", shortcut: "⌘Z", icon: "↶", run: () => void undoRun(row.run) });
      if (row.run.status === "done") list.push({ id: "save", title: "Save as Workflow", shortcut: "⌘S", icon: "💾", run: () => void saveWorkflow(row.run) });
      if (e.kind === "step" && e.step.mutating) {
        const st = e.step;
        list.push({
          id: "allow",
          title: `Always Allow “${st.title}”`,
          icon: "✅",
          run: async () => {
            const s = await agent.getSettings();
            const saved = await agent.setSettings({ allow: { ...s.allow, [st.tool]: true } });
            view.toast(saved.allow[st.tool] ? `“${st.title}” will run without asking` : `“${st.title}” always asks`);
          },
        });
      }
      if (busy && last) list.push({ id: "stop", title: "Stop Agent", shortcut: "esc", icon: "■", destructive: true, run: () => void agent.cancel(last.runId) });
      list.push({ id: "new", title: "New Conversation", shortcut: "⌘N", icon: "✚", run: () => newConversation() });
      list.push({ id: "history", title: "Conversation History", shortcut: "⌘Y", icon: "🕘", run: () => openHistory() });
      list.push({ id: "settings", title: "Agent Settings…", icon: "⚙️", run: () => window.glide.openSettings("agent") });
      return list;
    },
    [busy, last, view, undoRun, saveWorkflow, newConversation, openHistory],
  );

  if (status && !status.hasKey) {
    return (
      <div className="agent agent--empty" data-testid="agent-nokey">
        <div className="agent__hero">🔑</div>
        <div className="agent__title">Glide Agent needs your Anthropic API key</div>
        <p className="agent__text">Add it in Settings → AI. The agent uses the same key and model as Glide AI.</p>
        <button type="button" className="agent__btn" onClick={() => void agent.openAiSettings()}>
          Open Settings → AI <Kbd keys="⏎" />
        </button>
      </div>
    );
  }

  return (
    <div className="agent" ref={rootRef} data-testid="agent-view" data-status={last?.status ?? "idle"} data-conversation={conv.id ?? ""} data-runs={conv.runs.length}>
      {!conv.runs.length && !startError && <Intro readOnly={!!status?.readOnly} />}
      {startError && (
        <div className="agent__error" role="alert" data-testid="agent-start-error">
          <span>{startError.message}</span>
          {(startError.kind === "no-key" || startError.kind === "auth") && (
            <button type="button" className="agent__btn" onClick={() => void agent.openAiSettings()}>
              Settings → AI
            </button>
          )}
        </div>
      )}
      {conv.runs.length > 0 && (
        <NavList<Row>
          className="agent__list"
          items={rows}
          renderItem={(row, selected) => <EntryRow entry={row.entry} run={row.run} selected={selected} />}
          onActivate={(row) => {
            const e = row.entry;
            const text = e.kind === "step" ? (e.step.result ?? "") : e.kind === "plan" ? "" : e.text;
            if (text) void navigator.clipboard.writeText(text).then(() => view.toast("Copied"));
          }}
          actions={rowActions}
          actionsTitle="Glide Agent"
        />
      )}
      {confirming && <ConfirmCard steps={pendingSteps} />}
      {last && <StatusBar run={last} turns={conv.runs.length} undoable={conv.runs.reduce((n, r) => n + undoableOf(r), 0)} />}
    </div>
  );
}

function Intro({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="agent__intro" data-testid="agent-intro">
      <div className="agent__hero">🪄</div>
      <div className="agent__title">Tell Glide what to do</div>
      <ul className="agent__examples">
        <li>Put Safari on the left and Notes on the right</li>
        <li>Start a 25 minute focus timer and open my standup notes</li>
        <li>What's using the most CPU right now?</li>
      </ul>
      <p className="agent__text">
        Type a request and press <Kbd keys="⏎" />. Follow-ups keep the context. Glide asks before doing anything that changes your Mac, and <Kbd keys="⌘Z" /> puts back what it can.
      </p>
      {readOnly && <p className="agent__text agent__readonly">Read-only mode is on: the agent can only look things up.</p>}
      <div className="agent__keys">
        <span>
          New <Kbd keys="⌘N" />
        </span>
        <span>
          History <Kbd keys="⌘Y" />
        </span>
      </div>
    </div>
  );
}

function PlanRow({ entry, run, cls }: { entry: Extract<TranscriptEntry, { kind: "plan" }>; run: RunSnapshot; cls: string }) {
  const byId = new Map(stepsOf(run).map((s) => [s.id, s]));
  const finished = !isBusy(run);
  return (
    <div className={`${cls} agent-row--plan`} data-testid="agent-plan">
      <span className="agent-row__icon">☰</span>
      <div className="agent-row__main">
        <div className="agent-row__plan-title">{entry.title}</div>
        <ol className="agent-plan">
          {entry.items.map((item, i) => {
            const st = item.stepId ? byId.get(item.stepId) : undefined;
            const status = st?.status;
            return (
              <li key={i} className={`agent-plan__item agent-plan__item--${status ?? (finished ? "none" : "queued")}`} data-status={status ?? "pending"}>
                <span className={`agent-status ${status ? `agent-status--${status}` : ""}`}>{status ? STATUS_ICON[status] : finished ? "·" : "○"}</span>
                <span>{item.text}</span>
                {st?.undo?.state === "done" && <span className="tag">undone</span>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function EntryRow({ entry, run, selected }: { entry: TranscriptEntry; run: RunSnapshot; selected: boolean }) {
  const cls = ["agent-row", `agent-row--${entry.kind}`, selected ? "agent-row--selected" : ""].filter(Boolean).join(" ");
  if (entry.kind === "prompt")
    return (
      <div className={cls}>
        <span className="agent-row__icon">›</span>
        <div className="agent-row__main agent-row__prompt">{entry.text}</div>
      </div>
    );
  if (entry.kind === "text")
    return (
      <div className={cls}>
        <span className="agent-row__icon">🪄</span>
        <div className="agent-row__main agent-row__text">{entry.text}</div>
      </div>
    );
  if (entry.kind === "notice")
    return (
      <div className={`${cls} agent-row--${entry.tone}`}>
        <span className="agent-row__icon">{entry.tone === "error" ? "⚠︎" : "ℹ︎"}</span>
        <div className="agent-row__main">{entry.text}</div>
      </div>
    );
  if (entry.kind === "plan") return <PlanRow entry={entry} run={run} cls={cls} />;
  if (entry.kind === "summary") {
    const undoable = undoableOf(run);
    return (
      <div className={cls} data-testid="agent-summary">
        <span className="agent-row__icon">∎</span>
        <div className="agent-row__main agent-row__summary-line">
          <span>{entry.text}</span>
          {undoable > 0 && (
            <span className="agent-row__hint">
              Undo {undoable} <Kbd keys="⌘Z" />
            </span>
          )}
          {entry.saveable && run.status === "done" && (
            <span className="agent-row__hint">
              Save as Workflow <Kbd keys="⌘S" />
            </span>
          )}
        </div>
      </div>
    );
  }
  const st = entry.step;
  const args = argsText(st.args);
  return (
    <div className={`${cls} agent-row--${st.status}`} data-testid="agent-step" data-tool={st.tool} data-status={st.status} data-undo={st.undo?.state ?? ""}>
      <span className={`agent-row__icon agent-status agent-status--${st.status}`} aria-label={st.status}>
        {STATUS_ICON[st.status]}
      </span>
      <div className="agent-row__main">
        <div className="agent-row__title">
          <span className="agent-row__tool">{st.title}</span>
          <span className="agent-row__summary">{st.summary}</span>
          {st.autoApproved && <span className="tag">allowed</span>}
          {st.undo?.state === "done" && <span className="tag">undone</span>}
          {st.undo?.state === "failed" && <span className="tag">undo failed</span>}
        </div>
        {selected && (
          <div className="agent-row__detail">
            <div>
              <span className="agent-row__label">tool</span> <code>{st.tool}</code>
              {args && (
                <>
                  {" "}
                  <span className="agent-row__label">args</span> <code>{args}</code>
                </>
              )}
            </div>
            {st.result && (
              <div className="agent-row__result">
                <span className="agent-row__label">result</span> {st.result.length > 600 ? `${st.result.slice(0, 600)}…` : st.result}
              </div>
            )}
            {st.undo && (
              <div>
                <span className="agent-row__label">undo</span> {st.undo.summary}
                {st.undo.error ? ` — ${st.undo.error}` : ""}
              </div>
            )}
          </div>
        )}
        {!selected && st.result && (st.status === "error" || st.status === "ok") && <div className="agent-row__brief">{st.result.split("\n")[0]?.slice(0, 140)}</div>}
      </div>
    </div>
  );
}

function ConfirmCard({ steps }: { steps: AgentStep[] }) {
  const always = steps.some((s) => s.tool === "kill_process" || s.tool === "run_shortcut");
  return (
    <div className="agent-confirm" role="alertdialog" aria-label="Confirm actions" data-testid="agent-confirm">
      <div className="agent-confirm__title">Glide Agent wants to:</div>
      <ol className="agent-confirm__list">
        {steps.map((s) => (
          <li key={s.id}>{s.summary}</li>
        ))}
      </ol>
      <div className="agent-confirm__keys">
        <span>
          Run <Kbd keys="⏎" />
        </span>
        {!always && (
          <span>
            Run &amp; don't ask again <Kbd keys="⌘⏎" />
          </span>
        )}
        <span>
          Cancel <Kbd keys="esc" />
        </span>
      </div>
    </div>
  );
}

function StatusBar({ run, turns, undoable }: { run: RunSnapshot; turns: number; undoable: number }) {
  const label =
    run.status === "running" ? "Working…" : run.status === "confirming" ? "Waiting for you" : run.status === "done" ? "Done" : run.status === "cancelled" ? "Stopped" : "Failed";
  return (
    <div className={`agent-bar agent-bar--${run.status}`} data-testid="agent-bar">
      <span className="agent-bar__state">{label}</span>
      <span>
        {run.toolCalls}/{run.maxToolCalls} tool calls
      </span>
      {turns > 1 && <span>{turns} requests</span>}
      {run.readOnly && <span className="tag">read-only</span>}
      {run.status === "running" ? (
        <span>
          Stop <Kbd keys="esc" />
        </span>
      ) : (
        <>
          {undoable > 0 && (
            <span>
              Undo <Kbd keys="⌘Z" />
            </span>
          )}
          <span>
            New <Kbd keys="⌘N" />
          </span>
          <span>
            History <Kbd keys="⌘Y" />
          </span>
        </>
      )}
      {run.model && <span className="agent-bar__model">{run.model}</span>}
    </div>
  );
}
