import { useEffect, useMemo } from "react";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { validateFileName } from "../../../main/features/finder/names";
import { baseName, call, errorText, type OpResult } from "./api";

type Row = NavItem & { name: string; typed: boolean };
const TEMPLATES = ["untitled.txt", "README.md", "notes.md", "index.html", "script.sh", "data.json"];

export function NewFileView({ props, query, setPlaceholder, close, toast }: ViewProps) {
  const folder = typeof props.folder === "string" ? props.folder : "";
  useEffect(() => setPlaceholder(`File name in “${baseName(folder)}”…`), [folder, setPlaceholder]);

  const rows = useMemo((): Row[] => {
    const typed = query.trim();
    const list: Row[] = typed ? [{ id: "typed", name: typed, typed: true }] : [];
    for (const t of TEMPLATES) if (!typed || (t.startsWith(typed) && t !== typed)) list.push({ id: `t:${t}`, name: t, typed: false, section: typed ? "Suggestions" : "Templates" });
    return list;
  }, [query]);

  const create = async (name: string, open: boolean) => {
    const invalid = validateFileName(name);
    if (invalid) return toast(invalid, "error");
    try {
      const r = await call<OpResult>("newFile", folder, name, open);
      if (!r.ok) return toast(r.error ?? "Could not create the file", "error");
      toast(`Created ${baseName(r.path ?? name)}`);
      close();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const actions = (r: Row): NavAction[] => [
    { id: "create", title: "Create and Reveal in Finder", shortcut: "⏎", run: () => void create(r.name, false) },
    { id: "open", title: "Create and Open", shortcut: "⌘⏎", run: () => void create(r.name, true) },
  ];

  return (
    <div className="finder" data-testid="finder-newfile">
      <div className="finder__context">In {folder || "—"}</div>
      <NavList<Row>
        items={rows}
        emptyText="Type a file name"
        onActivate={(r, m) => void create(r.name, m.cmd)}
        actions={actions}
        renderItem={(r, selected) => {
          const err = r.typed ? validateFileName(r.name) : null;
          return (
            <div className={`row ${selected ? "row--selected" : ""}`}>
              <span className="icon icon--md">📄</span>
              <div className="row__main">
                <span className="row__title">{r.typed ? `Create “${r.name}”` : r.name}</span>
                <span className="row__subtitle">{err ?? "⏎ create · ⌘⏎ create and open"}</span>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
