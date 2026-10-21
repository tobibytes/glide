import { useEffect, useMemo, useState } from "react";
import type { SearchItem } from "@shared/types";
import type { NavAction, NavItem, ViewProps } from "../types";
import { glide } from "../../lib/glide";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import { focusCall, useFocusState } from "./common";
import { normalizeSite } from "../../../main/features/focus/machine";
import type { FocusState } from "../../../main/features/focus/types";

type Row = NavItem & ({ kind: "addSite"; site: string } | { kind: "site"; site: string } | { kind: "app"; app: SearchItem; blocked: boolean } | { kind: "note" });

export function FocusBlocklist({ query, setPlaceholder, toast }: ViewProps) {
  const [state, setState] = useFocusState();
  const [apps, setApps] = useState<SearchItem[]>([]);

  useEffect(() => {
    setPlaceholder("Filter apps, or type a website to block (e.g. youtube.com)…");
    void glide().listApps().then((list) => setApps([...list].sort((a, b) => a.title.localeCompare(b.title))));
  }, [setPlaceholder]);

  const settings = state?.settings;
  const rows = useMemo((): Row[] => {
    if (!settings) return [];
    const q = query.trim().toLowerCase();
    const site = normalizeSite(q);
    const list: Row[] = [];
    if (site && !settings.blockedSites.includes(site)) list.push({ id: `add:${site}`, section: "Add", kind: "addSite", site });
    for (const s of settings.blockedSites) if (!q || s.includes(q)) list.push({ id: `site:${s}`, section: "Websites (reminder only)", kind: "site", site: s });
    const blockedNames = new Set(settings.blockedApps.map((a) => a.name));
    const filtered = apps.filter((a) => !q || a.title.toLowerCase().includes(q));
    // Blocked apps first so the current list is visible at a glance.
    const sorted = [...filtered.filter((a) => blockedNames.has(a.title)), ...filtered.filter((a) => !blockedNames.has(a.title))];
    for (const a of sorted) list.push({ id: `app:${a.id}`, section: "Applications", kind: "app", app: a, blocked: blockedNames.has(a.title) });
    return list;
  }, [settings, apps, query]);

  const save = async (patch: Record<string, unknown>) => setState(await focusCall<FocusState>("setSettings", patch));

  const toggle = (r: Row) => {
    if (!settings) return;
    if (r.kind === "addSite") {
      void save({ blockedSites: [...settings.blockedSites, r.site] }).then(() => toast(`Blocking ${r.site}`));
    } else if (r.kind === "site") {
      void save({ blockedSites: settings.blockedSites.filter((s) => s !== r.site) });
    } else if (r.kind === "app") {
      const next = r.blocked ? settings.blockedApps.filter((a) => a.name !== r.app.title) : [...settings.blockedApps, { name: r.app.title, path: r.app.path }];
      void save({ blockedApps: next });
    }
  };

  const actions = (r: Row): NavAction[] => {
    if (r.kind === "addSite") return [{ id: "add", title: `Block ${r.site}`, shortcut: "⏎", run: () => toggle(r) }];
    if (r.kind === "site") return [{ id: "remove", title: `Remove ${r.site}`, shortcut: "⏎", destructive: true, run: () => toggle(r) }];
    if (r.kind === "app") return [{ id: "toggle", title: r.blocked ? `Unblock ${r.app.title}` : `Block ${r.app.title}`, shortcut: "⏎", run: () => toggle(r) }];
    return [];
  };

  return (
    <div className="focus-bl">
      <div className="focus-bl__note">
        Blocked <b>apps</b> are asked to quit when they come to the front during a session. <b>Websites</b> can’t be blocked system-wide without admin rights — Glide shows a reminder when one is open in Safari, Chrome, Arc, Brave, Edge, Vivaldi or Opera (macOS asks once for permission to read the tab).
      </div>
      <NavList<Row>
        items={rows}
        emptyText={settings ? "No matching apps. Type a domain like youtube.com to block a website." : "Loading…"}
        onActivate={toggle}
        actions={actions}
        renderItem={(r, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            {r.kind === "app" ? <Icon icon={r.app.icon} size="md" /> : <span className="icon icon--md">{r.kind === "addSite" ? "➕" : "🌐"}</span>}
            <div className="row__main">
              <span className="row__title">{r.kind === "app" ? r.app.title : r.kind === "addSite" ? `Block website ${r.site}` : r.kind === "site" ? r.site : ""}</span>
              {r.kind === "site" && <span className="row__subtitle">Reminder when open in a browser</span>}
            </div>
            <div className="row__right">{(r.kind === "site" || (r.kind === "app" && r.blocked)) && <span className="focus-bl__badge">Blocked</span>}</div>
          </div>
        )}
      />
    </div>
  );
}
