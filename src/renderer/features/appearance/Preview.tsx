import type { CSSProperties } from "react";
import { themeTokens, type AppearanceSettings, type ThemePreset } from "../../../main/features/appearance/themes";

/** Scoped CSS variables so a subtree renders in another theme than the window. */
export function themeStyle(preset: ThemePreset, settings: AppearanceSettings): CSSProperties {
  return { ...(themeTokens(preset, settings) as CSSProperties), colorScheme: preset.scheme };
}

const ROWS = [
  { icon: "🧭", title: "Safari", sub: "Application", kind: "App" },
  { icon: "☀️", title: "Morning Setup", sub: "Open Calendar and Notes", kind: "Workflow" },
  { icon: "📋", title: "Clipboard History", sub: "42 items", kind: "Clipboard" },
];

/** A miniature launcher painted with `preset` (used by the theme cards and the live preview). */
export function MiniLauncher({ preset, settings, size = "card" }: { preset: ThemePreset; settings: AppearanceSettings; size?: "card" | "large" }) {
  return (
    <div className={`appearance-mini appearance-mini--${size}`} style={themeStyle(preset, settings)} aria-hidden="true">
      <div className="appearance-mini__panel">
        <div className="appearance-mini__head">
          <span className="appearance-mini__caret" />
          <span className="appearance-mini__query">
            <mark>Sa</mark>fari
          </span>
        </div>
        <div className="appearance-mini__section">Results</div>
        {ROWS.slice(0, size === "card" ? 2 : 3).map((r, i) => (
          <div key={r.title} className={`appearance-mini__row ${i === 0 ? "appearance-mini__row--sel" : ""}`}>
            <span className="appearance-mini__icon">{r.icon}</span>
            <span className="appearance-mini__title">{r.title}</span>
            {size === "large" && <span className="appearance-mini__sub">{r.sub}</span>}
            <span className="appearance-mini__kind">{r.kind}</span>
          </div>
        ))}
        {size === "large" && (
          <div className="appearance-mini__foot">
            <span className="appearance-mini__dot" />
            <span>Open Application</span>
            <span className="kbd">⏎</span>
            <span className="appearance-mini__sep" />
            <span>Actions</span>
            <span className="kbd">⌘K</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function Swatches({ preset, accent }: { preset: ThemePreset; accent?: string }) {
  const colors = [preset.bg, preset.surface2, preset.text3, preset.text, accent || preset.accent];
  return (
    <span className="appearance-swatches" aria-hidden="true">
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </span>
  );
}
