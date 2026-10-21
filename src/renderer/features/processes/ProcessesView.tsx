import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { NavList } from "../../components/NavList";
import type { NavAction, NavItem, ViewProps } from "../types";
import { ConfirmKill } from "./Confirm";
import { formatKb, procCall, usePoll, type PendingKill, type ProcessInfo, type ProcList, type SignalResult } from "./common";

type Row = NavItem & { p: ProcessInfo };

const SHOWN = 300;

export function ProcessesView({ query, setPlaceholder, toast }: ViewProps) {
  useEffect(() => setPlaceholder("Filter processes by name, PID or path…"), [setPlaceholder]);
  const [data, reload] = usePoll(() => procCall<ProcList>("list"), 2000);
  const [pending, setPending] = useState<PendingKill | null>(null);

  const rows = useMemo((): Row[] => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const list = q ? data.processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid) === q || p.command.toLowerCase().includes(q)) : data.processes;
    return list.slice(0, SHOWN).map((p) => ({ id: String(p.pid), p }));
  }, [data, query]);

  const signal = useCallback(
    async (p: ProcessInfo, sig: PendingKill["sig"], confirmed: boolean) => {
      const r = await procCall<SignalResult>("signal", p.pid, sig, { confirmed, expectedCommand: p.command });
      if (r.needsConfirm) {
        setPending({ pid: p.pid, name: p.name, command: p.command, sig, reason: r.reason ?? "" });
        return;
      }
      toast(r.ok ? (r.message ?? "Done") : (r.error ?? "Failed"), r.ok ? "info" : "error");
      if (r.ok) setTimeout(reload, 300);
    },
    [toast, reload],
  );

  const actions = useCallback(
    (r: Row): NavAction[] => [
      { id: "quit", title: "Quit Process", shortcut: "⏎", icon: "⏹", run: () => signal(r.p, "SIGTERM", false) },
      { id: "force", title: "Force Quit Process…", shortcut: "⌘⏎", icon: "💀", destructive: true, run: () => signal(r.p, "SIGKILL", false) },
      { id: "pid", title: "Copy PID", shortcut: "⇧⌘C", icon: "📋", run: () => void procCall("copy", String(r.p.pid)).then(() => toast(`Copied PID ${r.p.pid}`)) },
      { id: "path", title: "Copy Path", shortcut: "⇧⌘.", run: () => void procCall("copy", r.p.command).then(() => toast("Copied path")) },
      { id: "am", title: "Show in Activity Monitor", shortcut: "⌘M", icon: "📊", run: () => void procCall("activityMonitor") },
    ],
    [signal, toast],
  );

  const confirm = useCallback(() => {
    if (!pending) return;
    const p = data?.processes.find((x) => x.pid === pending.pid);
    setPending(null);
    void signal(p ?? ({ pid: pending.pid, name: pending.name, command: pending.command } as ProcessInfo), pending.sig, true);
  }, [pending, data, signal]);
  const cancel = useCallback(() => setPending(null), []);

  const totalCpu = data ? data.processes.reduce((a, p) => a + p.cpu, 0) : 0;
  return (
    <div className="processes-view">
      <div className="processes-toolbar">
        <span>{data ? `${data.processes.length} processes · ${totalCpu.toFixed(0)}% CPU total` : "Loading…"}</span>
        <span className="processes-toolbar__hint">Refreshes every 2 s · ⏎ quit · ⌘⏎ force quit · ⌘K more</span>
      </div>
      {pending && <ConfirmKill pending={pending} onConfirm={confirm} onCancel={cancel} />}
      <NavList<Row>
        items={rows}
        actions={actions}
        emptyText={data ? "No matching processes" : "Loading…"}
        onActivate={(r, m) => void signal(r.p, m.cmd ? "SIGKILL" : "SIGTERM", false)}
        renderItem={(r, selected) => (
          <div className={`row processes-row ${selected ? "row--selected" : ""}`}>
            <Icon icon={r.p.appPath ? { kind: "app", value: r.p.appPath } : { kind: "emoji", value: "⚙️" }} />
            <div className="row__main">
              <span className="row__title">{r.p.name}</span>
              <span className="row__subtitle">
                PID {r.p.pid} · {r.p.user}
                {data?.selfPids.includes(r.p.pid) ? " · Glide" : ""}
              </span>
            </div>
            <span className="processes-metric mono" title="CPU">
              {r.p.cpu.toFixed(1)}%
            </span>
            <span className="processes-metric processes-metric--mem mono" title="Memory (resident)">
              {formatKb(r.p.rssKb)}
            </span>
          </div>
        )}
      />
    </div>
  );
}
