import { useEffect, useRef, useState } from "react";
import { accelToDisplay, eventToAccelerator } from "../lib/keys";

interface Props {
  value: string | undefined;
  onChange: (accel: string | null) => void;
  placeholder?: string;
  id?: string;
  autoFocus?: boolean;
  /** Also record a modifier tapped alone ("Right+Alt") or twice ("Double+Cmd"); needs the native helper. */
  allowModifierOnly?: boolean;
}

const MOD_BY_KEY: Record<string, string> = { Meta: "Cmd", Alt: "Alt", Control: "Ctrl", Shift: "Shift" };
const DOUBLE_TAP_MS = 400;
const TAP_MAX_MS = 600;

/** Focus, press a combination; stores an Electron accelerator ("Alt+Space"), shows glyphs ("⌥ Space"). */
export function HotkeyRecorder({ value, onChange, placeholder = "Record shortcut", id, autoFocus, allowModifierOnly }: Props) {
  const [recording, setRecording] = useState(false);
  // Modifier-only recording: the modifier pressed alone, then the last lone tap (for double taps).
  const lone = useRef<{ mod: string; code: string; at: number } | null>(null);
  const lastTap = useRef<{ mod: string; at: number } | null>(null);
  const commit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTaps = () => {
    lone.current = null;
    lastTap.current = null;
    if (commit.current) clearTimeout(commit.current);
    commit.current = null;
  };
  useEffect(() => cancelTaps, []);
  return (
    <div
      id={id}
      role="button"
      tabIndex={0}
      autoFocus={autoFocus}
      className={`hotkey ${recording ? "hotkey--recording" : ""}`}
      aria-label={value ? `Hotkey ${accelToDisplay(value)}` : placeholder}
      onFocus={() => setRecording(true)}
      onBlur={() => {
        setRecording(false);
        cancelTaps();
      }}
      onKeyUp={(e) => {
        if (!allowModifierOnly) return;
        const mod = MOD_BY_KEY[e.key];
        const l = lone.current;
        lone.current = null;
        if (!mod || !l || l.code !== e.code || e.timeStamp - l.at > TAP_MAX_MS) return;
        e.preventDefault();
        const prev = lastTap.current;
        if (commit.current) clearTimeout(commit.current);
        if (prev && prev.mod === mod && e.timeStamp - prev.at < DOUBLE_TAP_MS) {
          cancelTaps();
          onChange(`Double+${mod}`);
          return;
        }
        lastTap.current = { mod, at: e.timeStamp };
        const side = e.code.endsWith("Right") ? "Right" : "Left";
        // Wait for a possible second tap before committing the single (sided) tap.
        commit.current = setTimeout(() => {
          commit.current = null;
          lastTap.current = null;
          onChange(`${side}+${mod}`);
        }, DOUBLE_TAP_MS);
      }}
      onKeyDown={(e) => {
        if (e.key === "Tab") return;
        if (allowModifierOnly) {
          const mod = MOD_BY_KEY[e.key];
          const others = [e.metaKey && e.key !== "Meta", e.altKey && e.key !== "Alt", e.ctrlKey && e.key !== "Control", e.shiftKey && e.key !== "Shift"].some(Boolean);
          if (mod && !others && !e.repeat) {
            lone.current = { mod, code: e.code, at: e.timeStamp };
          } else if (!mod || others) {
            cancelTaps();
          }
        }
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
