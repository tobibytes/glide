import { useEffect, useMemo, useState } from "react";
import type { SearchItem } from "@shared/types";
import type { ExecuteResult } from "@shared/ipc";
import { Group, Row, Stepper, Toggle } from "../../components/form";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { glide } from "../../lib/glide";
import { call, errorText, useLayouts, type AppRef, type LayoutsState, type Workspace } from "./api";
import { useHotkeys } from "./useHotkeys";

type Draft = Omit<Workspace, "createdAt" | "updatedAt" | "id"> & { id: string | null; urlsText: string };

const blank = (): Draft => ({ id: null, name: "", layoutId: null, relaunchLayoutApps: true, launchApps: [], quitApps: [], urls: [], urlsText: "", focus: null, shortcut: null, noteId: null });
const toDraft = (w: Workspace): Draft => ({ ...w, urlsText: w.urls.join("\n") });

function AppListEditor({ label, apps, installed, onChange }: { label: string; apps: AppRef[]; installed: SearchItem[]; onChange(a: AppRef[]): void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const listId = `layouts-apps-${label.replace(/\W/g, "")}`;
  const add = async () => {
    const hit = installed.find((a) => a.title.toLowerCase() === text.trim().toLowerCase());
    if (!hit?.path) return setErr("Pick an app from the list");
    const ref = await call<AppRef | null>("appRef", hit.path, hit.title);
    if (!ref) return setErr("Could not read that app's bundle id");
    if (!apps.some((a) => a.bundleId === ref.bundleId)) onChange([...apps, ref]);
    setText("");
    setErr(null);
  };
  return (
    <Row label={label} align="start">
      <div className="layouts-apps">
        <div className="layouts-chips">
          {apps.map((a) => (
            <span key={a.bundleId} className="layouts-chip">
              {a.name}
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onChange(apps.filter((x) => x.bundleId !== a.bundleId))}>
                ×
              </button>
            </span>
          ))}
          {!apps.length && <span className="faint">None</span>}
        </div>
        <input
          className="input"
          list={listId}
          value={text}
          placeholder="Type an app name and press ⏎"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <datalist id={listId}>
          {installed.map((a) => (
            <option key={a.id} value={a.title} />
          ))}
        </datalist>
        {err && <span className="layouts-err">{err}</span>}
      </div>
    </Row>
  );
}

