import { useEffect, useRef } from "react";
import { NavList } from "../../components/NavList";
import { accelToDisplay } from "../../lib/keys";
import { glide } from "../../lib/glide";
import type { NavAction, NavItem, ViewProps } from "../types";
import { ago, call, errorText, groupByApp, useLayouts, type LayoutSummary, type WorkspaceSummary } from "./api";
import type { ExecuteResult } from "@shared/ipc";
import { useHotkeys } from "./useHotkeys";

type Row = NavItem & ({ kind: "layout"; layout: LayoutSummary } | { kind: "workspace"; ws: WorkspaceSummary } | { kind: "save"; name: string } | { kind: "new-workspace" });

const matches = (q: string, ...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));

export function LayoutsList({ query, setPlaceholder, push, close, toast }: ViewProps) {
  const [state] = useLayouts();
  const hotkeys = useHotkeys();
  const armed = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => setPlaceholder("Filter, or name a new layout…"), [setPlaceholder]);

  const q = query.trim().toLowerCase();
  const rows: Row[] = [
    ...(state?.workspaces ?? []).filter((w) => matches(q, w.name)).map((ws): Row => ({ id: `w:${ws.id}`, section: "Workspaces", kind: "workspace", ws })),
    ...(state?.layouts ?? []).filter((l) => matches(q, l.name, ...l.apps.map((a) => a.name))).map((layout): Row => ({ id: `l:${layout.id}`, section: "Layouts", kind: "layout", layout })),
    { id: "save", section: "Create", kind: "save", name: query.trim() },
    { id: "new-workspace", section: "Create", kind: "new-workspace" },
  ];

  const finish = (r: ExecuteResult) => {
    if (r.error) toast(r.error, "error");
    else if (r.view) push(r.view);
    else if (r.message) toast(r.message);
    if (r.hide && !r.error) close();
  };
  const run = (p: Promise<ExecuteResult>) => void p.then(finish, (e: unknown) => toast(errorText(e), "error"));

  const confirmDelete = (id: string, what: string, del: () => Promise<unknown>) => {
    const now = Date.now();
    if (armed.current?.id === id && now - armed.current.at < 2500) {
      armed.current = null;
      void del().then(() => toast(`${what} deleted`));
    } else {
      armed.current = { id, at: now };
      toast(`Press ⌃X again to delete ${what}`);
    }
  };

  const save = (name: string) =>
    void call<LayoutSummary>("save", name)
      .then((l) => toast(`Saved “${l.name}” (${l.windows.length} windows)`))
      .catch((e: unknown) => toast(errorText(e), "error"));

  const actions = (r: Row): NavAction[] => {
    if (r.kind === "save") return [{ id: "save", title: r.name ? `Save Current Windows as “${r.name}”` : "Save Current Windows…", shortcut: "⏎", run: () => (r.name ? save(r.name) : push({ id: "layouts.save", props: { title: "Save Window Layout" } })) }];
    if (r.kind === "new-workspace") return [{ id: "new", title: "Create Workspace in Settings", shortcut: "⏎", run: () => void call("editWorkspace", "new").then(close) }];
    if (r.kind === "workspace")
      return [
        { id: "open", title: "Open Workspace", shortcut: "⏎", run: () => run(call<ExecuteResult>("openWorkspace", r.ws.id)) },
        { id: "edit", title: "Edit Workspace…", shortcut: "⌘⏎", run: () => void call("editWorkspace", r.ws.id).then(close) },
        { id: "delete", title: "Delete Workspace", shortcut: "⌃X", destructive: true, run: () => confirmDelete(r.id, `“${r.ws.name}”`, () => call("deleteWorkspace", r.ws.id)) },
      ];
    const l = r.layout;
    const list: NavAction[] = [
      { id: "restore", title: "Restore Layout", shortcut: "⏎", run: () => run(call<ExecuteResult>("restore", l.id)) },
      { id: "relaunch", title: "Restore & Launch Missing Apps", shortcut: "⌘⏎", run: () => run(call<ExecuteResult>("restore", l.id, true)) },
      {
        id: "update",
        title: "Update with Current Windows",
        shortcut: "⌘U",
        run: () =>
          void call<LayoutSummary>("save", "", l.id)
            .then((u) => toast(`Updated “${u.name}” (${u.windows.length} windows)`))
            .catch((e: unknown) => toast(errorText(e), "error")),
      },
    ];
    if (query.trim() && query.trim() !== l.name) list.push({ id: "rename", title: `Rename to “${query.trim()}”`, shortcut: "⌘R", run: () => void call("rename", l.id, query.trim()).then(() => toast("Renamed")) });
    list.push(
      { id: "hotkey", title: "Set Hotkey in Settings…", shortcut: "⌘⇧H", run: () => void glide().openSettings("layouts") },
      { id: "delete", title: "Delete Layout", shortcut: "⌃X", destructive: true, run: () => confirmDelete(r.id, `“${l.name}”`, () => call("deleteLayout", l.id)) },
    );
    return list;
  };

  return (
    <NavList<Row>
      items={rows}
      emptyText="No layouts yet"
      actions={actions}
      onActivate={(r, mods) => {
        const list = actions(r);
        const a = mods.cmd ? (list.find((x) => x.shortcut === "⌘⏎") ?? list[0]) : list[0];
        void a?.run();
      }}
      detail={(r) => {
        if (r.kind === "layout") {
          const l = r.layout;
          return (
            <div className="layouts-detail">
              <div className="layouts-detail__title">{l.name}</div>
              <div className="faint">
                {l.summary} · saved {ago(l.updatedAt)}
              </div>
              {l.displays.length > 1 && <div className="faint">{l.displays.map((d) => d.name).join(" + ")}</div>}
              {groupByApp(l).map((g) => (
                <div key={g.app} className="layouts-detail__app">
                  <div className="layouts-detail__appname">{g.app}</div>
                  {g.titles.map((t, i) => (
                    <div key={i} className="layouts-detail__win faint">
                      {t}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        }
        if (r.kind === "workspace") {
          const w = r.ws;
          return (
            <div className="layouts-detail">
              <div className="layouts-detail__title">{w.name}</div>
              <div className="faint">{w.summary}</div>
              {w.launchApps.length > 0 && <div className="layouts-detail__app">Opens: {w.launchApps.map((a) => a.name).join(", ")}</div>}
              {w.quitApps.length > 0 && <div className="layouts-detail__app">Quits (asks first): {w.quitApps.map((a) => a.name).join(", ")}</div>}
              {w.urls.length > 0 && <div className="layouts-detail__app">Links: {w.urls.join(", ")}</div>}
              {w.shortcut && <div className="layouts-detail__app">Shortcut: {w.shortcut}</div>}
              {w.focus && <div className="layouts-detail__app">Focus: {w.focus.goal || "Focus"} · {w.focus.minutes} min</div>}
            </div>
          );
        }
        return <div className="layouts-detail faint">{r.kind === "save" ? "Captures every visible window (app, title, position, display) of regular apps." : "Workspaces open apps and links, restore a layout, quit distracting apps (after asking) and can start a Focus session."}</div>;
      }}
      renderItem={(r, selected) => {
        const hotkey = r.kind === "layout" ? hotkeys[r.layout.itemId] : r.kind === "workspace" ? hotkeys[r.ws.itemId] : undefined;
        return (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--md">{r.kind === "layout" ? "🪟" : r.kind === "workspace" ? "🧰" : r.kind === "save" ? "💾" : "➕"}</span>
            <div className="row__main">
              <span className="row__title">
                {r.kind === "layout" ? r.layout.name : r.kind === "workspace" ? r.ws.name : r.kind === "save" ? (r.name ? `Save Current Windows as “${r.name}”` : "Save Current Windows…") : "Create Workspace…"}
              </span>
            </div>
            <div className="row__right">{hotkey && <span className="row__kind">{accelToDisplay(hotkey)}</span>}</div>
          </div>
        );
      }}
    />
  );
}
