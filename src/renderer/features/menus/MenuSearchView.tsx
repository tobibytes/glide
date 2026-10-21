import { useCallback, useEffect, useMemo, useState } from "react";
import { fuzzyMatch } from "@engine/fuzzy";
import type { ExecuteResult } from "@shared/ipc";
import { NavList } from "../../components/NavList";
import { Kbd } from "../../components/Kbd";
import { glide } from "../../lib/glide";
import type { NavAction, NavItem, ViewProps } from "../types";

interface MenuItemInfo {
  path: string[];
  enabled: boolean;
  shortcut?: string;
}

interface MenuListResult {
  app: { name: string; pid: number } | null;
  items: MenuItemInfo[];
  error?: string;
  needsAccessibility?: boolean;
}

interface Row extends NavItem {
  m: MenuItemInfo;
  score: number;
}

/** Rank by the item title first, then the full breadcrumb (so "export pdf" finds File › Export › PDF…). */
function score(m: MenuItemInfo, query: string): number | null {
  if (!query) return 0;
  const title = m.path[m.path.length - 1] ?? "";
  const t = fuzzyMatch(title, query);
  if (t) return t.exact ? 1e9 : t.prefix ? 1e8 + t.score : 1e6 + t.score;
  const full = fuzzyMatch(m.path.join(" "), query);
  if (full) return full.score;
  return m.path.join(" ").toLowerCase().includes(query.toLowerCase()) ? 0 : null;
}

export function MenuSearchView({ props, query, setPlaceholder, toast, close }: ViewProps) {
  const pid = typeof props.pid === "number" ? props.pid : undefined;
  const appName = typeof props.appName === "string" ? props.appName : "";
  const [result, setResult] = useState<MenuListResult | null>(null);

  useEffect(() => setPlaceholder(appName ? `Search ${appName} menus…` : "Search menu items…"), [appName, setPlaceholder]);

  useEffect(() => {
    let live = true;
    glide()
      .feature<MenuListResult>("menus", "list", pid)
      .then((r) => live && setResult(r))
      .catch((err: unknown) => live && setResult({ app: null, items: [], error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [pid]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim();
    const out: Row[] = [];
    for (const m of result?.items ?? []) {
      const s = score(m, q);
      if (s === null) continue;
      out.push({ id: m.path.join("\u001f"), m, score: s, section: m.enabled ? undefined : "Disabled" });
    }
    // Enabled first; keep menu order when there is no query.
    return out.sort((a, b) => Number(b.m.enabled) - Number(a.m.enabled) || (q ? b.score - a.score : 0));
  }, [result, query]);

  const press = useCallback(
    async (m: MenuItemInfo) => {
      if (!m.enabled) {
        toast("That menu item is disabled", "error");
        return;
      }
      const r = await glide().feature<ExecuteResult>("menus", "press", pid ?? result?.app?.pid, m.path);
      if (!r.ok) toast(r.error ?? "Could not run the menu item", "error");
    },
    [pid, result, toast],
  );

  const openSettings = useCallback(async () => {
    await glide().feature("menus", "openAccessibilitySettings");
    close();
  }, [close]);

  const actions = useCallback(
    (row: Row): NavAction[] => [
      { id: "press", title: row.m.enabled ? "Run Menu Item" : "Disabled", icon: "☰", run: () => press(row.m) },
      { id: "copy", title: "Copy Menu Path", icon: "📋", shortcut: "⌘⇧C", run: () => void navigator.clipboard.writeText(row.m.path.join(" › ")).then(() => toast("Copied menu path")) },
    ],
    [press, toast],
  );

  if (!result) return <div className="menus-status">Reading {appName || "the app"}’s menus…</div>;
  if (result.needsAccessibility) {
    const fix = [{ id: "grant" }];
    return (
      <div className="menus-permission">
        <p className="menus-status">{result.error}</p>
        <NavList
          items={fix}
          onActivate={() => void openSettings()}
          renderItem={(_i, selected) => (
            <div className={`row ${selected ? "row--selected" : ""}`}>
              <span className="icon icon--md icon--symbol">🔐</span>
              <div className="row__main">
                <span className="row__title">Open Accessibility Settings</span>
                <span className="row__subtitle">Enable Glide, then open Search Menu Items again</span>
              </div>
              <div className="row__right">
                <Kbd keys="↩" />
              </div>
            </div>
          )}
        />
      </div>
    );
  }
  if (result.error) return <div className="menus-status menus-status--error">{result.error}</div>;

  return (
    <NavList
      items={rows}
      emptyText={result.items.length ? "No matching menu items" : `${appName || "This app"} has no menu items Glide can read`}
      onActivate={(row) => void press(row.m)}
      actions={actions}
      renderItem={(row, selected) => {
        const title = row.m.path[row.m.path.length - 1];
        const crumbs = row.m.path.slice(0, -1).join(" › ");
        return (
          <div className={`row ${selected ? "row--selected" : ""} ${row.m.enabled ? "" : "menus-row--disabled"}`}>
            <span className="icon icon--md icon--symbol">☰</span>
            <div className="row__main">
              <span className="row__title">{title}</span>
              <span className="row__subtitle">{crumbs}</span>
            </div>
            <div className="row__right">{row.m.shortcut && <Kbd keys={row.m.shortcut} />}</div>
          </div>
        );
      }}
    />
  );
}
