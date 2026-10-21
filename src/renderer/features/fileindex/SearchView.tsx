import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavList } from "../../components/NavList";
import { Highlight } from "../../components/Highlight";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import type { NavItem, ViewProps } from "../types";
import { fileIndex, onStatus, type FileHitDTO, type IndexStatus, type SearchResultDTO } from "./api";
import { FILE_ACTIONS, navActions, runAction } from "./actions";
import { Preview } from "./Preview";
import { useShortcuts } from "./shortcuts";

interface Row extends NavItem {
  hit: FileHitDTO;
}

const SEARCH_DEBOUNCE_MS = 50;

/** Raycast "Search Files": index-backed list with a Quick Look-style detail pane. */
export function SearchView(props: ViewProps) {
  const { query, setPlaceholder } = props;
  const [result, setResult] = useState<SearchResultDTO | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const seq = useRef(0);
  const view = useMemo(() => ({ push: props.push, close: props.close, toast: props.toast }), [props.push, props.close, props.toast]);

  useEffect(() => setPlaceholder('Search files…  kind:pdf  in:~/Documents  "exact phrase"  content:text'), [setPlaceholder]);

  useEffect(() => {
    void fileIndex.status().then(setStatus).catch(() => undefined);
    return onStatus(setStatus);
  }, []);

  const toastRef = useRef(props.toast);
  toastRef.current = props.toast;
  const runSearch = useCallback((q: string) => {
    const mine = ++seq.current;
    void fileIndex
      .search(q, 50)
      .then((r) => {
        if (mine === seq.current) setResult(r);
      })
      .catch((err: unknown) => toastRef.current(err instanceof Error ? err.message : String(err), "error"));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => runSearch(query), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  // Refresh once the first crawl lands (results switch from Spotlight to the index).
  const lastState = useRef<string | null>(null);
  useEffect(() => {
    if (status?.state === "ready" && lastState.current === "crawling") runSearch(query);
    lastState.current = status?.state ?? null;
  }, [status?.state, query, runSearch]);

  const rows = useMemo<Row[]>(() => {
    const section = !query.trim() ? "Recent Files" : result?.source === "content" ? "Content Matches (Spotlight)" : result?.source === "spotlight" ? "Spotlight (index building…)" : "Files";
    return (result?.hits ?? []).map((hit) => ({ id: hit.path, section, hit }));
  }, [result, query]);

  const afterAction = useCallback(
    (id: string) => {
      if (id === "trash") runSearch(query);
    },
    [query, runSearch],
  );

  useShortcuts(
    FILE_ACTIONS.filter((a) => a.shortcut !== "⏎" && a.shortcut !== "⌘⏎").map((a) => ({
      shortcut: a.shortcut,
      run: () => {
        if (selected) void runAction(selected.hit, a.id, view, afterAction);
      },
    })),
  );

  const crawling = status?.state === "crawling";
  return (
    <div className="fileindex-search">
      <NavList<Row>
        items={rows}
        onSelectionChange={setSelected}
        renderItem={(row, isSelected) => (
          <div className={`row fileindex-row${isSelected ? " row--selected" : ""}`}>
            <Icon icon={{ kind: "file", value: row.hit.path }} fallback={row.hit.isDir ? "▣" : "▤"} />
            <div className="row__main">
              <span className="row__title">
                <Highlight text={row.hit.name} ranges={row.hit.ranges} />
              </span>
              <span className="row__subtitle">{row.hit.folder}</span>
            </div>
          </div>
        )}
        onActivate={(row, mods) => void runAction(row.hit, mods.cmd ? "reveal" : "open", view)}
        actions={(row) => navActions(row.hit, view, afterAction)}
        detail={(row) => <Preview hit={row.hit} />}
        emptyText={result === null ? "Searching…" : crawling && !status?.entries ? "Building the file index…" : query.trim() ? "No files found" : "No recent files"}
      />
      <div className="fileindex-footer" aria-live="polite">
        <span>
          {crawling ? `Indexing… ${status?.progress ? status.progress.toLocaleString() : ""}` : status ? `${status.entries.toLocaleString()} items indexed` : ""}
          {result && result.source === "index" && query ? ` · ${result.tookMs.toFixed(1)} ms` : ""}
        </span>
        <span className="fileindex-footer__keys">
          <Kbd keys="⌘Y" /> Quick Look <Kbd keys="⇧⌘C" /> Copy Path
        </span>
      </div>
    </div>
  );
}
