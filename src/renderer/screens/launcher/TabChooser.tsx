import { Kbd } from "../../components/Kbd";
import type { TabChoice } from "./tabChoice";

const ICONS: Record<TabChoice["id"], string> = { ai: "✨", agent: "🪄", fallback: "↗" };

/** Small popover under the search field; keys are handled by the launcher (↑↓ / ⇥ / 1-3 / ⏎ / ⎋). */
export function TabChooser({ options, index, query, onPick }: { options: TabChoice[]; index: number; query: string; onPick: (i: number) => void }) {
  return (
    <div className="tabchooser" role="listbox" aria-label="Send query to">
      <div className="tabchooser__head">
        Send “<span className="tabchooser__query">{query}</span>” to
      </div>
      {options.map((o, i) => (
        <div key={o.id} role="option" aria-selected={i === index} data-choice={o.id} className={`tabchooser__opt ${i === index ? "tabchooser__opt--on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(i)}>
          <span className="tabchooser__icon" aria-hidden="true">
            {ICONS[o.id]}
          </span>
          <span className="tabchooser__title">{o.title}</span>
          {o.subtitle && <span className="tabchooser__sub">{o.subtitle}</span>}
          <Kbd keys={String(i + 1)} />
        </div>
      ))}
      <div className="tabchooser__foot">
        <Kbd keys="⏎" /> choose · <Kbd keys="⇥" /> next · <Kbd keys="⎋" /> cancel · remembers your last choice
      </div>
    </div>
  );
}
