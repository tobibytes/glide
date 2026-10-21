import { useEffect, useRef, useState } from "react";

interface Props {
  variables: Array<{ name: string; hint: string }>;
  onInsert: (name: string) => void;
}

/** "{{ }}" button that lists available variables and inserts {{name}}. */
export function VariableMenu({ variables, onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="varmenu-wrap" ref={ref}>
      <button type="button" className="varbtn" title="Insert variable" aria-haspopup="menu" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)}>
        {"{{ }}"}
      </button>
      {open && (
        <div className="varmenu" role="menu">
          {variables.map((v) => (
            <button
              key={v.name}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onInsert(v.name);
                setOpen(false);
              }}
            >
              <span className="varmenu__name">{`{{${v.name}}}`}</span>
              <span className="varmenu__hint">{v.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
