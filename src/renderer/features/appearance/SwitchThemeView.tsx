import { useCallback, useEffect, useMemo, useState } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { glide } from "../../lib/glide";
import { normalizeAppearance, PRESETS, resolvePreset, type ThemePreset } from "../../../main/features/appearance/themes";
import { appearanceApi, type AppearanceState } from "./api";
import { MiniLauncher } from "./Preview";
import { setThemePreview } from "./useAppearance";

type Row = NavItem & { preset: ThemePreset };

/** "Switch Theme": moving the selection (j/k, ↑/↓) previews the theme on the launcher itself; ⏎ keeps it. */
export function SwitchThemeView({ query, setPlaceholder, toast, pop }: ViewProps) {
  const [state, setState] = useState<AppearanceState | null>(null);
  const load = useCallback(() => void appearanceApi.get().then(setState), []);

  useEffect(() => setPlaceholder("Search themes… (moving the selection previews it)"), [setPlaceholder]);
  useEffect(() => {
    load();
    const off = glide().onDataChanged(load);
    return () => {
      off();
      setThemePreview(null);
    };
  }, [load]);

  const settings = state ? normalizeAppearance(state.settings) : null;
  const active = state && settings ? resolvePreset(state.mode, state.systemDark, settings) : null;

  const rows = useMemo((): Row[] => {
    const q = query.trim().toLowerCase();
    const list = PRESETS.filter((p) => !q || p.name.toLowerCase().includes(q) || p.scheme.includes(q));
    // The active theme first, so opening the view does not change what is on screen.
    const rest = list.filter((p) => p.id !== active?.id);
    const ordered = [...list.filter((p) => p.id === active?.id), ...rest.filter((p) => p.scheme === "dark"), ...rest.filter((p) => p.scheme === "light")];
    return ordered.map((p) => ({ id: p.id, section: active && p.id === active.id ? "Current" : p.scheme === "dark" ? "Dark Themes" : "Light Themes", preset: p }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the active id changes
  }, [query, active?.id]);

  const apply = useCallback(
    async (p: ThemePreset) => {
      await appearanceApi.applyPreset(p.id);
      setThemePreview(null);
      toast(`Theme: ${p.name}`);
    },
    [toast],
  );

  const actions = useCallback(
    (r: Row): NavAction[] => [
      { id: "apply", title: `Use ${r.preset.name}`, shortcut: "⏎", run: () => apply(r.preset) },
      {
        id: "slot",
        title: r.preset.scheme === "dark" ? "Set as Dark Theme Only" : "Set as Light Theme Only",
        shortcut: "⌘⏎",
        run: async () => {
          await appearanceApi.set(r.preset.scheme === "dark" ? { darkTheme: r.preset.id } : { lightTheme: r.preset.id });
          toast(`${r.preset.scheme === "dark" ? "Dark" : "Light"} theme: ${r.preset.name}`);
        },
      },
      { id: "toggle", title: "Toggle Light/Dark", shortcut: "⌘T", run: async () => void (await appearanceApi.toggle()) },
      { id: "system", title: "Follow System Appearance", shortcut: "⌘Y", run: async () => void (await appearanceApi.setMode("system")) },
      {
        id: "settings",
        title: "Open Appearance Settings",
        shortcut: "⌘,",
        run: () => {
          setThemePreview(null);
          glide().openSettings("appearance");
          pop();
        },
      },
    ],
    [apply, toast, pop],
  );

  if (!state || !settings) return <div className="launcher__empty">Loading themes…</div>;

  return (
    <NavList
      items={rows}
      actionsTitle="Theme"
      onSelectionChange={(r) => setThemePreview(r ? r.preset.id : null)}
      onActivate={(r) => void apply(r.preset)}
      actions={actions}
      emptyText="No theme matches"
      renderItem={(r, selected) => {
        const isDark = r.preset.id === settings.darkTheme;
        const isLight = r.preset.id === settings.lightTheme;
        return (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            <span className="icon appearance-dot" style={{ background: settings.accent || r.preset.accent }} />
            <div className="row__main">
              <span className="row__title">{r.preset.name}</span>
              <span className="row__subtitle">{r.preset.scheme === "dark" ? "Dark" : "Light"}</span>
            </div>
            <div className="row__right">
              {isDark && <span className="tag">Dark slot</span>}
              {isLight && <span className="tag">Light slot</span>}
              {active?.id === r.preset.id && <span className="tag tag--accent">Active</span>}
            </div>
          </div>
        );
      }}
      detail={(r) => (
        <div className="appearance-detail">
          <MiniLauncher preset={r.preset} settings={settings} size="large" />
          <div className="appearance-detail__meta">
            <strong>{r.preset.name}</strong>
            <span className="faint">{r.preset.scheme === "dark" ? "Dark theme" : "Light theme"} · ⏎ to apply · ⌘⏎ only set the {r.preset.scheme} slot</span>
          </div>
        </div>
      )}
    />
  );
}
