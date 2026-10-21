import { useEffect, useState } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import { baseName, call, errorText, strings, type OpResult } from "./api";

type Row = NavItem & { name: string; path: string };

export function OpenWithView({ props, query, setPlaceholder, close, toast }: ViewProps) {
  const paths = strings(props.paths);
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => setPlaceholder("Open with application…"), [setPlaceholder]);
  useEffect(() => {
    let live = true;
    void call<Array<{ name: string; path: string }>>("apps", query).then((list) => live && setRows(list.map((a) => ({ ...a, id: a.path }))));
    return () => {
      live = false;
    };
  }, [query]);

  const open = async (r: Row) => {
    try {
      const res = await call<OpResult>("openWith", r.path, paths);
      if (!res.ok) return toast(res.error ?? `Could not open with ${r.name}`, "error");
      close();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const actions = (r: Row): NavAction[] => [{ id: "open", title: `Open with ${r.name}`, shortcut: "⏎", run: () => void open(r) }];

  return (
    <div className="finder" data-testid="finder-openwith">
      <div className="finder__context">Opening {paths.length === 1 ? `“${baseName(paths[0] ?? "")}”` : `${paths.length} items`}</div>
      <NavList<Row>
        items={rows ?? []}
        emptyText={rows ? "No matching applications" : "Loading…"}
        onActivate={(r) => void open(r)}
        actions={actions}
        renderItem={(r, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            <Icon icon={{ kind: "app", value: r.path }} fallback="🪟" />
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
