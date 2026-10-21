import type { RunRecord } from "../../../main/features/automations/model";
import { clock, STATUS_ICON } from "./common";

export function RunLog({ log, limit = 50 }: { log: RunRecord[]; limit?: number }) {
  if (!log.length) return <div className="automations-log__empty">No runs yet.</div>;
  return (
    <ol className="automations-log" aria-label="Run log">
      {log.slice(0, limit).map((r) => (
        <li key={r.id} className={`automations-log__item automations-log__item--${r.status}`}>
          <span aria-label={r.status}>{STATUS_ICON[r.status]}</span>
          <span className="automations-log__when mono">{clock(r.at)}</span>
          <span className="automations-log__msg" title={r.input ? `Input: ${r.input}` : undefined}>
            {r.message}
            <span className="automations-log__why"> · {r.trigger}{r.durationMs >= 1000 ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
