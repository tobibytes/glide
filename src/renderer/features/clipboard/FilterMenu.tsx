/** ⌘P dropdown: content type + source app. Owns the keyboard while open (↑↓ / ⌃J⌃K / j k, ⏎, ⎋). */
import { useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "../../components/Kbd";
import { FILTERS, type ClipFilter, type SourceSummary } from "./api";

type Option = { kind: "type"; id: ClipFilter; label: string } | { kind: "source"; id: string | null; label: string; count?: number };

interface Props {
  type: ClipFilter;
  source: string | null;
  sources: SourceSummary[];
  onPick(next: { type?: ClipFilter; source?: string | null }): void;
  onClose(): void;
}

export function FilterMenu({ type, source, sources, onPick, onClose }: Props) {
  const options = useMemo<Option[]>(
    () => [
      ...FILTERS.map((f): Option => ({ kind: "type", id: f.id, label: f.label })),
      { kind: "source", id: null, label: "Any App" },
      ...sources.map((s): Option => ({ kind: "source", id: s.key, label: s.name, count: s.count })),
    ],
    [sources],
  );
  const initial = Math.max(0, options.findIndex((o) => o.kind === "type" && o.id === type));
  const [index, setIndex] = useState(initial);
  const listRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ options, index, onPick, onClose });
  latest.current = { options, index, onPick, onClose };

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useEffect(() => {
    const pick = (o: Option) => latest.current.onPick(o.kind === "type" ? { type: o.id } : { source: o.id });
    const onKey = (e: KeyboardEvent) => {
      const cur = latest.current;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      let d = 0;
      if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "j" || e.key === "n")) || (plain && e.key === "j")) d = 1;
      else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "k" || e.key === "p")) || (plain && e.key === "k")) d = -1;
      else if (e.key === "Enter") {
        const o = cur.options[cur.index];
        if (o) pick(o);
      } else if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "p")) cur.onClose();
      else if (e.key === "Tab") {
        // Jump between the type and source-app groups.
        const inSource = cur.options[cur.index]?.kind === "source";
        setIndex(inSource ? 0 : cur.options.findIndex((o) => o.kind === "source"));
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (d) setIndex((i) => Math.min(cur.options.length - 1, Math.max(0, i + d)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const firstSource = options.findIndex((o) => o.kind === "source");
  return (
    <div className="clipboard-filtermenu" role="listbox" aria-label="Filter clipboard history" ref={listRef}>
      <div className="clipboard-filtermenu__head">
        Content type <Kbd keys="⇥" /> apps
      </div>
      {options.map((o, i) => {
        const active = o.kind === "type" ? o.id === type : o.id === source;
        return (
          <div key={`${o.kind}:${o.id ?? "*"}`}>
            {i === firstSource && <div className="clipboard-filtermenu__head">Source app</div>}
            <div
              role="option"
              aria-selected={i === index}
              className={`clipboard-filtermenu__item ${i === index ? "clipboard-filtermenu__item--sel" : ""}`}
              onMouseMove={() => i !== index && setIndex(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(o.kind === "type" ? { type: o.id } : { source: o.id })}
            >
              <span className="clipboard-filtermenu__check">{active ? "✓" : ""}</span>
              <span className="clipboard-filtermenu__label">{o.label}</span>
              {o.kind === "source" && o.count !== undefined && <span className="clipboard-filtermenu__count">{o.count}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
