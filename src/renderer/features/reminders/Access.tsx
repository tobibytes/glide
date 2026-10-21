import type { NavAction } from "../types";
import type { RemindersState } from "./api";
import { call } from "./api";

export type AccessRow = { id: string; section?: string } & ({ kind: "grant" } | { kind: "settings" } | { kind: "retry" });

export const isAccessRow = (r: { kind: string }): r is AccessRow => r.kind === "grant" || r.kind === "settings" || r.kind === "retry";

/** Rows shown instead of reminders when access is missing or the helper is unavailable. */
export function accessRows(s: RemindersState): AccessRow[] {
  if (s.status === "notDetermined") return [{ id: "grant", kind: "grant" }];
  if (s.status === "denied" || s.status === "restricted") return [{ id: "settings", kind: "settings" }, { id: "retry", kind: "retry" }];
  return [{ id: "retry", kind: "retry" }];
}

export function accessActions(r: AccessRow, setState: (s: RemindersState) => void, reload: () => void): NavAction[] {
  if (r.kind === "grant") return [{ id: "grant", title: "Grant Reminders Access", shortcut: "⏎", run: () => void call<RemindersState>("requestAccess").then(setState) }];
  if (r.kind === "settings") return [{ id: "settings", title: "Open Privacy Settings", shortcut: "⏎", run: () => void call("openPrivacySettings") }];
  return [{ id: "retry", title: "Try Again", shortcut: "⏎", run: reload }];
}

export function AccessRowView({ row, selected, state }: { row: AccessRow; selected: boolean; state: RemindersState }) {
  const t =
    row.kind === "grant"
      ? ["🔓", "Grant Reminders Access", "macOS asks once"]
      : row.kind === "settings"
        ? ["⚙️", "Open Privacy Settings", "Allow Glide under Privacy & Security → Reminders"]
        : ["🔄", "Try Again", state.status === "no-helper" ? "Helper not running" : state.status === "unavailable" ? "Reminders are not available in this session" : "Reload reminders"];
  return (
    <div className={`row ${selected ? "row--selected" : ""}`} data-testid={`reminders-${row.kind}`}>
      <span className="icon icon--md">{t[0]}</span>
      <div className="row__main">
        <span className="row__title">{t[1]}</span>
        <span className="row__subtitle">{t[2]}</span>
      </div>
    </div>
  );
}
