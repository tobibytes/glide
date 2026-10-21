import { useEffect, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { call, errorText, useLayouts, type AppRef } from "./api";

type Row = NavItem & { kind: "quit" | "skip" | "cancel" };

/** Launcher view "layouts.confirm": a workspace wants to quit running apps — the user decides. */
export function ConfirmWorkspace({ props, setPlaceholder, pop, close, toast }: ViewProps<{ workspaceId?: string }>) {
  const [state] = useLayouts();
  const [apps, setApps] = useState<AppRef[] | null>(null);
  const id = typeof props.workspaceId === "string" ? props.workspaceId : "";
  const ws = state?.workspaces.find((w) => w.id === id);
  useEffect(() => setPlaceholder(""), [setPlaceholder]);
  useEffect(() => void call<AppRef[]>("quitCandidates", id).then(setApps), [id]);

  const go = (quit: boolean) =>
    void call<ExecuteResult>("runWorkspace", id, quit).then(
      (r) => {
        if (r.error) toast(r.error, "error");
        else close();
      },
      (e: unknown) => toast(errorText(e), "error"),
    );

  const names = (apps ?? []).map((a) => a.name).join(", ");
  const rows: Row[] = [
    { id: "quit", kind: "quit" },
    { id: "skip", kind: "skip" },
    { id: "cancel", kind: "cancel" },
  ];
  const actionFor = (r: Row): NavAction =>
    r.kind === "quit"
      ? { id: "quit", title: `Quit ${names || "apps"} and Open`, shortcut: "⏎", destructive: true, run: () => go(true) }
      : r.kind === "skip"
        ? { id: "skip", title: "Open Without Quitting", shortcut: "⌘⏎", run: () => go(false) }
        : { id: "cancel", title: "Cancel", shortcut: "esc", run: () => pop() };

  return (
    <div className="layouts-confirm">
      <div className="layouts-confirm__head">
        <div className="layouts-detail__title">Open workspace “{ws?.name ?? "…"}”?</div>
        <div className="faint">{apps === null ? "Checking running apps…" : apps.length ? `It will ask these apps to quit: ${names}. Apps with unsaved changes may ask you to save.` : "No apps need to quit."}</div>
      </div>
      <NavList<Row>
        items={rows}
        actions={(r) => [actionFor(r), ...rows.filter((x) => x !== r).map(actionFor)]}
        onActivate={(r, mods) => (mods.cmd ? go(false) : actionFor(r).run())}
        renderItem={(r, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--md">{r.kind === "quit" ? "⏻" : r.kind === "skip" ? "▶️" : "✕"}</span>
            <div className="row__main">
              <span className="row__title">{actionFor(r).title}</span>
            </div>
            <div className="row__right">
              <span className="row__kind">{actionFor(r).shortcut}</span>
            </div>
          </div>
        )}
      />
    </div>
  );
}
