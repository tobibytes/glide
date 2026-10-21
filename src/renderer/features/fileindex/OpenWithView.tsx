import { useEffect, useMemo, useState } from "react";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import type { NavItem, ViewProps } from "../types";
import { fileIndex, type AppDTO } from "./api";
import { handleResult } from "./actions";

interface Row extends NavItem {
  app: AppDTO;
}

/** "Open With…": pick an application for props.path. */
export function OpenWithView(props: ViewProps) {
  const target = typeof props.props.path === "string" ? props.props.path : "";
  const [apps, setApps] = useState<AppDTO[]>([]);
  const { setPlaceholder } = props;
  useEffect(() => setPlaceholder(`Open “${target.split("/").pop()}” with…`), [setPlaceholder, target]);
  useEffect(() => {
    void fileIndex.listApps().then(setApps).catch(() => undefined);
  }, []);
  const rows = useMemo<Row[]>(() => {
    const q = props.query.trim().toLowerCase();
    const list = q ? apps.filter((a) => a.name.toLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))) : apps;
    return list.map((app) => ({ id: app.path, app }));
  }, [apps, props.query]);
  return (
    <NavList<Row>
      items={rows}
      renderItem={(row, selected) => (
        <div className={`row${selected ? " row--selected" : ""}`}>
          <Icon icon={{ kind: "app", value: row.app.path }} />
          <div className="row__main">
            <span className="row__title">{row.app.name}</span>
          </div>
        </div>
      )}
      onActivate={(row) =>
        void fileIndex
          .action(target, "openWith", row.app.path)
          .then((r) => handleResult(r, props))
          .catch((err: unknown) => props.toast(err instanceof Error ? err.message : String(err), "error"))
      }
      emptyText={apps.length ? "No matching applications" : "Loading applications…"}
    />
  );
}
