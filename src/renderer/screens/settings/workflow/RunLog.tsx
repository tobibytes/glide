import type { ActionSpec, RunResult, WorkflowAction } from "@shared/types";
import { walk } from "../../../lib/workflowTree";

export function RunLog({ result, actions, specs, running }: { result: RunResult | null; actions: WorkflowAction[]; specs: ActionSpec[]; running: boolean }) {
  if (running && !result) return <div className="empty">Running…</div>;
  if (!result) return <div className="empty">Run the workflow to see each action's status, duration and output here.</div>;
  const titles = new Map<string, string>();
  walk(actions, (a) => titles.set(a.id, a.label || specs.find((s) => s.type === a.type)?.title || a.type));
  const total = result.log.reduce((n, e) => n + (e.endedAt - e.startedAt), 0);
  return (
    <div className="runlog">
      <div className="runlog__summary">
        <span>
          <span className={`status status--${result.ok ? "ok" : "error"}`}>{result.ok ? "Finished" : "Failed"}</span>
        </span>
        <span>{result.log.length} steps · {total} ms</span>
      </div>
      {result.log.map((e, i) => (
        <div key={`${e.actionId}-${i}`} className="rentry">
          <div className="rentry__head">
            <span className={`status status--${e.status}`}>{e.status}</span>
            <span className="rentry__title">{titles.get(e.actionId) ?? e.type}</span>
            <span className="rentry__ms">{e.endedAt - e.startedAt} ms</span>
          </div>
          {e.error && <pre className="rentry__out rentry__out--err">{e.error}</pre>}
          {!e.error && e.output && <pre className="rentry__out">{e.output}</pre>}
        </div>
      ))}
      {result.result && (
        <div className="rentry">
          <div className="rentry__head">
            <span className="rentry__title">Result</span>
          </div>
          <pre className="rentry__out">{result.result}</pre>
        </div>
      )}
    </div>
  );
}
