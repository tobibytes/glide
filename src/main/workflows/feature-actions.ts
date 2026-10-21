/**
 * Registry of workflow actions contributed by feature modules. A feature lists them in
 * FeatureModule.workflowActions (or calls ctx.registerWorkflowAction); the host binds each to
 * the feature's context. They appear in the editor's action library as ActionSpecs of type
 * "feature" and run as WorkflowAction { type: "feature", params: { feature, action, ...params } }.
 */
import type { ActionSpec, ItemIcon } from "@shared/types";
import { ACTION_SPECS } from "./specs";

export type ActionParamSpec = ActionSpec["params"][number];

/** What run() may return: the text for {{result}}, or that plus extra variables. */
export type FeatureActionOutput = string | undefined | void | { result?: string; vars?: Record<string, string> };

export interface FeatureWorkflowAction<C = unknown> {
  /** Unique within the feature, e.g. "upper" or "start". */
  id: string;
  title: string;
  description?: string;
  icon?: ItemIcon;
  /** Library group (default "system"). */
  category?: ActionSpec["category"];
  params?: ActionParamSpec[];
  /** Also store the result as {{<outputVar>}}. */
  outputVar?: string;
  /**
   * `params` are the action's params after {{variable}} substitution (without feature/action);
   * `vars` is a read-only snapshot of the run's variables. Throw to fail the step.
   */
  run(ctx: C, params: Record<string, string>, vars: Readonly<Record<string, string>>): FeatureActionOutput | Promise<FeatureActionOutput>;
}

interface Entry {
  feature: string;
  spec: ActionSpec;
  run(params: Record<string, string>, vars: Readonly<Record<string, string>>): Promise<FeatureActionOutput>;
}

const entries = new Map<string, Entry>();
const keyOf = (feature: string, action: string) => `${feature}.${action}`;
export const FEATURE_PARAM = "feature";
export const ACTION_PARAM = "action";
const RESERVED = new Set([FEATURE_PARAM, ACTION_PARAM]);

export function specOf(feature: string, def: FeatureWorkflowAction<never>): ActionSpec {
  return {
    type: "feature",
    feature,
    action: def.id,
    title: def.title,
    description: def.description ?? "",
    icon: def.icon ?? { kind: "emoji", value: "🧩" },
    category: def.category ?? "system",
    params: [
      { key: FEATURE_PARAM, label: "Feature", kind: "hidden", default: feature },
      { key: ACTION_PARAM, label: "Action", kind: "hidden", default: def.id },
      ...(def.params ?? []).filter((p) => !RESERVED.has(p.key)),
    ],
    outputVar: def.outputVar,
  };
}

/** Register (or replace) a feature action bound to `ctx`; returns an unregister function. */
export function registerFeatureAction<C>(feature: string, def: FeatureWorkflowAction<C>, ctx: C): () => void {
  if (!feature || !def.id) throw new Error("A workflow action needs a feature id and an action id");
  const key = keyOf(feature, def.id);
  const entry: Entry = {
    feature,
    spec: specOf(feature, def as FeatureWorkflowAction<never>),
    run: async (params, vars) => def.run(ctx, params, vars),
  };
  entries.set(key, entry);
  return () => {
    if (entries.get(key) === entry) entries.delete(key);
  };
}

export function featureActionSpecs(): ActionSpec[] {
  return [...entries.values()].map((e) => e.spec);
}

/** Built-in specs followed by every registered feature action (what the editor's library lists). */
export function allActionSpecs(): ActionSpec[] {
  return [...ACTION_SPECS, ...featureActionSpecs()];
}

export function hasFeatureAction(feature: string, action: string): boolean {
  return entries.has(keyOf(feature, action));
}

export interface FeatureActionRun {
  result: string | undefined;
  vars: Record<string, string>;
  outputVar?: string;
}

export async function runFeatureAction(params: Record<string, string>, vars: Readonly<Record<string, string>>): Promise<FeatureActionRun> {
  const feature = params[FEATURE_PARAM] ?? "";
  const action = params[ACTION_PARAM] ?? "";
  const entry = entries.get(keyOf(feature, action));
  if (!entry) throw new Error(feature && action ? `Action “${feature}.${action}” is not available (is the ${feature} feature installed?)` : "Feature action is missing its feature/action");
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (!RESERVED.has(k)) rest[k] = v;
  // Fill defaults for params the stored action predates.
  for (const p of entry.spec.params) if (!RESERVED.has(p.key) && rest[p.key] === undefined && p.default !== undefined) rest[p.key] = p.default;
  const out = await entry.run(rest, vars);
  if (out === undefined || typeof out === "string") return { result: out ?? undefined, vars: {}, outputVar: entry.spec.outputVar };
  return { result: out.result, vars: out.vars ?? {}, outputVar: entry.spec.outputVar };
}

/** Tests only. */
export function clearFeatureActions(): void {
  entries.clear();
}
