import { useEffect, useRef, useState } from "react";
import type { ItemIcon } from "@shared/types";
import { COLOR_CHOICES, EMOJI_CHOICES } from "../lib/icons";
import { Icon } from "./Icon";

interface Props {
  value: ItemIcon;
  onChange: (icon: ItemIcon) => void;
  size?: "lg" | "xl";
}

/** Emoji grid + color swatches in a popover. */
export function IconPicker({ value, onChange, size = "xl" }: Props) {
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
    <div className="iconpicker" ref={ref}>
      <button type="button" className="btn btn--ghost iconpicker__btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Change icon">
        <Icon icon={value} size={size} />
      </button>
      {open && (
        <div className="iconpicker__pop" role="dialog" aria-label="Choose icon">
          <div className="iconpicker__title">Color</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {COLOR_CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                className={`iconpicker__swatch ${value.kind === "color" && value.value === c ? "iconpicker__swatch--on" : ""}`}
                style={{ background: c }}
                aria-label={`Color ${c}`}
                onClick={() => {
                  onChange({ kind: "color", value: c });
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <div className="iconpicker__title" style={{ marginTop: 10 }}>
            Emoji
          </div>
          <div className="iconpicker__grid">
            {EMOJI_CHOICES.map((e) => (
              <button
                key={e}
                type="button"
                className={`iconpicker__cell ${value.kind === "emoji" && value.value === e ? "iconpicker__cell--on" : ""}`}
                onClick={() => {
                  onChange({ kind: "emoji", value: e });
                  setOpen(false);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
