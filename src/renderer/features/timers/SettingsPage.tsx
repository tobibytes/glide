import { Group, Row, Toggle } from "../../components/form";
import { timersCall, useTimers } from "./common";

export function TimersSettingsPage() {
  const [state] = useTimers();
  if (!state) return <div className="empty">Loading…</div>;
  const save = (patch: Record<string, unknown>) => void timersCall("setSettings", patch);
  return (
    <div className="page">
      <p className="page__lead">Start timers from the launcher: “timer 25m”, “timer 10 min tea”, “25m timer”, or open “Timers” for presets and stopwatches.</p>
      <Group title="When a timer finishes" footer="A macOS notification is shown (macOS asks once whether Glide may show notifications) and the sound plays.">
        <Row label="Sound">
          <select
            className="select"
            value={state.settings.sound}
            onChange={(e) => {
              save({ sound: e.target.value });
              void timersCall("previewSound", e.target.value);
            }}
          >
            <option value="none">None</option>
            {state.sounds.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group title="Menu bar">
        <Row label="Show running timer in the menu bar" hint="Next to the Glide icon">
          <Toggle checked={state.settings.showInMenuBar} label="Show running timer in the menu bar" onChange={(v) => save({ showInMenuBar: v })} />
        </Row>
      </Group>
    </div>
  );
}
