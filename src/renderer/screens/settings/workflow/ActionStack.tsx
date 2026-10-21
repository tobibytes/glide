import { createContext, useContext, useEffect, useRef, useState, type DragEvent } from "react";
import type { ActionSpec, SearchItem, WorkflowAction } from "@shared/types";
import { specForAction, visibleParams } from "@shared/workflow-specs";
import { availableVariables, CATEGORY_COLORS, CATEGORY_LABELS, pathKey, walk, type Path } from "../../../lib/workflowTree";
import { Icon } from "../../../components/Icon";
import { Kbd } from "../../../components/Kbd";
import { ParamEditor } from "./ParamEditor";

export type CardCommand = "duplicate" | "toggle" | "delete" | "up" | "down";

export interface EditorContext {
  root: WorkflowAction[];
  specs: ActionSpec[];
  apps: SearchItem[];
  selected: Path | null;
  dragging: Path | null;
  select: (path: Path | null) => void;
  setParam: (path: Path, key: string, value: string) => void;
  command: (path: Path, cmd: CardCommand) => void;
  drop: (from: Path, container: Path, index: number) => void;
  setDragging: (path: Path | null) => void;
  addAt: (container: Path, index: number) => void;
}

export const EditorCtx = createContext<EditorContext | null>(null);
const useEditor = (): EditorContext => {
  const ctx = useContext(EditorCtx);
  if (!ctx) throw new Error("EditorCtx missing");
  return ctx;
};

const DRAG_MIME = "application/x-glide-action";
const MONO_PARAMS = new Set(["runShell:command", "runAppleScript:script", "httpRequest:headers", "httpRequest:body"]);

/** availableVariables() resolves specs by type only; add the outputVars of earlier feature actions. */
function variablesFor(root: WorkflowAction[], path: Path, specs: ActionSpec[]): Array<{ name: string; hint: string }> {
  const out = availableVariables(root, path, specs.filter((s) => s.type !== "feature"));
  const seen = new Set(out.map((v) => v.name));
  const target = pathKey(path);
  let reached = false;
  walk(root, (a, p) => {
    if (pathKey(p) === target) reached = true;
    if (reached || a.type !== "feature") return;
    const spec = specForAction(specs, a);
    if (spec?.outputVar && !seen.has(spec.outputVar)) {
      seen.add(spec.outputVar);
      out.push({ name: spec.outputVar, hint: spec.title });
    }
  });
  return out;
}

function DropZone({ container, index, end }: { container: Path; index: number; end?: boolean }) {
  const ed = useEditor();
  const [over, setOver] = useState(false);
  const onDragOver = (e: DragEvent) => {
    if (!ed.dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!over) setOver(true);
  };
  return (
    <div
      className={`dropzone ${end ? "dropzone--end" : ""} ${over ? "dropzone--over" : ""}`}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const from = ed.dragging;
        if (from) ed.drop(from, container, index);
        ed.setDragging(null);
      }}
      aria-hidden="true"
    />
  );
}

export function ActionStack({ actions, container }: { actions: WorkflowAction[]; container: Path }) {
  const ed = useEditor();
  return (
    <div className={`stack ${ed.dragging ? "stack--dragging" : ""}`}>
      {actions.map((a, i) => (
        <div key={a.id}>
          <DropZone container={container} index={i} />
          <ActionCard action={a} path={[...container, i]} isFirst={i === 0} isLast={i === actions.length - 1} />
        </div>
      ))}
      <DropZone container={container} index={actions.length} end />
    </div>
  );
}

