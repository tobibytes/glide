import { useCallback, useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { call, errorText, type FinderSettings, type FinderSettingsState } from "./api";

const FORMATS: Array<[FinderSettings["pathFormat"], string]> = [
  ["posix", "/Users/me/file.txt"],
  ["tilde", "~/file.txt"],
  ["quoted", "Shell-quoted, space separated"],
  ["url", "file:// URL"],
];

function wifiHint(s: FinderSettingsState): string {
  const w = s.wifi;
  if (!s.helper || !w) return "Unavailable — the Glide helper isn’t running";
  if (!w.poweredOn) return "Wi‑Fi is off";
  if (w.ssid) return `Connected to “${w.ssid}”`;
  if (w.needsLocation) return w.locationStatus === "denied" ? "Name hidden: Location access is off for Glide" : "Connected — macOS hides the network name until Glide has Location access";
  return w.connected ? "Connected (name unavailable)" : "Not connected";
}

export function FinderSettingsPage() {
  const [s, setS] = useState<FinderSettingsState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(() => void call<FinderSettingsState>("settingsState").then(setS, (e: unknown) => setErr(errorText(e))), []);
  useEffect(load, [load]);
  if (!s) return <div className="page">{err ?? "Loading…"}</div>;
  const save = (patch: Partial<FinderSettings>) => void call<FinderSettingsState>("setSettings", patch).then(setS);
  const askLocation = async () => {
    setAsking(true);
    try {
      setS(await call<FinderSettingsState>("requestLocation"));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="page" data-testid="finder-settings">
      <p className="page__lead">Commands for Finder’s selection: Copy Path, Open Terminal Here, New File Here…, Move Selection to…, Compress Selection and Open Selection With…. “Toggle Hidden Files” lives under System commands.</p>
      {!s.helper && <div className="error-banner">The Glide helper is not running, so Finder’s selection can’t be read.</div>}
      <Group title="Finder">
        <Row label="Terminal" hint="Used by Open Terminal Here (⌘K offers the others)">
          <select className="select" value={s.settings.terminal} onChange={(e) => save({ terminal: e.target.value as FinderSettings["terminal"] })}>
            <option value="Terminal">Terminal</option>
            <option value="iTerm">iTerm</option>
            <option value="Ghostty">Ghostty</option>
          </select>
        </Row>
        <Row label="Copy Path format">
          <select className="select" value={s.settings.pathFormat} onChange={(e) => save({ pathFormat: e.target.value as FinderSettings["pathFormat"] })}>
            {FORMATS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Accessibility" hint={s.accessibility ? "Granted — Glide reads Finder’s selection through Accessibility" : "Needed to read Finder’s selection"}>
          {!s.accessibility && (
            <button type="button" className="btn btn--sm" onClick={() => void call("openAccessibilitySettings")}>
              Open Settings…
            </button>
          )}
        </Row>
        <Row label="Ask Finder directly" hint="Fallback when Accessibility finds nothing (e.g. gallery view). macOS asks once to let Glide control Finder.">
          <Toggle label="Ask Finder directly" checked={s.settings.automation} onChange={(v) => save({ automation: v })} />
        </Row>
      </Group>
      <Group title="Wi‑Fi network name" footer="macOS 14 and later only reveal the Wi‑Fi name to apps with Location access. Glide never reads or stores your location; this only lets automations and the status show the network name.">
        <Row label="Current network" hint={wifiHint(s)}>
          {s.wifi?.locationStatus === "notDetermined" && (
            <button type="button" className="btn btn--sm" disabled={asking || !s.helper} onClick={() => void askLocation()} data-testid="finder-location-button">
              {asking ? "Waiting…" : "Allow Location Access…"}
            </button>
          )}
          {s.wifi?.locationStatus === "denied" && (
            <button type="button" className="btn btn--sm" onClick={() => void call("openLocationSettings")}>
              Open Settings…
            </button>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={load}>
            Refresh
          </button>
        </Row>
      </Group>
    </div>
  );
}
