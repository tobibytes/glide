import { memo } from "react";
import type { ScoredItem } from "@shared/types";
import { Icon } from "../../components/Icon";
import { Highlight } from "../../components/Highlight";
import { Kbd } from "../../components/Kbd";
import { kindLabel } from "../../lib/icons";
import { pointerReallyMoved } from "../../lib/pointer";

interface Props {
  scored: ScoredItem;
  selected: boolean;
  rowId: string;
  onHover: () => void;
  onClick: () => void;
}

export const ResultRow = memo(function ResultRow({ scored, selected, rowId, onHover, onClick }: Props) {
  const { item } = scored;
  const isCalc = item.kind === "calculator";
  const cls = ["row", selected ? "row--selected" : "", isCalc ? "row--calc" : "", item.kind === "fallback" ? "row--fallback" : ""].filter(Boolean).join(" ");
  return (
    <div id={rowId} role="option" aria-selected={selected} className={cls} onMouseMove={(e) => pointerReallyMoved(e) && onHover()} onClick={onClick}>
      <Icon icon={item.icon} size={isCalc ? "lg" : "md"} fallback={item.kind === "file" ? "▤" : "▢"} />
      <div className="row__main">
        <span className="row__title">
          <Highlight text={item.title} ranges={scored.ranges} />
        </span>
        {item.subtitle && <span className="row__subtitle">{item.subtitle}</span>}
        {item.alias && <span className="tag tag--accent">{item.alias}</span>}
        {scored.argument && !isCalc && <span className="tag">{scored.argument}</span>}
      </div>
      <div className="row__right">
        {selected && item.hotkey && <span className="row__hotkey"><Kbd keys={item.hotkey} /></span>}
        {item.favorite && <span className="row__star" aria-label="Favorite">★</span>}
        {!isCalc && <span className="row__kind">{kindLabel(item)}</span>}
      </div>
    </div>
  );
});
