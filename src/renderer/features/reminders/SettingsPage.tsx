import { useCallback, useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { call, errorText, type RemindersState } from "./api";

interface S {
  defaultListId: string;
  showCompleted: boolean;
}

const STATUS: Record<string, string> = {
  ok: "Granted",
  notDetermined: "Not asked yet",
  denied: "Denied — allow Glide in System Settings",
  restricted: "Restricted by your administrator",
  "no-helper": "Helper not running",
  unavailable: "Not available in this session",
  error: "Error",
};

export function RemindersSettingsPage() {
  const [state, setState] = useState<RemindersState | null>(null);
  const [s, setS] = useState<S | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void call<RemindersState>("state").then(setState, (e: unknown) => setErr(errorText(e)));
    void call<S>("settings").then(setS, (e: unknown) => setErr(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const save = (patch: Partial<S>) => void call<S>("setSettings", patch).then(setS);
  if (!state || !s) return <div className="page">{err ?? "Loading…"}</div>;

  return (
    <div className="page" data-testid="reminders-settings">
      <p className="page__lead">Create reminders from the launcher (“remind call mom tomorrow 9am”) and review what’s due in the Reminders view. Everything stays in Apple Reminders.</p>
      <Group title="Access">
        <Row label="Reminders" hint={state.message && state.status !== "ok" ? `${STATUS[state.status] ?? state.status} · ${state.message}` : (STATUS[state.status] ?? state.status)}>
          {state.status === "notDetermined" && (
            <button type="button" className="btn btn--sm" onClick={() => void call<RemindersState>("requestAccess").then(setState)}>
              Grant Access…
            </button>
          )}
          {(state.status === "denied" || state.status === "restricted") && (
            <button type="button" className="btn btn--sm" onClick={() => void call("openPrivacySettings")}>
              Open Settings…
            </button>
          )}
        </Row>
      </Group>
      <Group title="Defaults">
        <Row label="Default list" hint="Used when the text has no #list tag">
          <select className="select" value={s.defaultListId} disabled={state.status !== "ok"} onChange={(e) => save({ defaultListId: e.target.value })}>
            <option value="">Reminders default</option>
            {state.lists.filter((l) => l.writable).map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Show completed reminders" hint="Include completed items in the Reminders view">
          <Toggle label="Show completed reminders" checked={s.showCompleted} onChange={(v) => save({ showCompleted: v })} />
        </Row>
      </Group>
    </div>
  );
}
