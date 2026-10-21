/**
 * Settings › Automations: list (NavList) on the left, editor on the right.
 * List keys: ↑/↓ ⌃J/⌃K and vim j/k/gg/G · ⏎ or i edit · n / ⌘N new · ⌘⏎ enable/disable · ⌘R run now · ⌘K actions.
 * Editor keys: ⌘S save · ⌘R run · Esc back to the list (keys typed in the editor never move the list).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavAction, NavItem } from "../types";
import { NavList } from "../../components/NavList";
import { Kbd } from "../../components/Kbd";
import { Toast, useToast } from "../../components/Toast";
import { defaultTrigger, newId, type AutomationView, type SaveResult } from "../../../main/features/automations/model";
import { automationsCall, relTime, STATUS_ICON, useAutomations, type ExecuteResult } from "./common";
import { Editor, riskyTarget, type Draft } from "./Editor";
import { RunLog } from "./RunLog";

type Row = NavItem & ({ kind: "automation"; a: AutomationView; dirty: boolean } | { kind: "draft"; d: Draft } | { kind: "new" });

const fromAutomation = (a: AutomationView): Draft => ({ id: a.id, name: a.name, enabled: a.enabled, askBeforeRunning: a.askBeforeRunning, askTouched: true, trigger: a.trigger, target: a.target, isNew: false });

const isEditable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest(".automations-editor"));

/** Moves NavList's (internal) selection one row per render by feeding it arrow keys until it reaches `target`. */
function useSteer(rows: Row[], selectedId: string | null) {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!target) return;
    const want = rows.findIndex((r) => r.id === target);
    const have = rows.findIndex((r) => r.id === selectedId);
    if (want < 0 || want === have) {
      if (want === have) setTarget(null);
      return;
    }
    const key = want > have ? "ArrowDown" : "ArrowUp";
    window.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true }));
  }, [target, rows, selectedId]);
  return setTarget;
}

function anchor(): string {
  const h = location.hash.slice(1);
  const i = h.indexOf("#");
  return i >= 0 ? decodeURIComponent(h.slice(i + 1)) : "";
}

