import type { ActionSpec, ActionType, Workflow, WorkflowAction } from "@shared/types";

/**
 * Path addressing for the nested action tree.
 * A container path is [] (root) or [...actionPath, "then" | "else"].
 * An action path is [...containerPath, index].
 */
export type PathSeg = number | "then" | "else";
export type Path = PathSeg[];

export const pathKey = (p: Path): string => p.join("/");
export const parsePath = (k: string): Path => (k === "" ? [] : k.split("/").map((s) => (s === "then" || s === "else" ? s : Number(s))));

export function newActionId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createAction(spec: ActionSpec): WorkflowAction {
  const params: Record<string, string> = {};
  for (const p of spec.params) if (p.default !== undefined) params[p.key] = p.default;
  const a: WorkflowAction = { id: newActionId(), type: spec.type, params };
  if (spec.type === "condition") {
    a.then = [];
    a.else = [];
  }
  return a;
}

export function cloneAction(a: WorkflowAction): WorkflowAction {
  return {
    ...a,
    id: newActionId(),
    params: { ...a.params },
    then: a.then?.map(cloneAction),
    else: a.else?.map(cloneAction),
  };
}

/** Return the list at a container path (immutable read). */
export function getContainer(root: WorkflowAction[], container: Path): WorkflowAction[] {
  let list = root;
  for (let i = 0; i < container.length; i += 2) {
    const idx = container[i];
    const branch = container[i + 1];
    if (typeof idx !== "number" || (branch !== "then" && branch !== "else")) return [];
    const node = list[idx];
    if (!node) return [];
    list = node[branch] ?? [];
  }
  return list;
}

export function getAction(root: WorkflowAction[], path: Path): WorkflowAction | undefined {
  const idx = path[path.length - 1];
  if (typeof idx !== "number") return undefined;
  return getContainer(root, path.slice(0, -1))[idx];
}

/** Immutably replace the list at a container path. */
export function setContainer(root: WorkflowAction[], container: Path, next: WorkflowAction[]): WorkflowAction[] {
  if (container.length === 0) return next;
  const idx = container[0];
  const branch = container[1];
  if (typeof idx !== "number" || (branch !== "then" && branch !== "else")) return root;
  return root.map((a, i) => (i === idx ? { ...a, [branch]: setContainer(a[branch] ?? [], container.slice(2), next) } : a));
}

export function updateAction(root: WorkflowAction[], path: Path, fn: (a: WorkflowAction) => WorkflowAction): WorkflowAction[] {
  const container = path.slice(0, -1);
  const idx = path[path.length - 1];
  if (typeof idx !== "number") return root;
  const list = getContainer(root, container);
  if (!list[idx]) return root;
  return setContainer(root, container, list.map((a, i) => (i === idx ? fn(a) : a)));
}

export function removeAction(root: WorkflowAction[], path: Path): WorkflowAction[] {
  const container = path.slice(0, -1);
  const idx = path[path.length - 1];
  if (typeof idx !== "number") return root;
  const list = getContainer(root, container);
  return setContainer(root, container, list.filter((_, i) => i !== idx));
}

export function insertAction(root: WorkflowAction[], container: Path, index: number, action: WorkflowAction): WorkflowAction[] {
  const list = getContainer(root, container);
  const i = Math.max(0, Math.min(index, list.length));
  return setContainer(root, container, [...list.slice(0, i), action, ...list.slice(i)]);
}

/** True when `candidate` is inside (or equal to) `ancestor`. */
export function isWithin(candidate: Path, ancestor: Path): boolean {
  if (candidate.length < ancestor.length) return false;
  return ancestor.every((seg, i) => candidate[i] === seg);
}

/** Move an action to a new container/index. Returns the root and the new path of the moved action. */
export function moveAction(root: WorkflowAction[], from: Path, toContainer: Path, toIndex: number): { root: WorkflowAction[]; path: Path } {
  const action = getAction(root, from);
  if (!action || isWithin(toContainer, from)) return { root, path: from };
  const fromContainer = from.slice(0, -1);
  const fromIdx = from[from.length - 1] as number;
  let idx = toIndex;
  // Same container and moving downward: the removal shifts later indices.
  if (pathKey(fromContainer) === pathKey(toContainer) && fromIdx < toIndex) idx -= 1;
  const withoutSource = removeAction(root, from);
  // If the target container sits after the removed node in the same parent list, its index shifted.
  let target = toContainer;
  if (toContainer.length > fromContainer.length && isWithin(toContainer, fromContainer)) {
    const siblingIdx = toContainer[fromContainer.length];
    if (typeof siblingIdx === "number" && siblingIdx > fromIdx) {
      target = [...toContainer];
      target[fromContainer.length] = siblingIdx - 1;
    }
  }
  const next = insertAction(withoutSource, target, idx, action);
  return { root: next, path: [...target, idx] };
}

/** Pre-order traversal with paths. */
export function walk(root: WorkflowAction[], visit: (a: WorkflowAction, path: Path) => void, base: Path = []): void {
  root.forEach((a, i) => {
    const p = [...base, i];
    visit(a, p);
    if (a.then) walk(a.then, visit, [...p, "then"]);
    if (a.else) walk(a.else, visit, [...p, "else"]);
  });
}

export function countActions(root: WorkflowAction[]): number {
  let n = 0;
  walk(root, () => n++);
  return n;
}

export const BUILTIN_VARIABLES: Array<{ name: string; hint: string }> = [
  { name: "input", hint: "Launcher argument or last Ask for Input answer" },
  { name: "clipboard", hint: "Current clipboard text" },
  { name: "result", hint: "Output of the previous action" },
  { name: "date", hint: "Today's date" },
  { name: "time", hint: "Current time" },
  { name: "timestamp", hint: "Unix timestamp" },
  { name: "selection", hint: "Selected text (if available)" },
];

/** Variables available to the action at `path`: builtins + outputs of earlier actions. */
export function availableVariables(root: WorkflowAction[], path: Path, specs: ActionSpec[]): Array<{ name: string; hint: string }> {
  const out = [...BUILTIN_VARIABLES];
  const seen = new Set(out.map((v) => v.name));
  const target = pathKey(path);
  let reached = false;
  walk(root, (a, p) => {
    if (pathKey(p) === target) reached = true;
    if (reached) return;
    const spec = specs.find((s) => s.type === a.type);
    if (a.type === "setVariable" && a.params.name?.trim()) {
      const name = a.params.name.trim();
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, hint: "Set Variable" });
      }
    } else if (spec?.outputVar && !seen.has(spec.outputVar)) {
      seen.add(spec.outputVar);
      out.push({ name: spec.outputVar, hint: spec.title });
    }
  });
  return out;
}

export const CATEGORY_COLORS: Record<ActionSpec["category"], string> = {
  apps: "#528BFF",
  web: "#2ED3B7",
  text: "#F5A524",
  clipboard: "#9B8AFB",
  scripting: "#98A2B3",
  control: "#F670C7",
  system: "#F97066",
};

export const CATEGORY_LABELS: Record<ActionSpec["category"], string> = {
  apps: "Apps",
  web: "Web",
  text: "Text",
  clipboard: "Clipboard",
  scripting: "Scripting",
  control: "Control Flow",
  system: "System",
};

export function emptyWorkflow(): Workflow {
  const now = Date.now();
  return { id: "", name: "", description: "", icon: { kind: "emoji", value: "🧩" }, actions: [], createdAt: now, updatedAt: now };
}

export function actionTitle(a: WorkflowAction, specs: ActionSpec[]): string {
  return a.label || specs.find((s) => s.type === a.type)?.title || (a.type as ActionType);
}
