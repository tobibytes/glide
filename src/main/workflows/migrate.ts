/**
 * Normalises stored workflow actions before a run. Workflows saved before feature actions existed
 * pass through untouched (same object references). Accepted variants of a feature action:
 *   { type: "feature", params: { feature, action, ...params } }            (canonical)
 *   { type: "feature", feature, action, params: { ... } }                  (object form)
 *   { type: "feature:<feature>.<action>", params }                          (compact form)
 */
import type { ActionType, Workflow, WorkflowAction } from "@shared/types";
import { ACTION_PARAM, FEATURE_PARAM } from "./feature-actions";

type LooseAction = WorkflowAction & { feature?: unknown; action?: unknown };

const COMPACT = /^feature:([\w-]+)\.([\w.-]+)$/;

export function migrateAction(a: WorkflowAction): WorkflowAction {
  const loose = a as LooseAction;
  let next: WorkflowAction = a;
  const type = a.type as string;
  const compact = COMPACT.exec(type);
  if (compact) {
    next = { ...a, type: "feature", params: { ...(a.params ?? {}), [FEATURE_PARAM]: compact[1], [ACTION_PARAM]: compact[2] } };
  } else if (type === "feature" && (typeof loose.feature === "string" || typeof loose.action === "string")) {
    const { feature, action, ...rest } = loose;
    next = {
      ...rest,
      type: "feature" as ActionType,
      params: {
        ...(a.params ?? {}),
        ...(typeof feature === "string" ? { [FEATURE_PARAM]: feature } : {}),
        ...(typeof action === "string" ? { [ACTION_PARAM]: action } : {}),
      },
    };
  } else if (!a.params) {
    next = { ...a, params: {} };
  }
  const then = a.then ? migrateList(a.then) : undefined;
  const els = a.else ? migrateList(a.else) : undefined;
  if (then !== a.then || els !== a.else) next = { ...next, then, else: els };
  return next;
}

function migrateList(list: WorkflowAction[]): WorkflowAction[] {
  let changed = false;
  const out = list.map((a) => {
    const m = migrateAction(a);
    if (m !== a) changed = true;
    return m;
  });
  return changed ? out : list;
}

/** Returns `wf` itself when nothing needed migrating. */
export function migrateWorkflow(wf: Workflow): Workflow {
  const actions = migrateList(wf.actions ?? []);
  return actions === wf.actions ? wf : { ...wf, actions };
}
