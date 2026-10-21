import { useCallback, useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { Kbd } from "../../components/Kbd";
import { glide } from "../../lib/glide";
import { isUpdateState, type AppInfo, type UpdateState } from "./types";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("app", method, ...args);

const PHASES: Record<string, string> = {
  downloading: "Downloading…",
  verifying: "Verifying checksum…",
  extracting: "Unpacking…",
  "checking-signature": "Checking code signature…",
  replacing: "Replacing Glide.app…",
  done: "Relaunching…",
};

function statusLine(u: UpdateState): string {
  switch (u.status) {
    case "disabled":
      return u.error ?? "Updates are off. Enter a GitHub owner/repo to turn them on.";
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking…";
    case "up-to-date":
      return `Glide ${u.currentVersion} is the latest version${u.latestVersion && u.latestVersion !== u.currentVersion ? ` (feed has ${u.latestVersion})` : ""}.`;
    case "available":
      return `Glide ${u.latestVersion} is available.`;
    case "installing":
      return PHASES[u.phase ?? ""] ?? "Installing…";
    case "error":
      return u.error ?? "Something went wrong.";
  }
}

export function UpdatesPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [feed, setFeed] = useState("");
  const [note, setNote] = useState<{ text: string; kind: "info" | "error" } | null>(null);

  const load = useCallback(async () => {
    const next = await call<AppInfo>("info");
    setInfo(next);
    setFeed(next.updateFeed);
  }, []);

  useEffect(() => {
    void load();
    const offEvt = glide().onFeatureEvent((e) => {
      if (e.feature === "app" && e.event === "update-state" && isUpdateState(e.payload)) {
        const update = e.payload;
        setInfo((prev) => (prev ? { ...prev, update } : prev));
      }
    });
    const offData = glide().onDataChanged((d) => setInfo((prev) => (prev ? { ...prev, launchAtLogin: d.settings.launchAtLogin } : prev)));
    return () => {
      offEvt();
      offData();
    };
  }, [load]);

  const checkNow = useCallback(async () => {
    setNote(null);
    const update = await call<UpdateState>("checkNow");
    setInfo((prev) => (prev ? { ...prev, update } : prev));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "u") {
        e.preventDefault();
        void checkNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checkNow]);

  if (!info) return <div className="empty">Loading…</div>;
  const u = info.update;
  const busy = u.status === "checking" || u.status === "installing";

  const saveFeed = async () => {
    if (feed.trim() === info.updateFeed) return;
    setInfo(await call<AppInfo>("setUpdateSettings", { updateFeed: feed }));
  };

  const run = async (method: string, done: (r: { ok: boolean; path?: string; backup?: string; error?: string }) => string | null) => {
    setNote(null);
    try {
      const r = await call<{ ok: boolean; path?: string; backup?: string; error?: string }>(method);
      const text = done(r);
      if (text) setNote({ text, kind: r.error ? "error" : "info" });
      await load();
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), kind: "error" });
    }
  };

  return (
    <div className="page app-updates">
      {note && <div className={note.kind === "error" ? "error-banner" : "app-updates__note"}>{note.text}</div>}

      <Group title="Glide">
        <Row label="Version" hint={info.packaged ? info.appPath : "Development build (not packaged)"}>
          <span className="app-updates__version mono">{info.version}</span>
        </Row>
        <Row label="Launch at login" hint={info.packaged ? "Start Glide in the menu bar when you log in." : "Saved now; takes effect in the packaged Glide.app."}>
          <Toggle checked={info.launchAtLogin} label="Launch at login" onChange={(v) => void call("setLaunchAtLogin", v).then(load)} />
        </Row>
      </Group>

      <Group
        title="Updates"
        footer={
          <>
            Glide checks the latest GitHub release of this repository for <span className="mono">Glide-darwin-arm64.zip</span> and its <span className="mono">.sha256</span>, verifies the checksum, the code signature and
            the bundle identifier, then replaces the app and relaunches. Nothing is sent anywhere while the feed is empty.
          </>
        }
      >
        <Row label="Update feed" hint="GitHub owner/repo, e.g. you/glide" htmlFor="app-feed">
          <form
            className="app-updates__feed"
            onSubmit={(e) => {
              e.preventDefault();
              void saveFeed();
            }}
          >
            <input id="app-feed" className="input mono" placeholder="owner/repo" value={feed} spellCheck={false} onChange={(e) => setFeed(e.target.value)} onBlur={() => void saveFeed()} />
          </form>
        </Row>
        <Row label="Check automatically" hint="On launch and every 6 hours.">
          <Toggle checked={info.autoCheck} label="Check for updates automatically" onChange={(v) => void call<AppInfo>("setUpdateSettings", { autoCheck: v }).then(setInfo)} />
        </Row>
        <Row label={<span className={`app-updates__status app-updates__status--${u.status}`}>{statusLine(u)}</span>} hint={u.lastChecked ? `Last checked ${new Date(u.lastChecked).toLocaleString()}` : undefined}>
          <div className="app-updates__buttons">
            {u.status === "available" && (
              <button type="button" className="btn btn--primary" disabled={busy || !info.packaged} title={info.packaged ? undefined : "Only a packaged Glide.app can update itself"} onClick={() => void call<UpdateState>("install").then((update) => setInfo((p) => (p ? { ...p, update } : p)))}>
                Install {u.latestVersion} &amp; Relaunch
              </button>
            )}
            <button type="button" className="btn" disabled={busy || u.status === "disabled"} onClick={() => void checkNow()}>
              Check Now <Kbd keys="⌘U" />
            </button>
          </div>
        </Row>
      </Group>

      <Group title="Data" footer={<span className="mono">{info.userDataPath}</span>}>
        <Row label="Data folder" hint="data.json, usage history, feature data and backups.">
          <button type="button" className="btn" onClick={() => void call("showDataFolder")}>
            Show in Finder
          </button>
        </Row>
        <Row label="Settings file" hint="Settings, workflows, quicklinks, snippets, aliases and hotkeys.">
          <div className="app-updates__buttons">
            <button type="button" className="btn" onClick={() => void run("exportSettings", (r) => (r.ok ? `Exported to ${r.path}` : null))}>
              Export…
            </button>
            <button type="button" className="btn" onClick={() => void run("importSettings", (r) => (r.error ? r.error : r.ok ? `Imported ${r.path}. Previous data saved to ${r.backup}` : null))}>
              Import…
            </button>
          </div>
        </Row>
        <Row label="Reset Glide" hint="Back to a fresh install; a backup is saved first.">
          <button type="button" className="btn btn--danger" onClick={() => void run("reset", (r) => (r.ok ? `Glide was reset. Backup: ${r.backup}` : null))}>
            Reset Glide…
          </button>
        </Row>
      </Group>
    </div>
  );
}
