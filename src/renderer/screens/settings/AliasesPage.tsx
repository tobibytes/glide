import { useEffect, useMemo, useRef, useState } from "react";
import type { ItemIcon, SearchItem, UserData } from "@shared/types";
import { glide } from "../../lib/glide";
import { accelToDisplay } from "../../lib/keys";
import { kindLabel } from "../../lib/icons";
import { Icon } from "../../components/Icon";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { Group } from "../../components/form";

interface Pickable {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ItemIcon;
  kind: SearchItem["kind"];
  kindLabel?: string;
}

/** Items the user can assign aliases/hotkeys to: apps + workflows + quicklinks + snippets. */
function usePickables(data: UserData): Pickable[] {
  const [apps, setApps] = useState<SearchItem[]>([]);
  useEffect(() => {
    let alive = true;
    glide()
      .listApps()
      .then((list) => alive && setApps(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return useMemo<Pickable[]>(
    () => [
      ...data.workflows.map((w) => ({ id: `workflow:${w.id}`, title: w.name, subtitle: w.description, icon: w.icon, kind: "workflow" as const })),
      ...data.quicklinks.map((q) => ({ id: `quicklink:${q.id}`, title: q.name, subtitle: q.url, icon: q.icon ?? { kind: "emoji" as const, value: "🔗" }, kind: "quicklink" as const })),
      ...data.snippets.map((s) => ({ id: `snippet:${s.id}`, title: s.name, subtitle: s.keyword, icon: { kind: "emoji" as const, value: "✂️" }, kind: "snippet" as const })),
      ...apps.map((a) => ({ id: a.id, title: a.title, subtitle: a.subtitle, icon: a.icon, kind: a.kind, kindLabel: a.kindLabel })),
    ],
    [data, apps],
  );
}

function describeUnknown(id: string): Pickable {
  const [prefix, ...rest] = id.split(":");
  const raw = rest.join(":");
  const kind = (["app", "system", "workflow", "quicklink", "snippet", "file", "setting"] as const).find((k) => k === prefix) ?? "system";
  const title = raw.split("/").pop()?.replace(/\.app$/, "") || id;
  return { id, title: title.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()), kind, icon: { kind: "symbol", value: kind } };
}

export function AliasesPage({ data, preselect, focus }: { data: UserData; preselect?: string; focus: "alias" | "hotkey" }) {
  const pickables = usePickables(data);
  const [selectedId, setSelectedId] = useState<string | null>(preselect ?? null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (preselect) setSelectedId(preselect);
  }, [preselect]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const byId = useMemo(() => new Map(pickables.map((p) => [p.id, p])), [pickables]);
  const resolve = (id: string): Pickable => byId.get(id) ?? describeUnknown(id);

  const assigned = useMemo(() => {
    const ids = new Set<string>([...Object.keys(data.aliases), ...Object.keys(data.hotkeys)]);
    for (const w of data.workflows) if (w.alias || w.hotkey) ids.add(`workflow:${w.id}`);
    for (const q of data.quicklinks) if (q.alias) ids.add(`quicklink:${q.id}`);
    for (const s of data.snippets) if (s.alias) ids.add(`snippet:${s.id}`);
    return Array.from(ids).map(resolve).sort((a, b) => a.title.localeCompare(b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, byId]);

  const filtered = useMemo(() => {
    const f = search.trim().toLowerCase();
    return (f ? pickables.filter((p) => p.title.toLowerCase().includes(f) || p.subtitle?.toLowerCase().includes(f)) : pickables).slice(0, 40);
  }, [pickables, search]);

  const aliasOf = (id: string) => data.aliases[id] ?? inherentAlias(id);
  const hotkeyOf = (id: string) => data.hotkeys[id] ?? inherentHotkey(id);
  function inherentAlias(id: string): string | undefined {
    if (id.startsWith("workflow:")) return data.workflows.find((w) => `workflow:${w.id}` === id)?.alias;
    if (id.startsWith("quicklink:")) return data.quicklinks.find((q) => `quicklink:${q.id}` === id)?.alias;
    if (id.startsWith("snippet:")) return data.snippets.find((s) => `snippet:${s.id}` === id)?.alias;
    return undefined;
  }
  function inherentHotkey(id: string): string | undefined {
    if (id.startsWith("workflow:")) return data.workflows.find((w) => `workflow:${w.id}` === id)?.hotkey;
    return undefined;
  }

  const setAlias = async (id: string, alias: string) => {
    try {
      await glide().setAlias(id, alias.trim() || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const setHotkey = async (id: string, accel: string | null) => {
    try {
      await glide().setHotkey(id, accel);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selected = selectedId ? resolve(selectedId) : null;

  return (
    <div className="page">
      <p className="page__lead">
        An alias is a short word that ranks an item first when typed. A hotkey opens the item from anywhere.
      </p>
      {error && <div className="error-banner">{error}</div>}

      <Group title="Assign">
        <div className="row row--start" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="picker" ref={pickerRef}>
            <input
              className="input"
              style={{ width: "100%" }}
              placeholder="Search apps, workflows, quicklinks, snippets…"
              value={search}
              aria-label="Find an item"
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setSearch(e.target.value);
                setOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && filtered[0]) {
                  setSelectedId(filtered[0].id);
                  setOpen(false);
                }
              }}
            />
            {open && (
              <div className="picker__pop" role="listbox">
                {filtered.length === 0 && <div className="empty" style={{ padding: 12 }}>No matches</div>}
                {filtered.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={p.id === selectedId}
                    className={`picker__item ${p.id === selectedId ? "picker__item--on" : ""}`}
                    onClick={() => {
                      setSelectedId(p.id);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Icon icon={p.icon} />
                    <span>{p.title}</span>
                    <span className="faint">{kindLabel(p)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {selected && (
            <AssignRow
              item={selected}
              alias={aliasOf(selected.id) ?? ""}
              hotkey={hotkeyOf(selected.id)}
              autoFocus={focus}
              onAlias={(v) => void setAlias(selected.id, v)}
              onHotkey={(v) => void setHotkey(selected.id, v)}
            />
          )}
        </div>
      </Group>

      <Group title="Assigned" footer="Aliases set directly on a workflow, quicklink or snippet are edited in their own editor.">
        {assigned.length === 0 && <div className="empty">Nothing assigned yet. Pick an item above.</div>}
        {assigned.map((p) => (
          <AssignRow
            key={p.id}
            item={p}
            alias={aliasOf(p.id) ?? ""}
            hotkey={hotkeyOf(p.id)}
            inheritedAlias={!data.aliases[p.id] && !!inherentAlias(p.id)}
            inheritedHotkey={!data.hotkeys[p.id] && !!inherentHotkey(p.id)}
            onAlias={(v) => void setAlias(p.id, v)}
            onHotkey={(v) => void setHotkey(p.id, v)}
          />
        ))}
      </Group>
    </div>
  );
}

function AssignRow({
  item,
  alias,
  hotkey,
  inheritedAlias,
  inheritedHotkey,
  autoFocus,
  onAlias,
  onHotkey,
}: {
  item: Pickable;
  alias: string;
  hotkey: string | undefined;
  inheritedAlias?: boolean;
  inheritedHotkey?: boolean;
  autoFocus?: "alias" | "hotkey";
  onAlias: (alias: string) => void;
  onHotkey: (accel: string | null) => void;
}) {
  const [draft, setDraft] = useState(alias);
  useEffect(() => setDraft(alias), [alias]);
  const commit = () => {
    if (draft.trim() !== alias) onAlias(draft);
  };
  return (
    <div className="row row--center">
      <Icon icon={item.icon} size="lg" />
      <div className="row__label">
        <div style={{ fontWeight: 500 }}>{item.title}</div>
        <div className="row__hint">
          {kindLabel(item)}
          {item.subtitle ? ` · ${item.subtitle}` : ""}
        </div>
      </div>
      <div className="row__control">
        <input
          className="input"
          style={{ width: 110 }}
          placeholder="alias"
          value={draft}
          autoFocus={autoFocus === "alias"}
          readOnly={inheritedAlias}
          title={inheritedAlias ? "Defined in the item's editor" : undefined}
          aria-label={`Alias for ${item.title}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        {inheritedHotkey ? (
          <span className="hotkey" title="Defined in the workflow editor" aria-label="Hotkey">
            <span className="hotkey__value">{hotkey ? accelToDisplay(hotkey) : ""}</span>
          </span>
        ) : (
          <HotkeyRecorder value={hotkey} onChange={onHotkey} placeholder="Record hotkey" autoFocus={autoFocus === "hotkey"} />
        )}
      </div>
    </div>
  );
}
