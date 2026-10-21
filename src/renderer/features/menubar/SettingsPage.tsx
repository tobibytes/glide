import { useEffect, useRef, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { glide } from "../../lib/glide";
import type { MenuBarSettingsState } from "../../../main/features/menubar";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("menubar", method, ...args);

/**
 * Settings → Menu Bar. Keyboard: 1–5 toggle an extra directly; with a switch focused, j/k or ↓/↑ move
 * between extras and Space/Enter toggles.
 */
export function MenuBarSettingsPage() {
  const [state, setState] = useState<MenuBarSettingsState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void call<MenuBarSettingsState>("getSettings").then(setState);
    return glide().onFeatureEvent((e) => {
      if (e.feature === "menubar" && e.event === "settings") setState(e.payload as MenuBarSettingsState);
    });
  }, []);

  const toggle = (id: string, on: boolean) => void call<MenuBarSettingsState>("setSettings", { [id]: on }).then(setState);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const n = Number(e.key);
      const extra = Number.isInteger(n) && n >= 1 ? state.extras[n - 1] : undefined;
      if (extra) {
        e.preventDefault();
        toggle(extra.id, !extra.enabled);
        listRef.current?.querySelector<HTMLButtonElement>(`[data-extra="${extra.id}"]`)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const onListKey = (e: React.KeyboardEvent) => {
    const down = e.key === "j" || e.key === "ArrowDown";
    const up = e.key === "k" || e.key === "ArrowUp";
    if ((!down && !up) || e.metaKey || e.ctrlKey || e.altKey) return;
    const switches = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-extra]") ?? [])];
    const cur = switches.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) return;
    e.preventDefault();
    e.stopPropagation();
    switches[Math.min(switches.length - 1, Math.max(0, cur + (down ? 1 : -1)))]?.focus();
  };

  if (!state) return <div className="empty">Loading…</div>;
  return (
    <div className="page menubar-page">
      <p className="page__lead">
        Extras are small status items next to the Glide icon. Click one for its menu. Press <span className="kbd">1</span>–<span className="kbd">{state.extras.length}</span> to toggle.
      </p>
      <div ref={listRef} onKeyDown={onListKey}>
        <Group title="Extras" footer="System Monitor samples only while it is shown. Next Meeting needs calendar access (granted from its menu). Extensions can add their own items too.">
          {state.extras.map((x, i) => (
            <Row
              key={x.id}
              label={
                <span className="menubar-page__label">
                  <span className="menubar-page__icon" aria-hidden="true">
                    {x.icon}
                  </span>
                  {x.title}
                </span>
              }
              hint={x.description}
            >
              <span className="kbd menubar-page__kbd">{i + 1}</span>
              <ToggleWithId id={x.id} checked={x.enabled} label={x.title} onChange={(v) => toggle(x.id, v)} />
            </Row>
          ))}
        </Group>
      </div>
    </div>
  );
}

/** <Toggle> plus a data attribute so keyboard navigation (and tests) can find each switch. */
function ToggleWithId({ id, ...props }: { id: string; checked: boolean; label: string; onChange(v: boolean): void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.setAttribute("data-extra", id);
  }, [id]);
  return (
    <span ref={ref} className="menubar-page__switch">
      <Toggle {...props} />
    </span>
  );
}
