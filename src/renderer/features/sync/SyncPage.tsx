import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Group, Row, Stepper, Toggle } from "../../components/form";
import { glide } from "../../lib/glide";
import type { BackupInfo, SyncResult, SyncStatus } from "../../../main/features/sync";
import type { ChangePreview } from "../../../main/features/sync/merge";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("sync", method, ...args);

const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : "never");

type Pending = { kind: "backup"; id: string; title: string; preview: ChangePreview } | { kind: "import"; file: string; title: string; preview: ChangePreview };

function PreviewList({ preview }: { preview: ChangePreview }) {
  const total = preview.added.length + preview.removed.length + preview.changed.length;
  if (!total) return <p className="faint">No differences: restoring would change nothing.</p>;
  const block = (title: string, items: ChangePreview["added"], cls: string) =>
    items.length > 0 && (
      <div className="sync-preview__block">
        <div className={`sync-preview__title ${cls}`}>
          {title} ({items.length})
        </div>
        <ul>
          {items.slice(0, 40).map((i) => (
            <li key={i.key}>{i.label}</li>
          ))}
          {items.length > 40 && <li className="faint">…and {items.length - 40} more</li>}
        </ul>
      </div>
    );
  return (
    <div className="sync-preview">
      {block("Added", preview.added, "sync-preview__title--add")}
      {block("Changed", preview.changed, "sync-preview__title--chg")}
      {block("Removed", preview.removed, "sync-preview__title--del")}
    </div>
  );
}

