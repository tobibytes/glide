import { useState } from "react";
import type { UserData } from "@shared/types";
import { glide } from "../../lib/glide";
import { navigateTo } from "../../lib/route";
import { accelToDisplay } from "../../lib/keys";
import { countActions } from "../../lib/workflowTree";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { Toast, useToast } from "../../components/Toast";

export function WorkflowsPage({ data }: { data: UserData }) {
  const { toast, show } = useToast();
  const [running, setRunning] = useState<string | null>(null);

  const run = async (id: string, name: string, acceptsInput: boolean | undefined) => {
    let input: string | undefined;
    if (acceptsInput) {
      const v = prompt(`Input for “${name}”`);
      if (v === null) return;
      input = v;
    }
    setRunning(id);
    try {
      const res = await glide().runWorkflow(id, input);
      show(res.ok ? `“${name}” finished` : `“${name}” failed: ${res.log.find((l) => l.error)?.error ?? "unknown error"}`, res.ok ? "info" : "error");
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="page" style={{ position: "relative" }}>
      <div className="page__head">
        <p className="page__lead" style={{ margin: 0 }}>
          Chain actions together and run them from the launcher, a hotkey, or an alias.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => navigateTo("workflows", "new")}>
          New Workflow
        </button>
      </div>
      <div className="table">
        {data.workflows.length === 0 && <div className="empty">No workflows yet. Create one to get started.</div>}
        {data.workflows.map((w) => (
          <div key={w.id} className="trow" onDoubleClick={() => navigateTo("workflows", w.id)}>
            <Icon icon={w.icon} size="lg" />
            <div className="trow__main">
              <div className="trow__title">
                {w.name || "Untitled"}
                {w.alias && <span className="tag tag--accent">{w.alias}</span>}
                {w.acceptsInput && <span className="tag">input</span>}
              </div>
              <div className="trow__sub">{w.description || `${countActions(w.actions)} actions`}</div>
            </div>
            <div className="trow__meta">
              {w.hotkey && <Kbd keys={accelToDisplay(w.hotkey)} />}
              <span>{countActions(w.actions)} {countActions(w.actions) === 1 ? "action" : "actions"}</span>
            </div>
            <div className="trow__actions">
              <button type="button" className="btn btn--sm" disabled={running === w.id} onClick={() => void run(w.id, w.name, w.acceptsInput)}>
                {running === w.id ? "Running…" : "Run"}
              </button>
              <button type="button" className="btn btn--sm" onClick={() => navigateTo("workflows", w.id)}>
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>
      <Toast toast={toast} />
    </div>
  );
}
