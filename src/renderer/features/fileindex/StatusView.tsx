import { useEffect, useMemo, useState } from "react";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import { glide } from "../../lib/glide";
import type { NavItem, ViewProps } from "../types";
import { fileIndex, onStatus, type IndexStatus } from "./api";
import { formatAgo, formatDate, formatDuration } from "./format";

interface Row extends NavItem {
  title: string;
  run(): void;
}

export function StatusPanel({ status }: { status: IndexStatus | null }) {
  if (!status) return <div className="fileindex-status">Loading…</div>;
  const rows: Array<[string, string]> = [
    ["State", status.state === "crawling" ? `Indexing… ${status.progress.toLocaleString()} entries` : status.state],
    ["Entries", status.entries.toLocaleString()],
    ["Files / folders", `${status.files.toLocaleString()} / ${status.dirs.toLocaleString()}`],
    ["Last full index", status.lastFullIndexAt ? `${formatAgo(status.lastFullIndexAt)} (${formatDate(status.lastFullIndexAt)})` : "never"],
    ["Full index took", formatDuration(status.durationMs)],
    ["Generation", String(status.generation)],
    ["Loaded from disk in", formatDuration(status.loadMs)],
    ["Pending journal ops", String(status.journalOps)],
    ["Watching for changes", status.watching ? "yes (FSEvents)" : "no"],
    ["Crawler", status.mode === "worker" ? "worker thread" : "inline (worker not bundled)"],
    ["Scopes", status.scopes.join(", ") || "—"],
  ];
  if (status.aborted) rows.push(["Stopped early", status.aborted]);
  if (status.error) rows.push(["Last error", status.error]);
  return (
    <dl className="fileindex-status">
      {rows.map(([k, v]) => (
        <div key={k} className="fileindex-status__row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function useIndexStatus(): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  useEffect(() => {
    void fileIndex.status().then(setStatus).catch(() => undefined);
    const off = onStatus(setStatus);
    // Relative times ("2 min ago") and progress stay fresh even without events.
    const t = setInterval(() => void fileIndex.status().then(setStatus).catch(() => undefined), 5000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return status;
}

/** "File Index Status" launcher view. */
export function StatusView(props: ViewProps) {
  const status = useIndexStatus();
  const { setPlaceholder } = props;
  useEffect(() => setPlaceholder("File Index Status"), [setPlaceholder]);
  const rows = useMemo<Row[]>(
    () => [
      { id: "rebuild", title: "Reindex Files", run: () => void fileIndex.rebuild().then(() => props.toast("Reindexing files in the background…")) },
      { id: "search", title: "Search Files", run: () => props.push({ id: "fileindex.search" }) },
      { id: "settings", title: "File Search Settings", run: () => glide().openSettings("fileindex") },
    ],
    [props],
  );
  return (
    <NavList<Row>
      items={rows}
      renderItem={(row, selected) => (
        <div className={`row${selected ? " row--selected" : ""}`}>
          <Icon icon={{ kind: "symbol", value: row.id === "rebuild" ? "folder" : row.id === "search" ? "magnifyingglass" : "gear" }} />
          <div className="row__main">
            <span className="row__title">{row.title}</span>
          </div>
        </div>
      )}
      onActivate={(row) => row.run()}
      detail={() => <StatusPanel status={status} />}
    />
  );
}
