import { useEffect, useState } from "react";
import { Group, Row, Stepper, Toggle } from "../../components/form";
import { focusCall, useFocusState } from "./common";
import type { FocusState } from "../../../main/features/focus/types";

export function FocusSettingsPage() {
  const [state, setState] = useFocusState();
  const [sites, setSites] = useState("");
  const [on, setOn] = useState("");
  const [off, setOff] = useState("");
  const [test, setTest] = useState<string | null>(null);
  const settings = state?.settings;

  useEffect(() => {
    if (!settings) return;
    setSites(settings.blockedSites.join("\n"));
    setOn(settings.dndOnShortcut);
    setOff(settings.dndOffShortcut);
    // Only on first load: later edits are local until saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings === undefined]);

  if (!settings) return <div className="empty">Loading…</div>;
  const save = async (patch: Record<string, unknown>) => setState(await focusCall<FocusState>("setSettings", patch));

  return (
    <div className="page">
      <p className="page__lead">Focus sessions show a countdown in the menu bar. Edit the app block list from the launcher (“Start Focus Session” → Edit Block List).</p>
      <Group title="Session">
        <Row label="Default duration" hint="Used by ⌘⏎ on “Start Focus Session”">
          <Stepper value={settings.defaultMinutes} min={1} max={600} step={5} onChange={(v) => void save({ defaultMinutes: v })} />
        </Row>
        <Row label="Ask blocked apps to quit" hint="Off: only show a notification. macOS asks once per app for permission.">
          <Toggle checked={settings.quitBlockedApps} label="Ask blocked apps to quit" onChange={(v) => void save({ quitBlockedApps: v })} />
        </Row>
        <Row label="Blocked apps" hint="Edited from the launcher">
          <span className="faint">{settings.blockedApps.map((a) => a.name).join(", ") || "None"}</span>
        </Row>
      </Group>
      <Group title="Websites" footer="Reminder only: when a listed site is the active tab in a supported browser, Glide shows a full-window reminder. It cannot block sites system-wide without admin rights.">
        <Row label="Sites (one per line)" align="start">
          <textarea className="textarea mono" rows={5} value={sites} onChange={(e) => setSites(e.target.value)} onBlur={() => void save({ blockedSites: sites.split(/[\n,]/) })} placeholder={"youtube.com\nreddit.com"} />
        </Row>
      </Group>
      <Group title="Do Not Disturb" footer="macOS has no public API for Focus modes. Create a Shortcut (e.g. “Set Focus: Do Not Disturb On”) in the Shortcuts app and put its exact name here; Glide runs it with `shortcuts run` when a session starts or stops.">
        <Row label="Shortcut on start">
          <input className="input" value={on} placeholder="e.g. DND On" onChange={(e) => setOn(e.target.value)} onBlur={() => void save({ dndOnShortcut: on })} />
        </Row>
        <Row label="Shortcut on stop">
          <input className="input" value={off} placeholder="e.g. DND Off" onChange={(e) => setOff(e.target.value)} onBlur={() => void save({ dndOffShortcut: off })} />
        </Row>
        <Row label="Test">
          <button type="button" className="btn btn--sm" disabled={!on.trim()} onClick={() => void focusCall<string | null>("testShortcut", on).then((err) => setTest(err ?? `Ran “${on}”`))}>
            Run start Shortcut
          </button>
          {test && <span className="faint" style={{ marginLeft: 8 }}>{test}</span>}
        </Row>
      </Group>
    </div>
  );
}
