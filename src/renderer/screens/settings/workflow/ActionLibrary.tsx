import { useMemo, useState } from "react";
import type { ActionSpec } from "@shared/types";
import { specKey } from "@shared/workflow-specs";
import { CATEGORY_COLORS, CATEGORY_LABELS } from "../../../lib/workflowTree";
import { Icon } from "../../../components/Icon";

const ORDER: ActionSpec["category"][] = ["apps", "web", "text", "clipboard", "scripting", "control", "system"];

export function ActionLibrary({ specs, onPick, hint }: { specs: ActionSpec[]; onPick: (spec: ActionSpec) => void; hint: string }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const f = q.trim().toLowerCase();
    const list = f ? specs.filter((s) => s.title.toLowerCase().includes(f) || s.description.toLowerCase().includes(f) || specKey(s).toLowerCase().includes(f)) : specs;
    return ORDER.map((cat) => ({ cat, items: list.filter((s) => s.category === cat) })).filter((g) => g.items.length);
  }, [specs, q]);
  return (
    <div>
      <input className="input lib__search" placeholder="Search actions…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search actions" />
      <div className="lib__hint">{hint}</div>
      {groups.length === 0 && <div className="empty">No actions match.</div>}
      {groups.map((g) => (
        <div key={g.cat}>
          <div className="lib__cat">{CATEGORY_LABELS[g.cat]}</div>
          {g.items.map((s) => (
            <button key={specKey(s)} type="button" className="lib__item" data-spec={specKey(s)} onClick={() => onPick(s)} title={s.description}>
              <span className="lib__stripe" style={{ background: CATEGORY_COLORS[s.category] }} />
              <Icon icon={s.icon} />
              <span style={{ minWidth: 0 }}>
                <div className="lib__title">{s.title}</div>
                <div className="lib__desc">{s.description}</div>
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
