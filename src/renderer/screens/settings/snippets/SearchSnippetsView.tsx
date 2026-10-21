/** "Search Snippets" launcher view: filter by name/keyword/text, live preview pane, paste/copy/edit. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Snippet, UserData } from "@shared/types";
import { NavList } from "../../../components/NavList";
import { glide } from "../../../lib/glide";
import type { NavAction, NavItem, ViewProps } from "../../../features/types";
import { snippetsApi, type Rendered } from "../quicklinks/api";
import { RenderedPreview } from "./RenderedPreview";
import "../quicklinks/quicklinks.css";

type Row = NavItem & { s: Snippet };

/** Score: name prefix > name word > keyword > text; every token must match somewhere. */
export function matchSnippet(s: Snippet, query: string): number {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  const name = s.name.toLowerCase();
  const kw = (s.keyword ?? "").toLowerCase();
  const text = s.text.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (name.startsWith(t)) score += 40;
    else if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name)) score += 25;
    else if (kw.includes(t)) score += 20;
    else if (name.includes(t)) score += 12;
    else if (text.includes(t)) score += 5;
    else return 0;
  }
  return score;
}

function Preview({ s }: { s: Snippet }) {
  const [r, setR] = useState<Rendered | null>(null);
  useEffect(() => {
    let alive = true;
    void snippetsApi.render(s.id).then((x) => alive && setR(x)).catch(() => alive && setR(null));
    return () => {
      alive = false;
    };
  }, [s]);
  return (
    <div className="snsearch__detail">
      <div className="snsearch__detail-title">{s.name}</div>
      {r ? <RenderedPreview rendered={r} /> : <pre className="snpreview__text">{s.text}</pre>}
      <dl className="snsearch__meta">
        {s.keyword && (
          <>
            <dt>Keyword</dt>
            <dd className="mono">{s.keyword}</dd>
          </>
        )}
        {s.html && (
          <>
            <dt>Format</dt>
            <dd>Rich text (plain fallback included)</dd>
          </>
        )}
        {s.excludedApps?.length ? (
          <>
            <dt>Not in</dt>
            <dd className="mono">{s.excludedApps.join(", ")}</dd>
          </>
        ) : null}
        <dt>Length</dt>
        <dd>{s.text.length} characters</dd>
      </dl>
    </div>
  );
}

export function SearchSnippetsView({ props, query, setQuery, setPlaceholder, close, toast }: ViewProps<{ query?: string }>) {
  const [data, setData] = useState<UserData | null>(null);
  useEffect(() => setPlaceholder("Search snippets by name, keyword or text…"), [setPlaceholder]);
  useEffect(() => {
    if (props.query) setQuery(props.query);
  }, [props.query, setQuery]);
  useEffect(() => {
    void glide().getData().then(setData);
    return glide().onDataChanged(setData);
  }, []);

  const rows = useMemo<Row[]>(() => {
    const list = data?.snippets ?? [];
    return list
      .map((s) => ({ s, score: matchSnippet(s, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
      .map(({ s }) => ({ id: s.id, s }));
  }, [data, query]);

  const result = useCallback(
    (r: { ok: boolean; error?: string; message?: string }, closeOnOk: boolean) => {
      if (!r.ok) toast(r.error ?? "Failed", "error");
      else if (closeOnOk) close();
      else if (r.message) toast(r.message);
    },
    [close, toast],
  );

  const actions = useCallback(
    (row: Row): NavAction[] => [
      { id: "paste", title: "Paste", shortcut: "⏎", icon: "📋", run: () => void snippetsApi.paste(row.s.id).then((r) => result(r, true)) },
      { id: "copy", title: "Copy to Clipboard", shortcut: "⌘⏎", run: () => void snippetsApi.copy(row.s.id).then((r) => (result(r, false), r.ok && toast("Copied"))) },
      { id: "edit", title: "Edit Snippet", shortcut: "⌘E", icon: "✏️", run: () => glide().openSettings(`snippets/${row.s.id}`) },
      { id: "new", title: "Create Snippet", shortcut: "⌘N", icon: "➕", run: () => glide().openSettings("snippets/new") },
      { id: "delete", title: "Delete Snippet", shortcut: "⌃X", destructive: true, run: () => void snippetsApi.remove(row.s.id).then(() => toast("Snippet deleted")) },
    ],
    [result, toast],
  );

  return (
    <div className="snsearch" data-view-snippets-search>
      <NavList<Row>
        items={rows}
        actions={actions}
        emptyText={data === null ? "Loading…" : data.snippets.length ? "No matching snippets" : "No snippets yet — ⌘N creates one"}
        onActivate={(row, m) => void actions(row)[m.cmd ? 1 : 0]!.run()}
        detail={(row) => <Preview s={row.s} />}
        renderItem={(row, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`} data-sn-item={row.s.name}>
            <span className="icon icon--md">{row.s.html ? "🅰︎" : "✂️"}</span>
            <div className="row__main">
              <span className="row__title">{row.s.name}</span>
              <span className="row__subtitle">{row.s.text.replace(/\s+/g, " ").slice(0, 70)}</span>
            </div>
            {row.s.keyword && <span className="row__kind mono">{row.s.keyword}</span>}
          </div>
        )}
      />
    </div>
  );
}
