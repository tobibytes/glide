import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionSpec, RunResult, SearchItem, UserData, Workflow } from "@shared/types";
import { glide } from "../../lib/glide";
import { navigateTo } from "../../lib/route";
import {
  cloneAction,
  createAction,
  emptyWorkflow,
  getAction,
  getContainer,
  insertAction,
  moveAction,
  pathKey,
  removeAction,
  updateAction,
  type Path,
} from "../../lib/workflowTree";
import { Icon } from "../../components/Icon";
import { IconPicker } from "../../components/IconPicker";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { Kbd } from "../../components/Kbd";
import { Toggle } from "../../components/form";
import { Toast, useToast } from "../../components/Toast";
import { ActionStack, EditorCtx, type CardCommand, type EditorContext } from "./workflow/ActionStack";
import { ActionLibrary } from "./workflow/ActionLibrary";
import { RunLog } from "./workflow/RunLog";

interface Props {
  data: UserData;
  workflowId: string; // "new" or an id
  reload: () => Promise<void>;
}

const isEditable = (el: EventTarget | null): boolean => {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return !!t.closest("input, textarea, select, [contenteditable='true']");
};

export function WorkflowEditor({ data, workflowId }: Props) {
  const isNew = workflowId === "new";
  const existing = isNew ? undefined : data.workflows.find((w) => w.id === workflowId || `workflow:${w.id}` === workflowId);
  const [draft, setDraft] = useState<Workflow>(() => (existing ? structuredClone(existing) : emptyWorkflow()));
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(existing ?? null));
  const [specs, setSpecs] = useState<ActionSpec[]>([]);
  const [apps, setApps] = useState<SearchItem[]>([]);
  const [selected, setSelected] = useState<Path | null>(null);
  const [dragging, setDragging] = useState<Path | null>(null);
  const [insertTarget, setInsertTarget] = useState<{ container: Path; index: number } | null>(null);
  const [tab, setTab] = useState<"library" | "run">("library");
  const [runInput, setRunInput] = useState("");
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast, show } = useToast();
  const canvasRef = useRef<HTMLDivElement>(null);
  const runInputRef = useRef<HTMLInputElement>(null);

  const dirty = JSON.stringify(draft) !== savedJson;

  useEffect(() => {
    let alive = true;
    void glide()
      .actionSpecs()
      .then((s) => alive && setSpecs(s))
      .catch((err: unknown) => show(err instanceof Error ? err.message : String(err), "error"));
    void glide()
      .listApps()
      .then((a) => alive && setApps(a))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the workflow was changed on disk by another window and we have no local edits, follow it.
  useEffect(() => {
    if (existing && !dirty && JSON.stringify(existing) !== savedJson) {
      setDraft(structuredClone(existing));
      setSavedJson(JSON.stringify(existing));
    }
  }, [existing, dirty, savedJson]);

  const setActions = useCallback((fn: (actions: Workflow["actions"]) => Workflow["actions"]) => setDraft((d) => ({ ...d, actions: fn(d.actions) })), []);

  // --- actions ---------------------------------------------------------------
  const save = useCallback(async (): Promise<Workflow | null> => {
    if (!draft.name.trim()) {
      show("Give the workflow a name first", "error");
      document.getElementById("wf-name")?.focus();
      return null;
    }
    setSaving(true);
    try {
      const saved = await glide().saveWorkflow({ ...draft, name: draft.name.trim(), alias: draft.alias?.trim() || undefined, description: draft.description?.trim() || undefined, updatedAt: Date.now() });
      setDraft(saved);
      setSavedJson(JSON.stringify(saved));
      show("Saved");
      if (isNew) navigateTo("workflows", saved.id);
      return saved;
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "error");
      return null;
    } finally {
      setSaving(false);
    }
  }, [draft, isNew, show]);

  const run = useCallback(async () => {
    setTab("run");
    if (draft.acceptsInput && !runInput && document.activeElement !== runInputRef.current) {
      requestAnimationFrame(() => runInputRef.current?.focus());
      show("Enter input for this run, then press Run again");
      return;
    }
    let target: Workflow | null = draft;
    if (dirty || isNew) target = await save();
    if (!target) return;
    setRunning(true);
    setRunResult(null);
    try {
      const res = await glide().runWorkflow(target.id, draft.acceptsInput ? runInput : undefined);
      setRunResult(res);
      show(res.ok ? "Workflow finished" : "Workflow failed", res.ok ? "info" : "error");
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setRunning(false);
    }
  }, [dirty, draft, isNew, runInput, save, show]);

  const remove = async () => {
    if (!existing) return navigateTo("workflows");
    if (!confirm(`Delete “${existing.name}”? This cannot be undone.`)) return;
    try {
      await glide().deleteWorkflow(existing.id);
      navigateTo("workflows");
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const duplicate = async () => {
    try {
      const copy = await glide().saveWorkflow({ ...draft, id: "", name: `${draft.name || "Untitled"} copy`, alias: undefined, hotkey: undefined, actions: draft.actions.map(cloneAction), createdAt: Date.now(), updatedAt: Date.now() });
      navigateTo("workflows", copy.id);
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const back = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    navigateTo("workflows");
  };

  const addSpec = (spec: ActionSpec) => {
    const action = createAction(spec);
    let container: Path = [];
    let index = draft.actions.length;
    if (insertTarget) {
      container = insertTarget.container;
      index = insertTarget.index;
    } else if (selected) {
      container = selected.slice(0, -1);
      index = (selected[selected.length - 1] as number) + 1;
    }
    setActions((a) => insertAction(a, container, index, action));
    const path = [...container, index];
    setSelected(path);
    setInsertTarget(null);
    requestAnimationFrame(() => document.getElementById(`card-${pathKey(path)}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const command = useCallback(
    (path: Path, cmd: CardCommand) => {
      const container = path.slice(0, -1);
      const idx = path[path.length - 1] as number;
      switch (cmd) {
        case "duplicate":
          setActions((a) => {
            const src = getAction(a, path);
            return src ? insertAction(a, container, idx + 1, cloneAction(src)) : a;
          });
          setSelected([...container, idx + 1]);
          break;
        case "toggle":
          setActions((a) => updateAction(a, path, (x) => ({ ...x, disabled: !x.disabled })));
          break;
        case "delete":
          setActions((a) => removeAction(a, path));
          setSelected((s) => {
            if (!s) return null;
            const list = getContainer(draft.actions, container);
            const nextIdx = Math.min(idx, list.length - 2);
            return nextIdx >= 0 ? [...container, nextIdx] : null;
          });
          break;
        case "up":
          if (idx > 0) {
            setActions((a) => moveAction(a, path, container, idx - 1).root);
            setSelected([...container, idx - 1]);
          }
          break;
        case "down":
          setActions((a) => {
            const list = getContainer(a, container);
            return idx < list.length - 1 ? moveAction(a, path, container, idx + 2).root : a;
          });
          setSelected((s) => {
            const list = getContainer(draft.actions, container);
            return idx < list.length - 1 ? [...container, idx + 1] : s;
          });
          break;
      }
    },
    [draft.actions, setActions],
  );

  const ctx = useMemo<EditorContext>(
    () => ({
      root: draft.actions,
      specs,
      apps,
      selected,
      dragging,
      select: (p) => {
        setSelected(p);
        setInsertTarget(null);
      },
      setParam: (path, key, value) => setActions((a) => updateAction(a, path, (x) => ({ ...x, params: { ...x.params, [key]: value } }))),
      command,
      drop: (from, container, index) => {
        let next: Path = from;
        setActions((a) => {
          const r = moveAction(a, from, container, index);
          next = r.path;
          return r.root;
        });
        setSelected(next);
      },
      setDragging,
      addAt: (container, index) => {
        setInsertTarget({ container, index });
        setTab("library");
        show("Pick an action from the library to add it there");
      },
    }),
    [draft.actions, specs, apps, selected, dragging, command, setActions, show],
  );

  // --- keyboard ---------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && e.key.toLowerCase() === "r") {
      e.preventDefault();
      void run();
      return;
    }
    if (isEditable(e.target)) return;
    if (mod && e.key.toLowerCase() === "d" && selected) {
      e.preventDefault();
      command(selected, "duplicate");
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && selected) {
      e.preventDefault();
      command(selected, "delete");
      return;
    }
    if (e.key === "Escape") {
      setSelected(null);
      setInsertTarget(null);
    }
  };

  const libraryHint = insertTarget
    ? `Adding into ${insertTarget.container.includes("else") ? "Else" : insertTarget.container.includes("then") ? "Then" : "the workflow"} at position ${insertTarget.index + 1}`
    : selected
      ? "Click an action to insert it after the selected card"
      : "Click an action to append it to the workflow";

  return (
    <div className="wf" onKeyDown={onKeyDown}>
      <div className="wf__toolbar">
        <button type="button" className="btn btn--ghost" onClick={back} aria-label="Back to workflows">
          ← Workflows
        </button>
        <div className="wf__toolbar-title">
          <Icon icon={draft.icon} />
          {draft.name || "Untitled Workflow"}
        </div>
        {dirty && (
          <span className="wf__dirty">
            <span className="badge-dot" /> Unsaved changes
          </span>
        )}
        <button type="button" className="btn" onClick={() => void run()} disabled={running || draft.actions.length === 0}>
          {running ? "Running…" : "Run"} <Kbd keys="⌘R" />
        </button>
        <button type="button" className="btn" onClick={() => void duplicate()} disabled={isNew}>
          Duplicate
        </button>
        <button type="button" className="btn btn--danger" onClick={() => void remove()}>
          {isNew ? "Discard" : "Delete"}
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving || (!dirty && !isNew)}>
          Save <Kbd keys="⌘S" />
        </button>
      </div>

      <div className="wf__body">
        <div
          ref={canvasRef}
          className="wf__canvas"
          tabIndex={-1}
          onMouseDown={(e) => {
            if (!isEditable(e.target) && !(e.target as HTMLElement).closest("button")) {
              setSelected(null);
              setInsertTarget(null);
            }
          }}
        >
          <div className="wf__canvas-inner">
            <div className="wfhead" onMouseDown={(e) => e.stopPropagation()}>
              <IconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
              <div className="wfhead__fields">
                <input id="wf-name" className="wfhead__name" placeholder="Workflow name" value={draft.name} autoFocus={isNew} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <input className="wfhead__desc" placeholder="Add a description…" value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                <div className="wfhead__row">
                  <div className="field">
                    <label className="field__label" htmlFor="wf-alias">
                      Alias
                    </label>
                    <input id="wf-alias" className="input" placeholder="e.g. morning" value={draft.alias ?? ""} onChange={(e) => setDraft({ ...draft, alias: e.target.value })} />
                  </div>
                  <div className="field">
                    <span className="field__label">Hotkey</span>
                    <HotkeyRecorder value={draft.hotkey} onChange={(accel) => setDraft({ ...draft, hotkey: accel ?? undefined })} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <span className="field__label">Accepts input</span>
                    <div className="wfhead__toggle">
                      <Toggle label="Accepts input" checked={!!draft.acceptsInput} onChange={(v) => setDraft({ ...draft, acceptsInput: v })} />
                      <span className="field__hint">Type the workflow name then a space and your text in the launcher</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <EditorCtx.Provider value={ctx}>
              {draft.actions.length === 0 && !dragging && <div className="empty">No actions yet. Pick one from the library on the right.</div>}
              <ActionStack actions={draft.actions} container={[]} />
            </EditorCtx.Provider>
            <div className="stack__add">
              <button
                type="button"
                className="addbtn"
                onClick={() => {
                  setInsertTarget({ container: [], index: draft.actions.length });
                  setTab("library");
                }}
              >
                + Add Action
              </button>
            </div>
          </div>
        </div>

        <aside className="wf__side" aria-label="Action library and run log">
          <div className="wf__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "library"} className={`wf__tab ${tab === "library" ? "wf__tab--on" : ""}`} onClick={() => setTab("library")}>
              Add Action
            </button>
            <button type="button" role="tab" aria-selected={tab === "run"} className={`wf__tab ${tab === "run" ? "wf__tab--on" : ""}`} onClick={() => setTab("run")}>
              Run{runResult ? (runResult.ok ? " ✓" : " ✕") : ""}
            </button>
          </div>
          <div className="wf__side-body">
            {tab === "library" ? (
              <ActionLibrary specs={specs} onPick={addSpec} hint={libraryHint} />
            ) : (
              <>
                <div className="runbar">
                  {draft.acceptsInput && (
                    <input
                      ref={runInputRef}
                      className="input"
                      placeholder="Input for this run ({{input}})"
                      value={runInput}
                      onChange={(e) => setRunInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void run();
                        }
                      }}
                      aria-label="Workflow input"
                    />
                  )}
                  <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={running || draft.actions.length === 0}>
                    {running ? "Running…" : dirty || isNew ? "Save & Run" : "Run"}
                  </button>
                </div>
                <RunLog result={runResult} actions={draft.actions} specs={specs} running={running} />
              </>
            )}
          </div>
        </aside>
      </div>
      <Toast toast={toast} />
    </div>
  );
}
