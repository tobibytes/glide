import { useEffect, useState } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { baseName, call, errorText, strings, type DestinationRow, type OpResult } from "./api";

type Row = NavItem & DestinationRow;
const SECTION: Record<DestinationRow["kind"], string> = { typed: "Folder", child: "Subfolders", recent: "Recent", place: "Places" };

export function MoveView({ props, query, setQuery, setPlaceholder, close, toast }: ViewProps) {
  const paths = strings(props.paths);
  const folder = typeof props.folder === "string" ? props.folder : "";
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => setPlaceholder("Destination folder — type a path like ~/Projects/ or search recent folders"), [setPlaceholder]);
  useEffect(() => {
    let live = true;
    void call<DestinationRow[]>("destinations", query, folder).then((list) => live && setRows(list.map((d) => ({ ...d, id: d.path, section: SECTION[d.kind] }))));
    return () => {
      live = false;
    };
  }, [query, folder]);

  const move = async (dest: string) => {
    try {
      const r = await call<OpResult>("move", paths, dest);
      if (!r.ok) return toast(r.error ?? "Could not move", "error");
      const n = r.moved?.length ?? 0;
      toast(n ? `Moved ${n === 1 ? baseName(paths[0] ?? "") : `${n} items`} to ${baseName(dest)}` : "Already there");
      close();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const actions = (r: Row): NavAction[] => [
    { id: "move", title: `Move to “${r.name}”`, shortcut: "⏎", run: () => void move(r.path) },
    { id: "browse", title: "Browse Into Folder", shortcut: "⇥", run: () => setQuery(r.path.endsWith("/") ? r.path : r.path + "/") },
  ];

  return (
    <div className="finder" data-testid="finder-move">
      <div className="finder__context">Moving {paths.length === 1 ? `“${baseName(paths[0] ?? "")}”` : `${paths.length} items`} · ⌘K → Browse Into Folder</div>
      <NavList<Row>
        items={rows ?? []}
        emptyText={rows ? "No matching folders" : "Loading…"}
        onActivate={(r) => void move(r.path)}
        actions={actions}
        renderItem={(r, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--md">📁</span>
            <div className="row__main">
              <span className="row__title">{r.name}</span>
              <span className="row__subtitle">{r.path}</span>
            </div>
          </div>
        )}
      />
    </div>
  );
}
