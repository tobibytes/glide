import { useCallback, useEffect, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import { Icon } from "../../components/Icon";
import { NavList } from "../../components/NavList";
import { glide } from "../../lib/glide";
import type { NavAction, NavItem, ViewProps } from "../types";
import { browserCall, relativeTime, useBrowserStatus, type BrowserRow } from "./common";

type Row = NavItem & { r: BrowserRow };
type Kind = "bookmark" | "history";

function makeView(kind: Kind) {
  return function BrowserSearchView({ props, query, setQuery, setPlaceholder, close, toast }: ViewProps<{ query?: string }>) {
    const [status] = useBrowserStatus();
    const [rows, setRows] = useState<Row[] | null>(null);
    useEffect(() => setPlaceholder(kind === "bookmark" ? "Search bookmarks by title or URL…" : "Search browser history…"), [setPlaceholder]);
    useEffect(() => {
      if (props.query) setQuery(props.query);
    }, [props.query, setQuery]);

    const total = kind === "bookmark" ? status?.totals.bookmarks : status?.totals.history;
    useEffect(() => {
      let alive = true;
      void browserCall<BrowserRow[]>("search", query, kind, 100).then((list) => alive && setRows(list.map((r) => ({ id: r.id, r }))));
      return () => {
        alive = false;
      };
    }, [query, total]);

    const done = useCallback(
      (res: ExecuteResult) => {
        if (res.ok) close();
        else toast(res.error ?? "Failed", "error");
      },
      [close, toast],
    );
    const actions = useCallback(
      (row: Row): NavAction[] => [
        { id: "open", title: `Open in ${row.r.browserName}`, shortcut: "⏎", icon: "🌐", run: () => void browserCall<ExecuteResult>("open", row.r.url, row.r.profile, "browser").then(done) },
        { id: "default", title: "Open in Default Browser", shortcut: "⌘⏎", run: () => void browserCall<ExecuteResult>("open", row.r.url, "", "default").then(done) },
        { id: "copy", title: "Copy URL", shortcut: "⇧⌘C", icon: "📋", run: () => void browserCall("copy", row.r.url).then(() => toast("URL copied")) },
        { id: "md", title: "Copy as Markdown Link", shortcut: "⇧⌘M", run: () => void browserCall("copy", `[${row.r.title.replace(/[[\]]/g, "")}](${row.r.url})`).then(() => toast("Markdown link copied")) },
        { id: "settings", title: "Browser Settings…", shortcut: "⌘,", run: () => glide().openSettings("browser") },
      ],
      [done, toast],
    );

    if (kind === "history" && status && !status.settings.history)
      return (
        <div className="browser-view">
          <div className="browser-off">
            <div className="browser-off__title">Browser history search is off</div>
            <p>History stays private by default. Turn it on in Settings → Browser to search pages you visited in Chrome, Arc, Brave, Edge, Firefox and Safari. Nothing leaves your Mac.</p>
          </div>
          <NavList<NavItem>
            items={[{ id: "enable" }]}
            onActivate={() => glide().openSettings("browser")}
            actions={() => [{ id: "settings", title: "Open Browser Settings", shortcut: "⏎", run: () => glide().openSettings("browser") }]}
            renderItem={(_i, selected) => (
              <div className={`row ${selected ? "row--selected" : ""}`}>
                <span className="icon icon--md">⚙️</span>
                <div className="row__main">
                  <span className="row__title">Open Browser Settings</span>
                  <span className="row__subtitle">Settings → Browser → Browser history</span>
                </div>
                <span className="row__kind">⏎</span>
              </div>
            )}
          />
        </div>
      );

    const empty =
      rows === null || !status || (status.lastRefresh === 0 && status.refreshing)
        ? "Indexing browsers…"
        : total === 0
          ? kind === "bookmark"
            ? "No bookmarks found. Check Settings → Browser for profiles."
            : "No history found in the selected profiles."
          : "No matches";
    return (
      <div className="browser-view">
        <div className="browser-toolbar">
          <span>
            {total ?? 0} {kind === "bookmark" ? "bookmarks" : "history entries"}
            {status?.refreshing ? " · refreshing…" : status?.lastRefresh ? ` · updated ${relativeTime(status.lastRefresh)}` : ""}
          </span>
          <span className="browser-toolbar__hint">⏎ open · ⌘⏎ default browser · ⇧⌘C copy URL</span>
        </div>
        <NavList<Row>
          items={rows ?? []}
          actions={actions}
          emptyText={empty}
          onActivate={(row, m) => void actions(row)[m.cmd ? 1 : 0]!.run()}
          renderItem={(row, selected) => (
            <div className={`row browser-row ${selected ? "row--selected" : ""}`}>
              <Icon icon={row.r.icon ? { kind: "url", value: row.r.icon } : row.r.appPath ? { kind: "app", value: row.r.appPath } : { kind: "emoji", value: kind === "bookmark" ? "🔖" : "🕘" }} fallback="🌐" />
              <div className="row__main">
                <span className="row__title">{row.r.title}</span>
                <span className="row__subtitle">
                  {row.r.host}
                  {row.r.folder ? ` · ${row.r.folder}` : ""}
                  {row.r.lastVisit ? ` · ${relativeTime(row.r.lastVisit)}` : ""}
                  {row.r.visitCount ? ` · ${row.r.visitCount}×` : ""}
                </span>
              </div>
              <span className="row__kind">
                {row.r.browserName}
                {row.r.profileName ? ` · ${row.r.profileName}` : ""}
              </span>
            </div>
          )}
        />
      </div>
    );
  };
}

export const BookmarksView = makeView("bookmark");
export const HistoryView = makeView("history");