function WorkspaceEditor({ draft, state, installed, notes, onDone }: { draft: Draft; state: LayoutsState; installed: SearchItem[]; notes: Array<{ id: string; title: string }>; onDone(): void }) {
  const [d, setD] = useState<Draft>(draft);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  useEffect(() => setD(draft), [draft]);

  const save = async (): Promise<Workspace | null> => {
    try {
      const { urlsText, ...rest } = d;
      const ws = await call<Workspace>("saveWorkspace", { ...rest, id: d.id ?? undefined, urls: urlsText.split(/\n+/) });
      set({ id: ws.id });
      setMsg("Saved");
      return ws;
    } catch (e) {
      setMsg(errorText(e));
      return null;
    }
  };

  return (
    <Group title={d.id ? `Edit “${d.name || "Workspace"}”` : "New Workspace"} footer="Apps to quit are only quit after you confirm in the launcher; they can still ask to save documents.">
      <Row label="Name">
        <input className="input" autoFocus value={d.name} placeholder="e.g. Deep Work" onChange={(e) => set({ name: e.target.value })} />
      </Row>
      <Row label="Window layout" hint="Restored after apps open">
        <select className="select" value={d.layoutId ?? ""} onChange={(e) => set({ layoutId: e.target.value || null })}>
          <option value="">None</option>
          {state.layouts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.summary})
            </option>
          ))}
        </select>
      </Row>
      <Row label="Launch the layout's apps" hint="Open apps of the layout that aren't running">
        <Toggle label="Launch the layout's apps" checked={d.relaunchLayoutApps} onChange={(v) => set({ relaunchLayoutApps: v })} />
      </Row>
      <AppListEditor label="Open apps" apps={d.launchApps} installed={installed} onChange={(launchApps) => set({ launchApps })} />
      <AppListEditor label="Quit apps" apps={d.quitApps} installed={installed} onChange={(quitApps) => set({ quitApps })} />
      <Row label="Links & folders" hint="One per line: https://…, app links, ~/Projects" align="start">
        <textarea className="textarea mono" rows={3} value={d.urlsText} placeholder={"github.com/me/project\n~/Projects/glide"} onChange={(e) => set({ urlsText: e.target.value })} />
      </Row>
      <Row label="Start a Focus session">
        <Toggle label="Start a Focus session" checked={!!d.focus} onChange={(v) => set({ focus: v ? { goal: d.name, minutes: 50 } : null })} />
      </Row>
      {d.focus && (
        <Row label="Focus goal / minutes">
          <input className="input" value={d.focus.goal} placeholder="Goal" onChange={(e) => set({ focus: { ...d.focus!, goal: e.target.value } })} />
          <Stepper value={d.focus.minutes} min={5} max={600} step={5} onChange={(minutes) => set({ focus: { ...d.focus!, minutes } })} />
        </Row>
      )}
      <Row label="Run Shortcut" hint="Exact name of a Shortcuts.app shortcut, e.g. one that turns on a macOS Focus mode">
        <input className="input" value={d.shortcut ?? ""} placeholder="e.g. Work Focus On" onChange={(e) => set({ shortcut: e.target.value || null })} />
      </Row>
      <Row label="Open note">
        <select className="select" value={d.noteId ?? ""} onChange={(e) => set({ noteId: e.target.value || null })}>
          <option value="">None</option>
          {notes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title || "Untitled"}
            </option>
          ))}
        </select>
      </Row>
      <Row label="">
        <div className="layouts-buttons">
          <button type="button" className="btn btn--primary btn--sm" disabled={!d.name.trim()} onClick={() => void save()}>
            Save
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!d.name.trim()}
            onClick={() =>
              void save().then((ws) => ws && call<ExecuteResult>("openWorkspace", ws.id).then((r) => setMsg(r.error ?? (r.view ? "Confirm in the launcher" : (r.message ?? "Opened")))))
            }
          >
            Save & Open
          </button>
          {d.id && (
            <button type="button" className="btn btn--danger btn--sm" onClick={() => void call("deleteWorkspace", d.id).then(onDone)}>
              Delete
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={onDone}>
            Close
          </button>
          {msg && <span className="faint">{msg}</span>}
        </div>
      </Row>
    </Group>
  );
}