export function SyncPage() {
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [folder, setFolder] = useState("");
  const [machine, setMachine] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const s = await call<SyncStatus>("status");
    setSt(s);
    setFolder(s.settings.folder);
    setMachine(s.settings.machine);
  }, []);
  useEffect(() => {
    void load();
    return glide().onFeatureEvent((e) => {
      if (e.feature === "sync" && e.event === "status") void load();
    });
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<SyncResult>) => {
      setBusy(true);
      try {
        const r = await fn();
        setMessage({ text: r.message, error: !r.ok });
      } catch (err) {
        setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setBusy(false);
        void load();
      }
    },
    [load],
  );

  const syncNow = useCallback(() => run(() => call<SyncResult>("syncNow")), [run]);

  // ⌘S syncs from anywhere on the page.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void syncNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [syncNow]);

  if (!st) return <div className="empty">Loading…</div>;
  const s = st.settings;

  const previewBackup = async (b: BackupInfo) => setPending({ kind: "backup", id: b.id, title: `Restore backup from ${when(b.createdAt)}`, preview: await call<ChangePreview>("previewBackup", b.id) });
  const onBackupKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = st.backups.length;
    if (!n) return;
    if (e.key === "j" || e.key === "ArrowDown") setSel((i) => Math.min(n - 1, i + 1));
    else if (e.key === "k" || e.key === "ArrowUp") setSel((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") void previewBackup(st.backups[Math.min(sel, n - 1)]);
    else return;
    e.preventDefault();
  };

  return (
    <div className="page sync-page">
      <p className="page__lead">
        Sync Glide between Macs through a folder you already sync (iCloud Drive, Dropbox…). Glide never talks to a server: each Mac writes <code>Glide Sync/&lt;name&gt;.json</code> there and merges the others by last change. API keys and other secrets are never written.
      </p>

      <Group title="Folder">
        <Row label="Sync folder" hint={st.syncDir ? `Files go to ${st.syncDir}` : "Not set"}>
          <input
            className="input sync-folder"
            value={folder}
            placeholder="~/Library/Mobile Documents/com~apple~CloudDocs"
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void call<SyncStatus>("setSettings", { folder }).then(setSt)}
            onBlur={() => folder !== s.folder && void call<SyncStatus>("setSettings", { folder }).then(setSt)}
            aria-label="Sync folder path"
          />
          <button type="button" className="btn" onClick={() => void call<SyncStatus>("chooseFolder").then((r) => (setSt(r), setFolder(r.settings.folder)))}>
            Choose…
          </button>
          <button type="button" className="btn btn--ghost" disabled={!st.syncDir} onClick={() => void call("revealFolder")}>
            Reveal
          </button>
        </Row>
        <Row label="This Mac's name" hint="Used as the file name in the sync folder">
          <input className="input" value={machine} onChange={(e) => setMachine(e.target.value)} onBlur={() => machine !== s.machine && void call<SyncStatus>("setSettings", { machine }).then(setSt)} aria-label="Machine name" />
        </Row>
      </Group>

      <Group title="Sync" footer={st.lastError ? <span className="sync-error">Last error: {st.lastError}</span> : `Last sync: ${when(st.lastSyncAt)}${st.lastResult ? ` — ${st.lastResult}` : ""}`}>
        <Row label="Sync now" hint="Merges every Mac's file, applies the result here and writes this Mac's file (⌘S)">
          <button type="button" className="btn btn--primary" disabled={busy || !s.folder} onClick={() => void syncNow()}>
            {busy ? "Syncing…" : "Sync Now"} <span className="kbd">⌘S</span>
          </button>
          <button type="button" className="btn" disabled={busy || !s.folder} onClick={() => void run(() => call<SyncResult>("exportNow"))}>
            Export Only
          </button>
        </Row>
        <Row label="Sync automatically">
          <Toggle label="Sync automatically" checked={s.auto} onChange={(v) => void call<SyncStatus>("setSettings", { auto: v }).then(setSt)} />
        </Row>
        <Row label="Every (minutes)">
          <Stepper value={s.intervalMinutes} min={1} max={1440} onChange={(v) => void call<SyncStatus>("setSettings", { intervalMinutes: v }).then(setSt)} />
        </Row>
        {st.machines.length > 0 && (
          <Row label="Macs in this folder" align="start">
            <div className="sync-machines">
              {st.machines.map((m) => (
                <span key={m.machine} className={`tag ${m.self ? "tag--accent" : ""}`} title={`Last export ${when(m.exportedAt)}`}>
                  {m.machine} · {m.items} items
                </span>
              ))}
            </div>
          </Row>
        )}
      </Group>
      {message && <div className={`sync-message ${message.error ? "sync-message--error" : ""}`} role="status">{message.text}</div>}

      <Group title="Conflict log" footer="A conflict is an item changed on two Macs between syncs; the newer change wins.">
        {st.conflicts.length === 0 ? (
          <Row label={<span className="faint">No conflicts</span>}>{null}</Row>
        ) : (
          <>
            {st.conflicts.slice(0, 20).map((c, i) => (
              <Row key={`${c.key}-${c.at}-${i}`} label={c.label} hint={`${when(c.at)} · kept ${c.winner.machine}'s ${c.winner.deleted ? "deletion" : "version"} (${when(c.winner.t)}) over ${c.loser.machine} (${when(c.loser.t)})`}>
                {null}
              </Row>
            ))}
            <Row label="">
              <button type="button" className="btn btn--ghost" onClick={() => void call<SyncStatus>("clearConflicts").then(setSt)}>
                Clear Log
              </button>
            </Row>
          </>
        )}
      </Group>

      <Group title="Backups" footer="A backup is taken automatically before every sync that changes something and before any restore. The last 10 are kept.">
        <Row label="Back up now">
          <button type="button" className="btn" onClick={() => void call<BackupInfo>("backupNow").then((b) => (setMessage({ text: `Backed up ${b.items} items` }), load()))}>
            Back Up Now
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void call<{ file: string; preview: ChangePreview } | null>("chooseImport").then((r) => r && setPending({ kind: "import", file: r.file, title: `Import ${r.file.split("/").pop()}`, preview: r.preview }))
            }
          >
            Import from File…
          </button>
        </Row>
        <div className="sync-backups" tabIndex={0} ref={listRef} onKeyDown={onBackupKey} aria-label="Backups (j/k to move, Enter to preview)">
          {st.backups.length === 0 && <div className="faint sync-backups__empty">No backups yet</div>}
          {st.backups.map((b, i) => (
            <div key={b.id} className={`trow ${i === sel ? "trow--on" : ""}`} onClick={() => (setSel(i), void previewBackup(b))}>
              <div className="trow__main">
                <div className="trow__title">{when(b.createdAt)}</div>
                <div className="trow__sub">
                  {b.reason} · {b.items} items
                </div>
              </div>
              <div className="trow__meta faint">{i === sel ? "⏎ preview" : ""}</div>
            </div>
          ))}
        </div>
      </Group>

      {pending && (
        <div className="sync-modal" role="dialog" aria-label={pending.title} onKeyDown={(e) => e.key === "Escape" && setPending(null)}>
          <div className="sync-modal__box">
            <h3>{pending.title}</h3>
            <p className="faint">These changes will be applied. A backup of the current state is taken first, so this can be undone.</p>
            <PreviewList preview={pending.preview} />
            <div className="sync-modal__actions">
              <button type="button" className="btn" onClick={() => setPending(null)}>
                Cancel <span className="kbd">esc</span>
              </button>
              <button
                type="button"
                className="btn btn--primary"
                autoFocus
                onClick={() => {
                  const p = pending;
                  setPending(null);
                  void run(() => (p.kind === "backup" ? call<SyncResult>("restoreBackup", p.id) : call<SyncResult>("importFile", p.file)));
                }}
              >
                {pending.kind === "backup" ? "Restore" : "Import"} <span className="kbd">⏎</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
