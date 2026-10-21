import { useState } from "react";
import { accelToDisplay, eventToAccelerator } from "../lib/keys";

interface Props {
  value: string | undefined;
  onChange: (accel: string | null) => void;
  placeholder?: string;
  id?: string;
  autoFocus?: boolean;
}

/** Focus, press a combination; stores an Electron accelerator ("Alt+Space"), shows glyphs ("⌥ Space"). */
export function HotkeyRecorder({ value, onChange, placeholder = "Record shortcut", id, autoFocus }: Props) {
  const [recording, setRecording] = useState(false);
  return (
    <div
      id={id}
      role="button"
      tabIndex={0}
      autoFocus={autoFocus}
      className={`hotkey ${recording ? "hotkey--recording" : ""}`}
      aria-label={value ? `Hotkey ${accelToDisplay(value)}` : placeholder}
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (e.key === "Tab") return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          (e.currentTarget as HTMLElement).blur();
          return;
        }
        if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
          onChange(null);
          return;
        }
        const accel = eventToAccelerator(e);
        if (accel) onChange(accel);
      }}
    >
      <span className={`hotkey__value ${!value ? "hotkey__value--empty" : ""}`}>{value ? accelToDisplay(value) : recording ? "Press keys…" : placeholder}</span>
      {value && (
        <button
          type="button"
          className="hotkey__clear"
          aria-label="Clear hotkey"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(null)}
        >
          ✕
        </button>
      )}
    </div>
  );
}