export function LayoutsSettingsPage() {
  const [state] = useLayouts();
  const hotkeys = useHotkeys();
  const [perm, setPerm] = useState<{ helper: boolean; accessibility: boolean } | null>(null);
  const [installed, setInstalled] = useState<SearchItem[]>([]);
  const [notes, setNotes] = useState<Array<{ id: string; title: string }>>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void call<{ helper: boolean; accessibility: boolean }>("permission").then(setPerm);
    void glide()
      .listApps()
      .then((apps) => setInstalled([...apps].sort((a, b) => a.title.localeCompare(b.title))));
    void glide()
      .feature<Array<{ id: string; title: string }>>("notes", "search", "")
      .then((n) => setNotes(Array.isArray(n) ? n : []))
      .catch(() => setNotes([]));
  }, []);

  // Launcher "Create Workspace" / "Edit Workspace…" hand the target over once.
  useEffect(() => {
    const take = () =>
      void call<string | null>("takePendingEdit").then((t) => {
        if (!t) return;
        const ws = t === "new" ? null : state?.workspaces.find((w) => w.id === t);
        setEditing(ws ? toDraft(ws) : blank());
      });
    if (state) take();
    return glide().onFeatureEvent((e) => {
      if (e.feature === "layouts" && e.event === "edit") take();
    });
  }, [state]);

  const settings = state?.settings;
  const sortedLayouts = useMemo(() => state?.layouts ?? [], [state]);
  if (!state || !settings) return <div className="page">Loading…</div>;

  const setHotkey = (itemId: string, accel: string | null) => void glide().setHotkey(itemId, accel);
  const result = (p: Promise<ExecuteResult>) => void p.then((r) => setMsg(r.error ?? r.message ?? "Done"), (e: unknown) => setMsg(errorText(e)));

  return (
    <div className="page">
      <p className="page__lead">Save the position of every window and bring it back later — matched by app and window title, across displays. Workspaces add apps, links, a Focus session and a layout in one command.</p>
      {perm && (!perm.helper || !perm.accessibility) && (
        <div className="error-banner">
          {perm.helper ? "Glide needs Accessibility permission to read and move windows." : "The Glide helper is not running, so windows can't be read."}{" "}
          {perm.helper && (
            <button type="button" className="btn btn--sm" onClick={() => void call("openAccessibilitySettings")}>
              Open Accessibility Settings
            </button>
          )}
        </div>
      )}
      {msg && <div className="layouts-msg faint">{msg}</div>}

      <Group title="Restoring">
        <Row label="Launch missing apps" hint="When restoring, open apps of the layout that aren't running (⌘⏎ on a layout always does)">
          <Toggle label="Launch missing apps" checked={settings.relaunchMissingApps} onChange={(v) => void call("setSettings", { relaunchMissingApps: v })} />
        </Row>
        <Row label="Wait for launched apps" hint="Seconds to wait for their windows">
          <Stepper value={settings.launchTimeoutSec} min={2} max={60} onChange={(v) => void call("setSettings", { launchTimeoutSec: v })} />
        </Row>
      </Group>

      <Group title="Layouts" footer="Save new layouts from the launcher: “Save Window Layout”. Hotkeys work everywhere.">
        {!sortedLayouts.length && (
          <Row label="No layouts yet">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void call("save", "Layout 1").then(() => setMsg("Saved “Layout 1”"), (e: unknown) => setMsg(errorText(e)))}
            >
              Save Current Windows
            </button>
          </Row>
        )}
        {sortedLayouts.map((l) => (
          <Row key={l.id} label={<input className="input layouts-name" aria-label="Layout name" value={names[l.id] ?? l.name} onChange={(e) => setNames({ ...names, [l.id]: e.target.value })} onBlur={() => names[l.id] && names[l.id] !== l.name && void call("rename", l.id, names[l.id])} />} hint={l.summary}>
            <div className="layouts-buttons">
              <HotkeyRecorder value={hotkeys[l.itemId]} onChange={(a) => setHotkey(l.itemId, a)} placeholder="Hotkey" />
              <button type="button" className="btn btn--sm" onClick={() => result(call<ExecuteResult>("restore", l.id))}>
                Restore
              </button>
              <button type="button" className="btn btn--sm" onClick={() => void call("save", "", l.id).then(() => setMsg(`Updated “${l.name}”`), (e: unknown) => setMsg(errorText(e)))}>
                Update
              </button>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => void call("deleteLayout", l.id)}>
                Delete
              </button>
            </div>
          </Row>
        ))}
      </Group>

      <Group title="Workspaces">
        {state.workspaces.map((w) => (
          <Row key={w.id} label={w.name} hint={w.summary}>
            <div className="layouts-buttons">
              <HotkeyRecorder value={hotkeys[w.itemId]} onChange={(a) => setHotkey(w.itemId, a)} placeholder="Hotkey" />
              <button type="button" className="btn btn--sm" onClick={() => setEditing(toDraft(w))}>
                Edit
              </button>
              <button type="button" className="btn btn--sm" onClick={() => result(call<ExecuteResult>("openWorkspace", w.id))}>
                Open
              </button>
            </div>
          </Row>
        ))}
        <Row label="">
          <button type="button" className="btn btn--sm" onClick={() => setEditing(blank())}>
            New Workspace…
          </button>
        </Row>
      </Group>

      {editing && <WorkspaceEditor draft={editing} state={state} installed={installed} notes={notes} onDone={() => setEditing(null)} />}
    </div>
  );
}
