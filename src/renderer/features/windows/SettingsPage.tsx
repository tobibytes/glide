import { useCallback, useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { Kbd } from "../../components/Kbd";
import { glide } from "../../lib/glide";

interface WindowsState {
  suggestedHotkeys: boolean;
  hotkeys: Array<{ display: string; action: string; title: string; registered: boolean }>;
}

export function WindowsSettingsPage() {
  const [state, setState] = useState<WindowsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (p: Promise<WindowsState>) => {
    try {
      setState(await p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => void run(glide().feature<WindowsState>("windows", "getState")), [run]);

  if (!state) return <div className="page">{error ? <div className="error-banner">{error}</div> : "Loading…"}</div>;
  const failed = state.suggestedHotkeys ? state.hotkeys.filter((h) => !h.registered) : [];

  return (
    <div className="page">
      {error && <div className="error-banner">{error}</div>}
      <Group
        title="Suggested hotkeys"
        footer={
          failed.length
            ? `Another app already uses ${failed.map((h) => h.display).join(", ")}.`
            : "Search “Left Half”, “Next Display”… in Glide and press ⌘K → Set Hotkey to bind any window command."
        }
      >
        <Row label="Use ⌃⌥ arrow keys" hint="Snap the front window to halves; ⌃⌥↩ maximizes. Off by default.">
          <Toggle label="Suggested window hotkeys" checked={state.suggestedHotkeys} onChange={(v) => void run(glide().feature<WindowsState>("windows", "setSuggestedHotkeys", v))} />
        </Row>
        {state.hotkeys.map((h) => (
          <Row key={h.action} label={h.title}>
            <span className={state.suggestedHotkeys ? "" : "faint"}>
              <Kbd keys={h.display} />
            </span>
          </Row>
        ))}
      </Group>
      <Group title="Permission" footer="Moving other apps' windows requires Accessibility access for Glide.">
        <Row label="Accessibility">
          <button type="button" className="btn btn--sm" onClick={() => void glide().feature("windows", "openAccessibilitySettings")}>
            Open Settings…
          </button>
        </Row>
      </Group>
    </div>
  );
}
