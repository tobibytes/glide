import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { ConfirmKill } from "./Confirm";
import { procCall, usePoll, type KillRisk, type PendingKill, type PortListener, type SignalResult } from "./common";

type Row = NavItem & { l: PortListener };

const portOf = (q: string): number | undefined => {
  const m = /^\s*(?:port\s*:?\s*|:)?(\d{1,5})\s*$/i.exec(q);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 65535 ? n : undefined;
};

export function PortsView({ props, query, setQuery, setPlaceholder, toast }: ViewProps<{ port?: number; confirmPid?: number }>) {
  useEffect(() => setPlaceholder("Type a port number (3000) or filter listening processes…"), [setPlaceholder]);
  useEffect(() => {
    if (props.port) setQuery(String(props.port));
  }, [props.port, setQuery]);
  const port = portOf(query);
  // All listeners are fetched once per refresh; a typed port narrows them client-side.
  const [all, reload] = usePoll(() => procCall<PortListener[]>("listeners"), 3000);
  const [pending, setPending] = useState<PendingKill | null>(null);

  const rows = useMemo((): Row[] => {
    if (!all) return [];
    const q = query.trim().toLowerCase();
    const list = port ? all.filter((l) => l.port === port) : q ? all.filter((l) => l.command.toLowerCase().includes(q) || String(l.port).includes(q)) : all;
    return list.map((l) => ({ id: `${l.pid}:${l.port}`, l }));
  }, [all, query, port]);

  const ask = useCallback(async (l: PortListener, sig: PendingKill["sig"]) => {
    const risk = await procCall<KillRisk>("risk", l.pid);
    const base = `Stops the process listening on ${l.address}. ${sig === "SIGKILL" ? "It cannot clean up first." : "It may take a moment to exit."}`;
    setPending({ pid: l.pid, name: l.command, command: "", sig, reason: risk.level === "warn" ? `⚠️ ${risk.reason}` : base });
  }, []);

  // Arriving from root search's "Kill Listener…" asks right away.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !props.confirmPid || !all) return;
    const l = all.find((x) => x.pid === props.confirmPid);
    if (l) void ask(l, "SIGTERM");
    asked.current = true;
  }, [props.confirmPid, all, ask]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    setPending(null);
    const r = await procCall<SignalResult>("signal", pending.pid, pending.sig, { confirmed: true });
    toast(r.ok ? (r.message ?? "Done") : (r.error ?? "Failed"), r.ok ? "info" : "error");
    setTimeout(reload, 400);
  }, [pending, toast, reload]);
  const cancel = useCallback(() => setPending(null), []);

  const actions = useCallback(
    (r: Row): NavAction[] => [
      { id: "kill", title: "Kill Process…", shortcut: "⏎", icon: "⏹", destructive: true, run: () => void ask(r.l, "SIGTERM") },
      { id: "force", title: "Force Kill Process…", shortcut: "⌘⏎", icon: "💀", destructive: true, run: () => void ask(r.l, "SIGKILL") },
      { id: "pid", title: "Copy PID", shortcut: "⇧⌘C", run: () => void procCall("copy", String(r.l.pid)).then(() => toast(`Copied PID ${r.l.pid}`)) },
      { id: "url", title: "Copy localhost URL", shortcut: "⇧⌘U", run: () => void procCall("copy", `http://localhost:${r.l.port}`).then(() => toast("Copied URL")) },
      { id: "am", title: "Show in Activity Monitor", shortcut: "⌘M", run: () => void procCall("activityMonitor") },
    ],
    [ask, toast],
  );

  const empty = !all ? "Loading…" : port ? `Nothing is listening on TCP port ${port}` : "No listening TCP ports";
  return (
    <div className="processes-view">
      <div className="processes-toolbar">
        <span>{all ? (port ? `Port ${port}` : `${all.length} listening sockets`) : "Loading…"}</span>
        <span className="processes-toolbar__hint">⏎ kill · ⌘⏎ force kill · both ask first</span>
      </div>
      {pending && <ConfirmKill pending={pending} onConfirm={() => void confirm()} onCancel={cancel} />}
      <NavList<Row>
        items={rows}
        actions={actions}
        emptyText={empty}
        onActivate={(r, m) => void ask(r.l, m.cmd ? "SIGKILL" : "SIGTERM")}
        renderItem={(r, selected) => (
          <div className={`row processes-row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--md">🔌</span>
            <div className="row__main">
              <span className="row__title">
                {r.l.command} <span className="processes-port mono">:{r.l.port}</span>
              </span>
              <span className="row__subtitle">
                PID {r.l.pid} · {r.l.user} · {r.l.address}
              </span>
            </div>
            <span className="row__kind">{r.l.protocol}</span>
          </div>
        )}
      />
    </div>
  );
}
