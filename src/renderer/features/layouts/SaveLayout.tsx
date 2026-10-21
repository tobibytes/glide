import { useEffect, useState } from "react";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { call, errorText, groupByApp, useLayouts, type Layout, type LayoutSummary } from "./api";

type Row = NavItem & ({ kind: "new"; name: string } | { kind: "replace"; layout: LayoutSummary });

/** Launcher view "layouts.save": the search field is the layout name. */
export function SaveLayout({ query, setPlaceholder, pop, toast }: ViewProps) {
  const [state] = useLayouts();
  const [preview, setPreview] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPlaceholder("Name this layout (e.g. Coding, Writing)…"), [setPlaceholder]);
  useEffect(() => {
    void call<Layout>("preview").then(
      (l) => setPreview(l),
      (e: unknown) => setError(errorText(e)),
    );
  }, []);

  const name = query.trim();
  const rows: Row[] = [
    { id: "new", section: "Save", kind: "new", name },
    ...(state?.layouts ?? []).map((layout): Row => ({ id: layout.id, section: "Replace Existing", kind: "replace", layout })),
  ];

  const save = (r: Row) => {
    const p = r.kind === "new" ? call<Layout>("save", name || `Layout ${(state?.layouts.length ?? 0) + 1}`) : call<Layout>("save", "", r.layout.id);
    void p.then(
      (l) => {
        toast(`Saved “${l.name}” (${l.windows.length} windows)`);
        pop();
      },
      (e: unknown) => toast(errorText(e), "error"),
    );
  };
  const actions = (r: Row): NavAction[] => [{ id: "save", title: r.kind === "new" ? "Save Layout" : `Replace “${r.layout.name}”`, shortcut: "⏎", run: () => save(r) }];

  return (
    <NavList<Row>
      items={rows}
      actions={actions}
      onActivate={(r) => save(r)}
      detail={() => (
        <div className="layouts-detail">
          {error ? (
            <div className="layouts-warning">
              {error}
              {/Accessibility/.test(error) && (
                <button type="button" className="btn btn--sm" onClick={() => void call("openAccessibilitySettings")}>
                  Open Accessibility Settings
                </button>
              )}
            </div>
          ) : !preview ? (
            <div className="faint">Reading windows…</div>
          ) : (
            <>
              <div className="layouts-detail__title">Will save {preview.windows.length} windows</div>
              {groupByApp(preview).map((g) => (
                <div key={g.app} className="layouts-detail__app">
                  <div className="layouts-detail__appname">{g.app}</div>
                  {g.titles.map((t, i) => (
                    <div key={i} className="layouts-detail__win faint">
                      {t}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}
      renderItem={(r, selected) => (
        <div className={`row ${selected ? "row--selected" : ""}`}>
          <span className="icon icon--md">{r.kind === "new" ? "💾" : "♻️"}</span>
          <div className="row__main">
            <span className="row__title">{r.kind === "new" ? (name ? `Save as “${name}”` : "Save as New Layout") : `Replace “${r.layout.name}”`}</span>
            {r.kind === "replace" && <span className="row__subtitle">{r.layout.summary}</span>}
          </div>
        </div>
      )}
    />
  );
}