function ActionCard({ action, path, isFirst, isLast }: { action: WorkflowAction; path: Path; isFirst: boolean; isLast: boolean }) {
  const ed = useEditor();
  const spec = specForAction(ed.specs, action);
  const params = spec ? visibleParams(spec) : [];
  const key = pathKey(path);
  const selected = ed.selected ? pathKey(ed.selected) === key : false;
  const dragging = ed.dragging ? pathKey(ed.dragging) === key : false;
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const variables = variablesFor(ed.root, path, ed.specs);
  const color = spec ? CATEGORY_COLORS[spec.category] : "var(--text-3)";

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu]);

  const run = (cmd: CardCommand) => {
    setMenu(false);
    ed.command(path, cmd);
  };

  return (
    <div className="card-wrap">
      <div
        id={`card-${key}`}
        className={`acard ${selected ? "acard--on" : ""} ${action.disabled ? "acard--disabled" : ""} ${dragging ? "acard--dragging" : ""}`}
        role="group"
        aria-label={spec?.title ?? action.type}
        aria-current={selected ? "true" : undefined}
        onMouseDown={(e) => {
          e.stopPropagation();
          ed.select(path);
        }}
        onDragOver={(e) => {
          // Let nested drop zones handle; prevent card itself from being a target.
          if (ed.dragging) e.stopPropagation();
        }}
      >
        <div className="acard__stripe" style={{ background: color }} />
        <div className="acard__body">
          <div className="acard__head">
            <span
              className="acard__handle"
              draggable
              title="Drag to reorder"
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, key);
                e.dataTransfer.effectAllowed = "move";
                ed.setDragging(path);
                ed.select(path);
              }}
              onDragEnd={() => ed.setDragging(null)}
            >
              ⋮⋮
            </span>
            <span className="acard__title">
              <Icon icon={spec?.icon} />
              {action.label || spec?.title || (action.type === "feature" ? `${action.params.feature ?? ""}.${action.params.action ?? ""}` : action.type)}
              {action.disabled && <span className="tag">disabled</span>}
            </span>
            {spec && <span className="acard__cat">{CATEGORY_LABELS[spec.category]}</span>}
            <button type="button" className="acard__menu-btn" aria-label="Action menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              ⋯
            </button>
          </div>
          {menu && (
            <div className="acard__menu" role="menu" ref={menuRef}>
              <button type="button" role="menuitem" onClick={() => run("duplicate")}>
                Duplicate <Kbd keys="⌘D" />
              </button>
              <button type="button" role="menuitem" onClick={() => run("toggle")}>
                {action.disabled ? "Enable" : "Disable"}
              </button>
              <button type="button" role="menuitem" disabled={isFirst} onClick={() => run("up")}>
                Move Up
              </button>
              <button type="button" role="menuitem" disabled={isLast} onClick={() => run("down")}>
                Move Down
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => run("delete")}>
                Delete <Kbd keys="⌫" />
              </button>
            </div>
          )}
          {spec && params.length > 0 && (
            <div className="acard__params">
              {params.map((p) => (
                <ParamEditor
                  key={p.key}
                  param={p}
                  value={action.params[p.key] ?? ""}
                  onChange={(v) => ed.setParam(path, p.key, v)}
                  variables={variables}
                  apps={ed.apps}
                  mono={MONO_PARAMS.has(`${action.type}:${p.key}`)}
                />
              ))}
            </div>
          )}
          {!spec && (
            <div className="faint">
              {action.type === "feature" ? `Action “${action.params.feature ?? "?"}.${action.params.action ?? "?"}” is not available — is that feature installed?` : `Unknown action type “${action.type}”.`}
            </div>
          )}
          {action.type === "condition" && (
            <div className="branches">
              <Branch label="Then" container={[...path, "then"]} actions={action.then ?? []} />
              <Branch label="Else" container={[...path, "else"]} actions={action.else ?? []} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Branch({ label, container, actions }: { label: string; container: Path; actions: WorkflowAction[] }) {
  const ed = useEditor();
  return (
    <div className="branch">
      <div className="branch__label">
        <span>{label}</span>
        <button type="button" className="addbtn" onClick={() => ed.addAt(container, actions.length)}>
          + Add
        </button>
      </div>
      {actions.length === 0 && !ed.dragging && <div className="branch__empty">No actions — drop one here or press + Add</div>}
      <ActionStack actions={actions} container={container} />
    </div>
  );
}
