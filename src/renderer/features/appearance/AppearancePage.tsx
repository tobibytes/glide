import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Settings } from "@shared/types";
import { Group, Row, Toggle } from "../../components/form";
import { glide } from "../../lib/glide";
import { DEFAULT_APPEARANCE, LIMITS, normalizeAppearance, PRESETS, resolvePreset, type AppearanceSettings, type ThemePreset } from "../../../main/features/appearance/themes";
import { appearanceApi, type AppearanceState } from "./api";
import { MiniLauncher } from "./Preview";

const ACCENTS = ["#f5a524", "#ff6b5e", "#f472b6", "#bd93f9", "#7c8cff", "#38bdf8", "#2dd4bf", "#4ade80"];
const MODES: Array<{ id: Settings["theme"]; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** Roving radio group: ←/→/↑/↓ (and h/l/j/k) move and select, like macOS segmented controls. */
function useRadioKeys<T>(values: T[], current: T, choose: (v: T) => void, columns = values.length) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const i = Math.max(0, values.indexOf(current));
    const step: Record<string, number> = { ArrowRight: 1, l: 1, ArrowLeft: -1, h: -1, ArrowDown: columns, j: columns, ArrowUp: -columns, k: -columns };
    const d = step[e.key];
    if (d === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const next = Math.min(values.length - 1, Math.max(0, i + d));
    choose(values[next]);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus());
  };
}

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ id: T; label: string }>; value: T; onChange: (v: T) => void }) {
  const onKey = useRadioKeys(
    options.map((o) => o.id),
    value,
    onChange,
  );
  return (
    <div className="appearance-seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} tabIndex={o.id === value ? 0 : -1} className={`appearance-seg__btn ${o.id === value ? "appearance-seg__btn--on" : ""}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ThemeGrid({ label, presets, value, settings, onChange }: { label: string; presets: ThemePreset[]; value: string; settings: AppearanceSettings; onChange: (id: string) => void }) {
  const ids = presets.map((p) => p.id);
  const onKey = useRadioKeys(ids, value, onChange, 3);
  return (
    <div className="appearance-grid" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {presets.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={p.id === value} tabIndex={p.id === value ? 0 : -1} className={`appearance-card ${p.id === value ? "appearance-card--on" : ""}`} onClick={() => onChange(p.id)}>
          <MiniLauncher preset={p} settings={settings} />
          <span className="appearance-card__name">
            {p.name}
            <span className="faint">{p.scheme === "dark" ? "Dark" : "Light"}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Slider({ id, value, range, unit, onChange }: { id: string; value: number; range: readonly [number, number]; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="slider">
      <input id={id} type="range" min={range[0]} max={range[1]} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider__value">
        {value}
        {unit}
      </span>
    </div>
  );
}

export function AppearancePage() {
  const [state, setState] = useState<AppearanceState | null>(null);
  const [draft, setDraft] = useState<AppearanceSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(() => void appearanceApi.get().then((s) => (setState(s), setDraft(normalizeAppearance(s.settings)))), []);
  useEffect(() => {
    load();
    return glide().onDataChanged(() => {
      // Don't clobber a slider mid-drag; the pending save will echo back.
      if (!timer.current) load();
    });
  }, [load]);

  // Local draft updates instantly; saving is throttled so dragging a slider doesn't flood the store.
  const draftRef = useRef<AppearanceSettings | null>(null);
  draftRef.current = draft;
  const patch = useCallback((p: Partial<AppearanceSettings>) => {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, ...p };
    draftRef.current = next;
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void appearanceApi.set(next);
    }, 60);
  }, []);

  if (!state || !draft) return <div className="empty">Loading…</div>;
  const mode = state.mode;
  const active = resolvePreset(mode, state.systemDark, draft);
  const dark = PRESETS.filter((p) => p.scheme === "dark");
  const light = PRESETS.filter((p) => p.scheme === "light");
  const setMode = (m: Settings["theme"]) => void appearanceApi.setMode(m).then(load);

  return (
    <div className="page appearance-page">
      <p className="page__lead">
        Every change applies live to the launcher and all Glide windows. Tab between controls; arrows (or h/j/k/l) move inside a group. From the launcher: “Switch Theme” previews themes as you move with j/k.
      </p>

      <div className="appearance-hero">
        <MiniLauncher preset={active} settings={draft} size="large" />
        <div className="appearance-hero__meta">
          <strong>{active.name}</strong>
          <span className="faint">{mode === "system" ? `Following the system (${state.systemDark ? "dark" : "light"})` : `Always ${mode}`}</span>
        </div>
      </div>

      <Group title="Theme">
        <Row label="Appearance" hint="System switches between your light and dark theme automatically">
          <Segmented label="Appearance mode" options={MODES} value={mode} onChange={setMode} />
        </Row>
        <Row label="Dark theme" align="start">
          <ThemeGrid label="Dark theme" presets={[...dark, ...light]} value={draft.darkTheme} settings={draft} onChange={(id) => patch({ darkTheme: id })} />
        </Row>
        <Row label="Light theme" align="start">
          <ThemeGrid label="Light theme" presets={[...light, ...dark]} value={draft.lightTheme} settings={draft} onChange={(id) => patch({ lightTheme: id })} />
        </Row>
      </Group>

      <Group title="Accent">
        <Row label="Accent color" hint="Selection highlights, matches, toggles and buttons">
          <div className="appearance-accents" role="radiogroup" aria-label="Accent color">
            <button type="button" role="radio" aria-checked={!draft.accent} className={`appearance-accent appearance-accent--auto ${!draft.accent ? "appearance-accent--on" : ""}`} title="Theme default" onClick={() => patch({ accent: "" })}>
              A
            </button>
            {ACCENTS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={draft.accent === c} aria-label={c} className={`appearance-accent ${draft.accent === c ? "appearance-accent--on" : ""}`} style={{ background: c }} onClick={() => patch({ accent: c })} />
            ))}
            <label className="appearance-accent appearance-accent--custom" title="Custom color">
              <input type="color" aria-label="Custom accent color" value={draft.accent || active.accent} onChange={(e) => patch({ accent: e.target.value })} />
            </label>
          </div>
        </Row>
      </Group>

      <Group title="Layout">
        <Row label="Density">
          <Segmented<AppearanceSettings["density"]>
            label="Density"
            options={[
              { id: "compact", label: "Compact" },
              { id: "comfortable", label: "Comfortable" },
            ]}
            value={draft.density}
            onChange={(v) => patch({ density: v })}
          />
        </Row>
        <Row label="Text size" htmlFor="ap-font">
          <Slider id="ap-font" value={draft.fontSize} range={LIMITS.fontSize} unit=" px" onChange={(v) => patch({ fontSize: v })} />
        </Row>
        <Row label="Corner radius" htmlFor="ap-radius">
          <Slider id="ap-radius" value={draft.radius} range={LIMITS.radius} unit=" px" onChange={(v) => patch({ radius: v })} />
        </Row>
        <Row label="Launcher width" htmlFor="ap-width">
          <Slider id="ap-width" value={draft.width} range={LIMITS.width} unit=" px" onChange={(v) => patch({ width: Math.round(v / 10) * 10 })} />
        </Row>
      </Group>

      <Group title="Window" footer="Vibrancy blurs the desktop behind the launcher (macOS). With translucency at 0 the panel is opaque and vibrancy is turned off.">
        <Row label="Translucency" htmlFor="ap-trans">
          <Slider id="ap-trans" value={draft.translucency} range={LIMITS.translucency} unit="%" onChange={(v) => patch({ translucency: v })} />
        </Row>
        <Row label="Vibrancy">
          <Toggle label="Vibrancy" checked={draft.vibrancy} onChange={(v) => patch({ vibrancy: v })} />
        </Row>
        <Row label="Animations" hint="Always off when macOS “Reduce motion” is on">
          <Toggle label="Animations" checked={draft.animations} onChange={(v) => patch({ animations: v })} />
        </Row>
      </Group>

      <div className="appearance-reset">
        <button type="button" className="btn" onClick={() => void appearanceApi.reset().then(load)} disabled={JSON.stringify(draft) === JSON.stringify(DEFAULT_APPEARANCE)}>
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
