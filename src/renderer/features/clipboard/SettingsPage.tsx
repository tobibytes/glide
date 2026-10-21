import { useCallback, useEffect, useState } from "react";
import { Group, Row, Stepper, Toggle } from "../../components/form";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { glide } from "../../lib/glide";
import { clipApi, type ClipSettings, type ClipStats, type SourceSummary } from "./api";
import type { ClipType } from "../../../main/features/clipboard/model";
import { formatBytes } from "./format";

const RETENTION: Array<{ days: number; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "3 months" },
  { days: 365, label: "1 year" },
  { days: 0, label: "Forever" },
];

const TYPE_ROWS: Array<{ type: ClipType; label: string }> = [
  { type: "image", label: "Images" },
  { type: "file", label: "Files" },
  { type: "link", label: "Links" },
  { type: "text", label: "Text" },
  { type: "color", label: "Colors" },
];
const TYPE_RETENTION: Array<{ days: number; label: string }> = [
  { days: 0, label: "Same as history" },
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "3 months" },
  { days: 365, label: "1 year" },
];

export function ClipboardSettingsPage() {
  const [s, setS] = useState<ClipSettings | null>(null);
  const [stats, setStats] = useState<ClipStats | null>(null);
  const [hotkeyOk, setHotkeyOk] = useState(true);
  const [stackHotkeyOk, setStackHotkeyOk] = useState(true);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [newApp, setNewApp] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [r, st, src] = await Promise.all([clipApi.getSettings(), clipApi.stats(), clipApi.sources()]);
    setS(r.settings);
    setHotkeyOk(r.hotkeyOk);
    setStackHotkeyOk(r.stackHotkeyOk);
    setStats(st);
    setSources(src);
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
      setStackHotkeyOk(r.stackHotkeyOk);
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
          <Toggle label="Pause clipboard history" checked={s.paused} onChange={(v) => void patch({ paused: v, pausedUntil: 0 })} />
        </Row>
        <Row label="Pause for 5 minutes" hint={stats?.pausedUntil ? `Paused until ${new Date(stats.pausedUntil).toLocaleTimeString()}` : "Copy a password or anything private without recording it"}>
          {stats?.pausedUntil ? (
            <button type="button" className="btn btn--sm" onClick={() => void clipApi.resume().then(refresh)}>
              Resume now
            </button>
          ) : (
            <button type="button" className="btn btn--sm" onClick={() => void clipApi.pauseFor(5).then(refresh)}>
              Pause 5 min
            </button>
          )}
        </Row>
        <Row label="Recognize text in images" hint="Uses on-device Vision OCR (Glide helper) so copied screenshots are searchable">
          <Toggle label="Recognize text in images" checked={s.ocrImages} onChange={(v) => void patch({ ocrImages: v })} />
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
        {TYPE_ROWS.map((t) => (
          <Row key={t.type} label={`Keep ${t.label.toLowerCase()} for`} htmlFor={`clipboard-retention-${t.type}`}>
            <select
              id={`clipboard-retention-${t.type}`}
              className="select"
              value={s.retentionByType[t.type] ?? 0}
              onChange={(e) => void patch({ retentionByType: { ...s.retentionByType, [t.type]: Number(e.target.value) } })}
            >
              {TYPE_RETENTION.map((r) => (
                <option key={r.days} value={r.days}>
                  {r.label}
                </option>
              ))}
            </select>
          </Row>
        ))}
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

      <Group title="Paste Stack" footer="“Start Paste Stack” collects your next copies; “Paste Next from Stack” pastes them one at a time.">
        <Row label="Paste order" htmlFor="clipboard-stack-order">
          <select id="clipboard-stack-order" className="select" value={s.stackOrder} onChange={(e) => void patch({ stackOrder: e.target.value === "lifo" ? "lifo" : "fifo" })}>
            <option value="fifo">First copied, first pasted (FIFO)</option>
            <option value="lifo">Last copied, first pasted (LIFO)</option>
          </select>
        </Row>
        <Row label="Paste Next hotkey" hint={stackHotkeyOk ? "Pastes the next stack item from anywhere" : "macOS refused this shortcut — another app may own it"} htmlFor="clipboard-stack-hotkey">
          <HotkeyRecorder id="clipboard-stack-hotkey" value={s.stackHotkey || undefined} onChange={(accel) => void patch({ stackHotkey: accel ?? "" })} />
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
            {sources.some((a) => a.bundleId && !s.ignoredApps.includes(a.bundleId)) && (
              <select
                className="select"
                aria-label="Ignore an app seen in history"
                value=""
                onChange={(e) => e.target.value && void patch({ ignoredApps: [...s.ignoredApps, e.target.value] })}
              >
                <option value="">Ignore an app from history…</option>
                {sources
                  .filter((a) => a.bundleId && !s.ignoredApps.includes(a.bundleId))
                  .map((a) => (
                    <option key={a.key} value={a.bundleId!}>
                      {a.name} ({a.count})
                    </option>
                  ))}
              </select>
            )}
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
