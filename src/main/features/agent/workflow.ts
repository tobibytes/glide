/**
 * "Save as Workflow": turns the steps an agent run carried out into a Glide workflow. Only works
 * when every state-changing step has a workflow action equivalent; lookups are dropped.
 */
import type { UserData, Workflow, WorkflowAction } from "@shared/types";
import { runItemStep } from "./tooling";
import { PLAN_TOOL, type WorkflowStep } from "./tools";
import type { AgentStep } from "./types";

export interface ExecutedStep {
  step: AgentStep;
  workflow?: WorkflowStep[];
}

export type WorkflowPlan = { ok: true; actions: WorkflowStep[] } | { ok: false; error: string; unmapped: string[] };

/** Steps that count: ran successfully, changed something, and weren't undone afterwards. */
export function planWorkflow(executed: ExecutedStep[]): WorkflowPlan {
  const relevant = executed.filter((e) => e.step.tool !== PLAN_TOOL && e.step.status === "ok" && e.step.mutating && e.step.undo?.state !== "done");
  if (!relevant.length) return { ok: false, error: "This request didn't change anything, so there is nothing to save.", unmapped: [] };
  const unmapped = relevant.filter((e) => !e.workflow?.length).map((e) => e.step.summary);
  if (unmapped.length)
    return { ok: false, error: `${unmapped.length === 1 ? "One step has" : `${unmapped.length} steps have`} no workflow action yet: ${unmapped.join("; ")}`, unmapped };
  return { ok: true, actions: relevant.flatMap((e) => e.workflow ?? []) };
}

/**
 * Workflow equivalent of running a catalogue item: a native action where one exists (apps,
 * workflows, quicklinks, snippets), else the agent's "Run Glide Command" feature action.
 */
export function itemToWorkflowStep(id: string, argument: string | undefined, data: Pick<UserData, "quicklinks" | "snippets" | "workflows">, title?: string): WorkflowStep | null {
  if (id.startsWith("agent:")) return null;
  const native = nativeStep(id, argument, data);
  return native ?? runItemStep(id, argument, title ? `Run “${title}”` : undefined);
}

function nativeStep(id: string, argument: string | undefined, data: Pick<UserData, "quicklinks" | "snippets" | "workflows">): WorkflowStep | null {
  const [kind, ...rest] = id.split(":");
  const ref = rest.join(":");
  switch (kind) {
    case "app":
      return ref ? { type: "openApp", params: { app: ref } } : null;
    case "workflow":
      return data.workflows.some((w) => w.id === ref) ? { type: "runWorkflow", params: { workflowId: ref, input: argument ?? "" } } : null;
    case "quicklink": {
      const q = data.quicklinks.find((x) => x.id === ref);
      if (!q) return null;
      return { type: "openUrl", params: { url: q.url.replace(/\{query\}/g, encodeURIComponent(argument ?? "")) } };
    }
    case "snippet": {
      const s = data.snippets.find((x) => x.id === ref);
      return s ? { type: "setClipboard", params: { text: s.text } } : null;
    }
    default:
      return null;
  }
}

export function buildWorkflow(name: string, prompt: string, actions: WorkflowStep[], now: number): Workflow {
  const id = `wf-agent-${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const list: WorkflowAction[] = actions.map((a, i) => ({ id: `${id}-a${i + 1}`, type: a.type, params: { ...a.params }, ...(a.label ? { label: a.label } : {}) }));
  return {
    id,
    name: name.trim() || prompt.slice(0, 60) || "Agent Workflow",
    description: `Saved from Glide Agent: “${prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt}”`,
    icon: { kind: "emoji", value: "🪄" },
    keywords: ["agent"],
    actions: list,
    createdAt: now,
    updatedAt: now,
  };
}
