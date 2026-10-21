import { useMemo } from "react";
import { Group, Row, Stepper, Toggle } from "../../components/form";
import { browserCall, relativeTime, useBrowserStatus, type BrowserStatus } from "./common";

export function BrowserSettingsPage() {
  const [status, setStatus] = useBrowserStatus();
  const byBrowser = useMemo(() => {
    const m = new Map<string, BrowserStatus["profiles"]>();
    for (const p of status?.profiles ?? []) m.set(p.browserName, [...(m.get(p.browserName) ?? []), p]);
    return [...m];
  }, [status]);
  if (!status) return <div className="empty">Loading…</div>;
  const s = status.settings;
  const save = (patch: Record<string, unknown>) => void browserCall<BrowserStatus>("setSettings", patch).then(setStatus);
  const toggleProfile = (key: string, on: boolean) => save({ disabledProfiles: on ? s.disabledProfiles.filter((k) => k !== key) : [...s.disabledProfiles, key] });

  return (
    <div className="page browser-settings">
      <p className="page__lead">
        Search bookmarks (and, if you allow it, history) from your browsers right in the launcher. Glide reads copies of the browsers’ local files; nothing is uploaded. Type{" "}
        <code>history </code> before a query in the launcher to search history.
      </p>
      <Group title="Sources">
        <Row label="Bookmarks" hint="Shown in root search and in “Search Bookmarks”">
          <Toggle checked={s.bookmarks} label="Bookmarks" onChange={(v) => save({ bookmarks: v })} />
        </Row>
        <Row label="Bookmarks in root search" hint="Off: only inside “Search Bookmarks”">
          <Toggle checked={s.rootSearch} label="Bookmarks in root search" onChange={(v) => save({ rootSearch: v })} />
        </Row>
        <Row label="Browser history" hint="Off by default for privacy. Kept in memory only.">
          <Toggle checked={s.history} label="Browser history" onChange={(v) => save({ history: v })} />
        </Row>
        {s.history && (
          <Row label="History window (days)">
            <Stepper value={s.historyDays} min={1} max={3650} step={30} onChange={(v) => save({ historyDays: v })} />
          </Row>
        )}
        <Row label="Site icons" hint="Read from the browsers’ local favicon caches">
          <Toggle checked={s.favicons} label="Site icons" onChange={(v) => save({ favicons: v })} />
        </Row>
        <Row label="Refresh every (minutes)" hint={status.refreshing ? "Refreshing now…" : status.lastRefresh ? `Last refreshed ${relativeTime(status.lastRefresh)}` : "Not indexed yet"}>
          <div className="browser-settings__inline">
            <Stepper value={s.refreshMinutes} min={1} max={1440} onChange={(v) => save({ refreshMinutes: v })} />
            <button type="button" className="btn btn--sm" onClick={() => void browserCall<BrowserStatus>("refresh").then(setStatus)}>
              Refresh Now
            </button>
          </div>
        </Row>
      </Group>

      {byBrowser.map(([name, list]) => (
        <Group key={name} title={name}>
          {list.map((p) => (
            <Row
              key={p.key}
              label={p.name}
              hint={p.error ? <span className="browser-settings__error">{p.error}</span> : p.enabled ? `${p.bookmarks} bookmarks${s.history ? ` · ${p.history} history` : ""}` : "Excluded"}
            >
              <Toggle checked={p.enabled} label={`${name} ${p.name}`} onChange={(v) => toggleProfile(p.key, v)} />
            </Row>
          ))}
        </Group>
      ))}
      {byBrowser.length === 0 && <p className="group__footer">No supported browser data found (Chrome, Arc, Brave, Edge, Vivaldi, Chromium, Opera, Dia, Firefox, Zen, Safari).</p>}

      {status.safari === "denied" && (
        <Group title="Safari" footer="macOS protects Safari’s data. Glide never asks for this automatically: add Glide in System Settings → Privacy & Security → Full Disk Access, then press Refresh Now.">
          <Row label="Safari needs Full Disk Access">
            <button type="button" className="btn btn--sm" onClick={() => void browserCall("openFullDiskAccess")}>
              Open Full Disk Access Settings
            </button>
          </Row>
        </Group>
      )}
      <p className="group__footer">
        Indexed: {status.totals.bookmarks} bookmarks · {status.totals.history} history entries · {status.totals.favicons} site icons · reader: {status.backend}
      </p>
    </div>
  );
}
