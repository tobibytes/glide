/** Pick browser bookmarks to import as quicklinks (read-only use of the browser feature's index). */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../../components/Icon";
import { Kbd } from "../../../components/Kbd";
import { importSummary, quicklinksApi, type BookmarkCandidate } from "./api";

export function BookmarkPicker({ onDone, onClose }: { onDone(message: string): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<BookmarkCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      void quicklinksApi
        .bookmarks(query, 300)
        .then((r) => alive && (setRows(r), setCursor(0)))
        .catch(() => alive && setRows([]));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const list = rows ?? [];
  const chosen = useMemo(() => list.filter((r) => picked.has(r.url)), [list, picked]);
  const toggle = (url: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });

  const doImport = async () => {
    const all = rows?.filter((r) => picked.has(r.url)) ?? [];
    if (!all.length) return;
    setBusy(true);
    try {
      onDone(importSummary(await quicklinksApi.importBookmarks(all), "quicklink"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="qlbm"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) {
          e.preventDefault();
          setCursor((c) => Math.min(list.length - 1, c + 1));
        } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) {
          e.preventDefault();
          setCursor((c) => Math.max(0, c - 1));
        } else if (e.key === "Enter" && e.metaKey) {
          e.preventDefault();
          void doImport();
        } else if (e.key === "Enter" || (e.key === " " && e.target === e.currentTarget)) {
          e.preventDefault();
          const r = list[cursor];
          if (r && !r.exists) toggle(r.url);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="qlbm__head">
        <input className="input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter bookmarks…" aria-label="Filter bookmarks" />
        <span className="qlbm__count">{chosen.length} selected</span>
        <button type="button" className="btn btn--primary" disabled={!chosen.length || busy} onClick={() => void doImport()} data-qlbm-import>
          Import <Kbd keys="⌘⏎" />
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Close <Kbd keys="⎋" />
        </button>
      </div>
      <div className="qlbm__list" role="listbox" aria-multiselectable="true">
        {rows === null && <div className="empty">Loading bookmarks…</div>}
        {rows !== null && !list.length && <div className="empty">No bookmarks found. Turn on bookmark search in Settings → Browser.</div>}
        {list.map((r, i) => (
          <div
            key={r.url}
            role="option"
            aria-selected={picked.has(r.url)}
            className={`qlbm__row ${i === cursor ? "qlbm__row--cursor" : ""} ${r.exists ? "qlbm__row--exists" : ""}`}
            onClick={() => (setCursor(i), !r.exists && toggle(r.url))}
          >
            <input type="checkbox" tabIndex={-1} readOnly checked={r.exists || picked.has(r.url)} disabled={r.exists} />
            <Icon icon={r.icon ? { kind: "url", value: r.icon } : { kind: "emoji", value: "🔖" }} fallback="🔖" />
            <div className="qlbm__main">
              <div className="qlbm__title">{r.title}</div>
              <div className="qlbm__sub">
                {r.url}
                {r.folder ? ` · ${r.folder}` : ""} · {r.browser}
              </div>
            </div>
            {r.exists && <span className="tag">added</span>}
          </div>
        ))}
      </div>
      <p className="field__hint">↑↓ move · ⏎ select · ⌘⏎ import selected · bookmarks are read from your browsers' local files and never leave your Mac.</p>
    </div>
  );
}
