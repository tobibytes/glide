/**
 * Spec lookup that understands feature actions: every feature action has type "feature", so the
 * spec is picked by params.feature + params.action. Use these instead of `specs.find(s => s.type === a.type)`.
 */
import type { ActionSpec, WorkflowAction } from "./types";

/** Unique key of a spec (React keys, de-duplication): the type, or "feature:<feature>.<action>". */
export function specKey(spec: Pick<ActionSpec, "type" | "feature" | "action">): string {
  return spec.type === "feature" ? `feature:${spec.feature ?? ""}.${spec.action ?? ""}` : spec.type;
}

export function specForAction(specs: readonly ActionSpec[], action: Pick<WorkflowAction, "type" | "params">): ActionSpec | undefined {
  if (action.type !== "feature") return specs.find((s) => s.type === action.type);
  const feature = action.params?.feature;
  const id = action.params?.action;
  return specs.find((s) => s.type === "feature" && s.feature === feature && s.action === id);
}

/** Params shown in the editor (hidden ones such as feature/action are stored but not edited). */
export function visibleParams(spec: ActionSpec): ActionSpec["params"] {
  return spec.params.filter((p) => p.kind !== "hidden");
}
