/**
 * Launcher view "agent.run": the launcher search field is the request input; the transcript
 * (prompt, Claude's text, each tool call with its arguments and result) is a NavList so
 * j/k/⌃J/⌃K/gg/G and ⌘K work. While a confirmation is pending, ⏎ runs the listed actions,
 * ⌘⏎ runs them and stops asking for those tools, esc cancels. Esc while running stops the run.
 * Keys are taken in a window capture listener so they win over the launcher's own handlers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "../../components/Kbd";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { agent, useAgentRun, type AgentStatus, type AgentStep, type RunSnapshot, type TranscriptEntry } from "./api";

type Row = NavItem & { entry: TranscriptEntry };

const STATUS_ICON: Record<AgentStep["status"], string> = {
  queued: "○",
  awaiting: "?",
  running: "◌",
  ok: "✓",
  error: "✕",
  declined: "⊘",
  skipped: "–",
};

function readProps(p: Record<string, unknown>): { prompt?: string; runId?: string } {
  return { prompt: typeof p.prompt === "string" && p.prompt.trim() ? p.prompt : undefined, runId: typeof p.runId === "string" ? p.runId : undefined };
}

function argsText(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (!keys.length) return "";
  return keys.map((k) => `${k}: ${typeof args[k] === "string" ? (args[k] as string) : JSON.stringify(args[k])}`).join(" · ");
}

const PLACEHOLDER_IDLE = "What should Glide do? e.g. put Safari left and Notes right, start a 25 min timer";

export function AgentView(view: ViewProps) {
  const props = readProps(view.props);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const { run, startError, start, attach } = useAgentRun();
  const started = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void agent.status().then(setStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start the prompt we were opened with, or re-attach to a run (view re-opened by main).
  useEffect(() => {
    if (!status || started.current) return;
    started.current = true;
    void (async () => {
      if (props.runId && (await attach(props.runId))) return;
      if (props.prompt && status.hasKey) return start(props.prompt);
      if (!props.prompt) {
        const active = await agent.activeRun();
        if (active) await attach(active.runId);
      }
    })();
  }, [status, props.runId, props.prompt, attach, start]);

  const busy = run?.status === "running" || run?.status === "confirming";
  const confirming = run?.status === "confirming" ? run.confirmation : undefined;

  useEffect(() => {
    view.setPlaceholder(confirming ? "Press ⏎ to run these actions, esc to cancel" : busy ? "Working… (esc to stop)" : run ? "Ask Glide to do something else…" : PLACEHOLDER_IDLE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, busy, !!run]);

  const steps = useMemo(() => (run ? run.entries.flatMap((e) => (e.kind === "step" ? [e.step] : [])) : []), [run]);
  const pendingSteps = useMemo(() => (confirming ? steps.filter((s) => confirming.stepIds.includes(s.id)) : []), [confirming, steps]);

  const submit = useCallback(
    (text: string) => {
      view.setQuery("");
      void start(text);
    },
    [start, view],
  );

  const answer = useCallback(
    async (approve: boolean, always = false) => {
      if (!run?.confirmation) return;
      if (approve && always) {
        const s = await agent.getSettings();
        const allow = { ...s.allow };
        for (const st of pendingSteps) allow[st.tool] = true;
        await agent.setSettings({ allow });
        view.toast(`Won't ask again for ${[...new Set(pendingSteps.map((s) => s.title))].join(", ")}`);
      }
      await agent.respond(run.runId, run.confirmation.id, approve);
    },
    [run, pendingSteps, view],
  );

  const live = useRef({ run, confirming, busy, status, view, submit, answer });
  live.current = { run, confirming, busy, status, view, submit, answer };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.isComposing) return;
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
          if (s.run) void agent.cancel(s.run.runId);
        } else if (e.key === "Enter" && s.view.query.trim()) {
          handled();
          s.view.toast("Glide Agent is still working — press esc to stop it first");
        }
        return;
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
  const count = run?.entries.length ?? 0;
  const lastLen = run?.entries.at(-1)?.kind === "text" ? (run.entries.at(-1) as { text: string }).text.length : 0;
  useEffect(() => {
    if (!busy) return;
    const list = rootRef.current?.querySelector(".navlist__items");
    if (list) list.scrollTop = list.scrollHeight;
  }, [busy, count, lastLen]);

  const rows: Row[] = useMemo(() => (run ? run.entries.map((entry) => ({ id: entry.id, entry })) : []), [run]);

  const rowActions = useCallback(
    (row: Row): NavAction[] => {
      const list: NavAction[] = [];
      const e = row.entry;
      const text = e.kind === "step" ? (e.step.result ?? "") : e.text;
      if (text) list.push({ id: "copy", title: e.kind === "step" ? "Copy Result" : "Copy Text", shortcut: "⌘C", icon: "📋", run: () => void navigator.clipboard.writeText(text).then(() => view.toast("Copied")) });
      if (e.kind === "step" && e.step.mutating) {
        const st = e.step;
        list.push({
          id: "allow",
          title: `Always Allow “${st.title}”`,
          icon: "✅",
          run: async () => {
            const s = await agent.getSettings();
            await agent.setSettings({ allow: { ...s.allow, [st.tool]: true } });
            view.toast(`“${st.title}” will run without asking`);
          },
        });
      }
      if (busy && run) list.push({ id: "stop", title: "Stop Agent", shortcut: "esc", icon: "■", destructive: true, run: () => void agent.cancel(run.runId) });
      list.push({ id: "settings", title: "Agent Settings…", icon: "⚙️", run: () => window.glide.openSettings("agent") });
      return list;
    },
    [busy, run, view],
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
    <div className="agent" ref={rootRef} data-testid="agent-view" data-status={run?.status ?? "idle"}>
      {!run && !startError && <Intro />}
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
      {run && (
        <NavList<Row>
          className="agent__list"
          items={rows}
          renderItem={(row, selected) => <EntryRow entry={row.entry} selected={selected} />}
          onActivate={(row) => {
            const e = row.entry;
            const text = e.kind === "step" ? (e.step.result ?? "") : e.text;
            if (text) void navigator.clipboard.writeText(text).then(() => view.toast("Copied"));
          }}
          actions={rowActions}
          actionsTitle="Glide Agent"
        />
      )}
      {confirming && <ConfirmCard steps={pendingSteps} />}
      {run && <StatusBar run={run} />}
    </div>
  );
}

function Intro() {
  return (
    <div className="agent__intro" data-testid="agent-intro">
      <div className="agent__hero">🪄</div>
      <div className="agent__title">Tell Glide what to do</div>
      <ul className="agent__examples">
        <li>Put Safari on the left and Notes on the right</li>
        <li>Start a 25 minute focus timer and open my standup notes</li>
        <li>What's on my calendar today?</li>
      </ul>
      <p className="agent__text">
        Type a request and press <Kbd keys="⏎" />. Glide asks before doing anything that changes your Mac.
      </p>
    </div>
  );
}

function EntryRow({ entry, selected }: { entry: TranscriptEntry; selected: boolean }) {
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
  const st = entry.step;
  const args = argsText(st.args);
  return (
    <div className={`${cls} agent-row--${st.status}`} data-testid="agent-step" data-tool={st.tool} data-status={st.status}>
      <span className={`agent-row__icon agent-status agent-status--${st.status}`} aria-label={st.status}>
        {STATUS_ICON[st.status]}
      </span>
      <div className="agent-row__main">
        <div className="agent-row__title">
          <span className="agent-row__tool">{st.title}</span>
          <span className="agent-row__summary">{st.summary}</span>
          {st.autoApproved && <span className="tag">allowed</span>}
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
          </div>
        )}
        {!selected && st.result && (st.status === "error" || st.status === "ok") && <div className="agent-row__brief">{st.result.split("\n")[0]?.slice(0, 140)}</div>}
      </div>
    </div>
  );
}

function ConfirmCard({ steps }: { steps: AgentStep[] }) {
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
        <span>
          Run &amp; don't ask again <Kbd keys="⌘⏎" />
        </span>
        <span>
          Cancel <Kbd keys="esc" />
        </span>
      </div>
    </div>
  );
}

function StatusBar({ run }: { run: RunSnapshot }) {
  const label =
    run.status === "running" ? "Working…" : run.status === "confirming" ? "Waiting for you" : run.status === "done" ? "Done" : run.status === "cancelled" ? "Stopped" : "Failed";
  return (
    <div className={`agent-bar agent-bar--${run.status}`} data-testid="agent-bar">
      <span className="agent-bar__state">{label}</span>
      <span>
        {run.toolCalls}/{run.maxToolCalls} tool calls
      </span>
      {run.model && <span className="agent-bar__model">{run.model}</span>}
      {run.status === "running" && (
        <span>
          Stop <Kbd keys="esc" />
        </span>
      )}
    </div>
  );
}
