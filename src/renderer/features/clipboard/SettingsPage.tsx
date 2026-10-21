import { useCallback, useEffect, useState } from "react";
import { Group, Row, Stepper, Toggle } from "../../components/form";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { glide } from "../../lib/glide";
import { clipApi, type ClipSettings, type ClipStats } from "./api";
import { formatBytes } from "./format";

const RETENTION: Array<{ days: number; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "3 months" },
  { days: 365, label: "1 year" },
  { days: 0, label: "Forever" },
];

export function ClipboardSettingsPage() {
  const [s, setS] = useState<ClipSettings | null>(null);
  const [stats, setStats] = useState<ClipStats | null>(null);
  const [hotkeyOk, setHotkeyOk] = useState(true);
  const [newApp, setNewApp] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [r, st] = await Promise.all([clipApi.getSettings(), clipApi.stats()]);
    setS(r.settings);
    setHotkeyOk(r.hotkeyOk);
    setStats(st);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    return glide().onFeatureEvent((e) => e.feature === "clipboard" && e.event === "changed" && void clipApi.stats().then(setStats));
  }, [refresh]);

  const patch = async (p: Partial<ClipSettings>) => {
    try {
      const r = await clipApi.setSettings(p);
      setS(r.settings);
      setHotkeyOk(r.hotkeyOk);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!s) return <div className="page">{error ? <div className="error-banner">{error}</div> : "Loading…"}</div>;
  const retention = RETENTION.some((r) => r.days === s.retentionDays) ? s.retentionDays : 90;

  return (
    <div className="page clipboard-settings">
      {error && <div className="error-banner">{error}</div>}
      <Group title="Clipboard History" footer="History is stored only on this Mac and never leaves it. Content marked concealed by password managers is never saved.">
        <Row label="Record clipboard history" hint="Glide checks the clipboard a few times per second">
          <Toggle label="Record clipboard history" checked={s.enabled} onChange={(v) => void patch({ enabled: v })} />
        </Row>
        <Row label="Paused" hint="Temporarily stop recording (also via “Pause Clipboard History”)">
          <Toggle label="Pause clipboard history" checked={s.paused} onChange={(v) => void patch({ paused: v })} />
        </Row>
        <Row label="Hotkey" hint={hotkeyOk ? "Opens Clipboard History from anywhere" : "macOS refused this shortcut — another app may own it"} htmlFor="clipboard-hotkey">
          <HotkeyRecorder id="clipboard-hotkey" value={s.hotkey || undefined} onChange={(accel) => void patch({ hotkey: accel ?? "" })} />
        </Row>
      </Group>

      <Group title="Storage">
        <Row label="Keep history for" htmlFor="clipboard-retention">
          <select id="clipboard-retention" className="select" value={retention} onChange={(e) => void patch({ retentionDays: Number(e.target.value) })}>
            {RETENTION.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Maximum entries" hint="Oldest unpinned entries are removed first">
          <Stepper value={s.maxEntries} min={10} max={100000} step={100} onChange={(v) => void patch({ maxEntries: v })} />
        </Row>
        <Row label="Maximum images" hint={`Up to ${s.maxImageMB} MB of images`}>
          <Stepper value={s.maxImages} min={0} max={10000} step={10} onChange={(v) => void patch({ maxImages: v })} />
        </Row>
        <Row label="Current history" hint={stats ? `${stats.pinned} pinned · ${stats.byType.image} images (${formatBytes(stats.imageBytes)})` : undefined}>
          <div className="clipboard-settings__clear">
            <span className="clipboard-settings__count">{stats ? `${stats.total} entries` : ""}</span>
            <button
              type="button"
              className={`btn btn--sm ${confirming ? "btn--danger" : ""}`}
              onBlur={() => setConfirming(false)}
              onClick={async () => {
                if (!confirming) return setConfirming(true);
                setConfirming(false);
                await clipApi.clear(true);
                setStats(await clipApi.stats());
              }}
            >
              {confirming ? "Click again to clear" : "Clear History…"}
            </button>
          </div>
        </Row>
      </Group>

      <Group title="Ignored applications" footer="Nothing copied while one of these apps is frontmost is recorded. Needs the Glide helper to know the frontmost app.">
        <Row label="Bundle identifiers" align="start">
          <div className="list-edit">
            {s.ignoredApps.map((id) => (
              <div key={id} className="list-edit__item">
                <span title={id}>{id}</span>
                <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${id}`} onClick={() => void patch({ ignoredApps: s.ignoredApps.filter((x) => x !== id) })}>
                  Remove
                </button>
              </div>
            ))}
            <form
              className="list-edit__add"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newApp.trim();
                if (!v || s.ignoredApps.includes(v)) return;
                void patch({ ignoredApps: [...s.ignoredApps, v] });
                setNewApp("");
              }}
            >
              <input className="input mono" placeholder="com.example.app" value={newApp} onChange={(e) => setNewApp(e.target.value)} aria-label="Bundle identifier to ignore" />
              <button type="submit" className="btn btn--sm" disabled={!newApp.trim()}>
                Add
              </button>
            </form>
          </div>
        </Row>
      </Group>
    </div>
  );
}