export function AutomationsSettingsPage() {
  const [state, now] = useAutomations();
  const { toast, show } = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);

  const rows = useMemo((): Row[] => {
    if (!state) return [];
    const out: Row[] = [];
    for (const d of Object.values(drafts)) if (d.isNew) out.push({ id: d.id, section: "Unsaved", kind: "draft", d });
    for (const a of state.automations) out.push({ id: a.id, section: "Automations", kind: "automation", a, dirty: !!drafts[a.id] });
    out.push({ id: "new", section: "Automations", kind: "new" });
    return out;
  }, [state, drafts]);
  const steer = useSteer(rows, selectedId);

  const say = useCallback((r: ExecuteResult) => show(r.error ?? r.message ?? "", r.ok ? "info" : "error"), [show]);

  const createDraft = useCallback(() => {
    const id = newId("a", Date.now());
    const d: Draft = { id, name: "", enabled: true, askBeforeRunning: false, askTouched: false, trigger: defaultTrigger("time"), target: null, isNew: true };
    if (state?.workflows[0]) {
      d.target = { kind: "workflow", workflowId: state.workflows[0].id };
      d.askBeforeRunning = riskyTarget(d.target, state.workflows);
    }
    setDrafts((x) => ({ ...x, [id]: d }));
    steer(id);
    setFocusSignal((n) => n + 1);
  }, [state, steer]);

  // "#new" / "#<id>" anchors from the launcher ("Create Automation", "Edit…").
  const stateReady = !!state;
  useEffect(() => {
    if (!stateReady) return;
    const apply = () => {
      const a = anchor();
      if (a === "new") {
        createDraft();
        history.replaceState(null, "", location.hash.replace(/#new$/, ""));
      } else if (a) steer(a);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
    // Runs once the state exists, then on every hash change; createDraft/steer are read at that moment.
  }, [stateReady]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const draft: Draft | null = selected?.kind === "draft" ? selected.d : selected?.kind === "automation" ? (drafts[selected.a.id] ?? fromAutomation(selected.a)) : null;
  const saved = selected?.kind === "automation" ? selected.a : null;
  useEffect(() => setError(null), [selectedId]);

  const updateDraft = (d: Draft) => setDrafts((x) => ({ ...x, [d.id]: d }));
  const discard = (id: string) =>
    setDrafts((x) => {
      const { [id]: _drop, ...rest } = x;
      return rest;
    });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.target || (draft.target.kind === "workflow" && !draft.target.workflowId) || (draft.target.kind === "command" && !draft.target.itemId)) {
      setError("Choose a workflow or command to run");
      return;
    }
    const { askTouched: _t, isNew: _n, ...payload } = draft;
    const res = await automationsCall<SaveResult>("save", payload);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    discard(draft.id);
    show(`Saved “${res.automation.name}”`);
  }, [draft, show]);

  const runNow = useCallback(async () => {
    if (!saved) return show("Save the automation first", "error");
    show(`Running “${saved.name}”…`);
    say(await automationsCall<ExecuteResult>("runNow", saved.id));
  }, [saved, say, show]);

  const remove = useCallback(
    async (id: string) => {
      if (drafts[id]?.isNew) return discard(id);
      const a = state?.automations.find((x) => x.id === id);
      if (!a || !window.confirm(`Delete “${a.name}”?`)) return;
      discard(id);
      say(await automationsCall<ExecuteResult>("remove", id));
    },
    [drafts, state, say],
  );

  const toggle = useCallback(async (a: AutomationView) => say(await automationsCall<ExecuteResult>("setEnabled", a.id, !a.enabled)), [say]);

  const focusEditor = () => setFocusSignal((n) => n + 1);
  const backToList = () => {
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const actions = useCallback(
    (r: Row): NavAction[] => {
      if (r.kind === "new") return [{ id: "new", title: "New Automation", shortcut: "⏎", run: createDraft }];
      if (r.kind === "draft")
        return [
          { id: "edit", title: "Edit", shortcut: "⏎", run: focusEditor },
          { id: "discard", title: "Discard Draft", shortcut: "⌃X", destructive: true, run: () => discard(r.id) },
        ];
      return [
        { id: "edit", title: "Edit", shortcut: "⏎", run: focusEditor },
        { id: "toggle", title: r.a.enabled ? "Disable" : "Enable", shortcut: "⌘⏎", run: () => void toggle(r.a) },
        { id: "run", title: "Run Now", shortcut: "⌘R", run: () => void automationsCall<ExecuteResult>("runNow", r.a.id).then(say) },
        { id: "clear", title: "Clear Run Log", shortcut: "⇧⌘⌫", run: () => void automationsCall<ExecuteResult>("clearLog", r.a.id).then(say) },
        { id: "new", title: "New Automation", shortcut: "⌘N", run: createDraft },
        { id: "delete", title: "Delete", shortcut: "⌃X", destructive: true, run: () => void remove(r.a.id) },
      ];
    },
    [createDraft, toggle, say, remove],
  );

  // Vim keys and single-letter commands for the list (NavList itself only binds arrows/⌃J/⌃K outside the launcher).
  const lastG = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditable(e.target) || !e.isTrusted) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      const arrow = (key: "ArrowDown" | "ArrowUp") => window.dispatchEvent(new KeyboardEvent("keydown", { key, code: key }));
      if (plain && e.key === "j") arrow("ArrowDown");
      else if (plain && e.key === "k") arrow("ArrowUp");
      else if (plain && e.key === "G") steer(rows.at(-1)?.id ?? null);
      else if (plain && e.key === "g") {
        if (e.timeStamp - lastG.current < 500) steer(rows[0]?.id ?? null);
        lastG.current = e.timeStamp;
      } else if ((plain && e.key === "n") || (e.metaKey && e.key.toLowerCase() === "n")) createDraft();
      else if (plain && (e.key === "i" || e.key === "l" || e.key === "e")) focusEditor();
      else if (plain && e.key === "x" && selected && selected.kind !== "new") void remove(selected.id);
      else if (e.metaKey && e.key.toLowerCase() === "s") void save();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, steer, createDraft, remove, save, selected]);

  if (!state) return <div className="empty">Loading…</div>;
  const dirty = !!draft && !!drafts[draft.id];

  return (
    <div className="automations-page">
      <p className="page__lead">
        Run a workflow or command automatically — at a time, on a schedule, or when something happens on your Mac. <Kbd keys="j" />/<Kbd keys="k" /> move · <Kbd keys="⏎" /> edit · <Kbd keys="n" /> new · <Kbd keys="⌘⏎" /> on/off · <Kbd keys="⌘K" /> actions
      </p>
      <div className="automations-split">
        <div className="automations-split__list" aria-label="Automations">
          <NavList<Row>
            items={rows}
            actions={actions}
            actionsTitle="Automation"
            onSelectionChange={(r) => setSelectedId(r?.id ?? null)}
            onActivate={(r, m) => {
              if (r.kind === "new") return createDraft();
              if (m.cmd && r.kind === "automation") return void toggle(r.a);
              focusEditor();
            }}
            renderItem={(r, sel) => {
              const cls = `automations-item ${sel ? "automations-item--selected" : ""}`;
              if (r.kind === "new")
                return (
                  <div className={cls}>
                    <span className="automations-item__icon">➕</span>
                    <span className="automations-item__title">New Automation</span>
                    <Kbd keys="n" />
                  </div>
                );
              if (r.kind === "draft")
                return (
                  <div className={cls}>
                    <span className="automations-item__icon">✏️</span>
                    <span className="automations-item__main">
                      <span className="automations-item__title">{r.d.name || "New Automation"}</span>
                      <span className="automations-item__sub">Not saved yet</span>
                    </span>
                  </div>
                );
              const last = r.a.log[0];
              return (
                <div className={`${cls} ${r.a.enabled ? "" : "automations-item--off"}`} data-automation={r.a.id}>
                  <span className="automations-item__icon">{r.a.running ? "⏳" : r.a.enabled ? "⚡️" : "💤"}</span>
                  <span className="automations-item__main">
                    <span className="automations-item__title">
                      {r.a.name}
                      {r.dirty ? " •" : ""}
                    </span>
                    <span className="automations-item__sub">{r.a.triggerText}</span>
                  </span>
                  <span className="automations-item__last">{last ? `${STATUS_ICON[last.status]} ${relTime(last.at, now)}` : r.a.enabled ? "On" : "Off"}</span>
                </div>
              );
            }}
          />
        </div>
        <div
          className="automations-editor"
          ref={editorRef}
          onKeyDown={(e) => {
            // Keys typed while editing belong to the editor, never to the list on the left.
            if (e.metaKey && /^[1-9]$/.test(e.key)) return;
            e.stopPropagation();
            if (e.metaKey && e.key.toLowerCase() === "s") {
              e.preventDefault();
              void save();
            } else if (e.metaKey && e.key.toLowerCase() === "r") {
              e.preventDefault();
              void runNow();
            } else if (e.key === "Escape" && !e.defaultPrevented) {
              e.preventDefault();
              backToList();
            }
          }}
        >
          {!draft ? (
            <div className="automations-editor__empty">
              <p>Select an automation, or create one.</p>
              <button type="button" className="btn btn--primary" onClick={createDraft}>
                New Automation
              </button>
            </div>
          ) : (
            <>
              <Editor key={draft.id} draft={draft} workflows={state.workflows} onChange={updateDraft} focusSignal={focusSignal} />
              {saved?.problem && <p className="automations-problem">⚠️ {saved.problem}</p>}
              {error && (
                <p className="automations-error" role="alert">
                  {error}
                </p>
              )}
              <div className="automations-editor__bar">
                <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={!dirty && !draft.isNew}>
                  {draft.isNew ? "Create" : "Save"} <Kbd keys="⌘S" />
                </button>
                {dirty && !draft.isNew && (
                  <button type="button" className="btn" onClick={() => discard(draft.id)}>
                    Revert
                  </button>
                )}
                {saved && (
                  <button type="button" className="btn" onClick={() => void runNow()} disabled={saved.running}>
                    {saved.running ? "Running…" : "Run Now"} <Kbd keys="⌘R" />
                  </button>
                )}
                <span className="automations-editor__spacer" />
                <button type="button" className="btn btn--danger" onClick={() => void remove(draft.id)}>
                  {draft.isNew ? "Discard" : "Delete"}
                </button>
              </div>
              {saved && (
                <section className="automations-editor__log">
                  <h3 className="group__title">
                    Run log
                    <span className="faint">
                      {saved.nextRun ? ` · next run ${relTime(saved.nextRun, now)}` : ""} · last {saved.log.length} of 50
                    </span>
                    {saved.log.length > 0 && (
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void automationsCall<ExecuteResult>("clearLog", saved.id).then(say)}>
                        Clear
                      </button>
                    )}
                  </h3>
                  <RunLog log={saved.log} />
                </section>
              )}
            </>
          )}
        </div>
      </div>
      <Toast toast={toast} />
    </div>
  );
}
