import { useCallback, useEffect, useRef, useState } from "react";
import { glide } from "../../lib/glide";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { Toggle } from "../../components/form";
import type { FallbackConfig } from "../../../main/features/fallbacks/model";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("fallbacks", method, ...args);

export function FallbacksSettings() {
  const [config, setConfig] = useState<FallbackConfig | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const run = useCallback(async (method: string, ...args: unknown[]) => {
    try {
      setConfig(await call<FallbackConfig>(method, ...args));
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
      return false;
    }
  }, []);

  useEffect(() => {
    void run("getConfig");
  }, [run]);

  // Keep keyboard focus on the moved row after a reorder.
  useEffect(() => {
    if (focusId) rowRefs.current.get(focusId)?.focus();
  }, [config, focusId]);

  if (!config) return <div className="empty">Loading…</div>;
  const entries = config.entries;

  const onRowKey = (e: React.KeyboardEvent, id: string, index: number) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      setFocusId(id);
      void run("move", id, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    const next = (d: number) => entries[Math.min(entries.length - 1, Math.max(0, index + d))];
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j") || e.key === "j") {
      e.preventDefault();
      rowRefs.current.get(next(1).id)?.focus();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k") || e.key === "k") {
      e.preventDefault();
      rowRefs.current.get(next(-1).id)?.focus();
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      const entry = entries[index];
      void run("setEnabled", entry.id, !entry.enabled);
    } else if ((e.key === "Backspace" && e.metaKey) || e.key === "Delete") {
      const entry = entries[index];
      if (entry.source === "custom") {
        e.preventDefault();
        void run("removeCustom", entry.id);
      }
    }
  };

  const add = async () => {
    if (await run("addCustom", name, url)) {
      setName("");
      setUrl("");
    }
  };

  return (
    <div className="page fallbacks">
      <p className="page__lead">
        When a search has no good match, these commands appear at the bottom of the results and receive what you typed. Top of the list shows first.
      </p>
      <p className="fallbacks__keys faint">
        <Kbd keys="↑" /> <Kbd keys="↓" /> or <Kbd keys="j" /> <Kbd keys="k" /> select · <Kbd keys="⌥↑" /> <Kbd keys="⌥↓" /> move · <Kbd keys="Space" /> enable/disable · <Kbd keys="⌘⌫" /> remove custom · or drag rows
      </p>
      {error && <div className="error-banner">{error}</div>}

      <div className="table fallbacks__list" role="listbox" aria-label="Fallback commands">
        {entries.map((f, i) => (
          <div key={f.id}>
            {dragId && dropIndex === i && <div className="fallbacks__drop" />}
            <div
              ref={(el) => {
                if (el) rowRefs.current.set(f.id, el);
                else rowRefs.current.delete(f.id);
              }}
              className={`trow fallbacks__row ${f.enabled ? "" : "fallbacks__row--off"} ${dragId === f.id ? "fallbacks__row--drag" : ""}`}
              role="option"
              aria-selected={focusId === f.id}
              tabIndex={0}
              draggable
              onFocus={() => setFocusId(f.id)}
              onKeyDown={(e) => onRowKey(e, f.id, i)}
              onDragStart={(e) => {
                setDragId(f.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropIndex(e.clientY > rect.top + rect.height / 2 ? i + 1 : i);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropIndex(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId !== null && dropIndex !== null) {
                  const from = entries.findIndex((x) => x.id === dragId);
                  const to = dropIndex > from ? dropIndex - 1 : dropIndex;
                  setFocusId(dragId);
                  void run("place", dragId, to);
                }
                setDragId(null);
                setDropIndex(null);
              }}
            >
              <span className="fallbacks__grip" aria-hidden="true">
                ⋮⋮
              </span>
              <Icon icon={f.icon} size="lg" />
              <div className="trow__main">
                <div className="trow__title">
                  {f.name}
                  {f.source !== "builtin" && <span className="tag">{f.source === "custom" ? "Custom" : "Quicklink"}</span>}
                </div>
                <div className="trow__sub">{f.url ?? (f.action === "files" ? "Opens file search with your text" : "Opens AI chat with your text as the prompt")}</div>
              </div>
              <div className="trow__actions">
                <button type="button" className="btn btn--sm btn--ghost" aria-label={`Move ${f.name} up`} tabIndex={-1} disabled={i === 0} onClick={() => void run("move", f.id, -1)}>
                  ↑
                </button>
                <button type="button" className="btn btn--sm btn--ghost" aria-label={`Move ${f.name} down`} tabIndex={-1} disabled={i === entries.length - 1} onClick={() => void run("move", f.id, 1)}>
                  ↓
                </button>
                {f.source === "custom" && (
                  <button type="button" className="btn btn--sm btn--danger" tabIndex={-1} onClick={() => void run("removeCustom", f.id)}>
                    Remove
                  </button>
                )}
                <Toggle checked={f.enabled} label={`Enable ${f.name}`} onChange={(v) => void run("setEnabled", f.id, v)} />
              </div>
            </div>
          </div>
        ))}
        {dragId && dropIndex === entries.length && <div className="fallbacks__drop" />}
      </div>

      <section className="group">
        <h3 className="group__title">Add Custom Fallback</h3>
        <form
          className="fallbacks__add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="input" aria-label="Name" placeholder="Search MDN" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input mono" aria-label="URL with {query}" placeholder="https://developer.mozilla.org/search?q={query}" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" className="btn btn--primary">
            Add
          </button>
        </form>
      </section>

      <section className="group">
        <h3 className="group__title">Use Quicklinks as Fallbacks</h3>
        <div className="group__box">
          {config.quicklinks.length === 0 && <div className="empty">No quicklinks yet. Create one under Quicklinks.</div>}
          {config.quicklinks.map((q) => (
            <label key={q.id} className="fallbacks__ql">
              <input type="checkbox" checked={q.enabled} onChange={(e) => void run("setQuicklink", q.id, e.target.checked)} />
              <span className="fallbacks__ql-name">{q.name}</span>
              <span className="faint mono">{q.url}</span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
