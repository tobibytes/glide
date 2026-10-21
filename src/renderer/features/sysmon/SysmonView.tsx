import { useCallback, useEffect, useMemo, useState } from "react";
import { NavList } from "../../components/NavList";
import { glide } from "../../lib/glide";
import type { NavAction, NavItem, ViewProps } from "../types";
import { formatBytes, formatRate, formatUptime } from "../../../main/features/sysmon/parse";
import type { SysState, TopProcess } from "../../../main/features/sysmon";
import { Sparkline } from "./Sparkline";

type Row = NavItem & { p: TopProcess };

const pct = (x: number) => `${Math.round(x * 100)}%`;
const level = (x: number) => (x >= 0.85 ? "is-high" : x >= 0.6 ? "is-mid" : "");

function Meter({ value }: { value: number }) {
  return (
    <span className={`sysmon-meter ${level(value)}`} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </span>
  );
}

export function SysmonView({ setPlaceholder, push, toast }: ViewProps) {
  useEffect(() => setPlaceholder("System Monitor · ⏎ on a process opens Kill Process"), [setPlaceholder]);
  const [state, setState] = useState<SysState | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void glide().feature<SysState>("sysmon", "sample").then((s) => alive && setState(s), () => undefined);
    load();
    const t = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const rows = useMemo((): Row[] => (state?.sample.top ?? []).map((p) => ({ id: String(p.pid), section: "Top Processes (CPU)", p })), [state]);
  const actions = useCallback(
    (r: Row): NavAction[] => [
      { id: "kill", title: "Show in Kill Process", shortcut: "⏎", run: () => push({ id: "processes.list" }) },
      { id: "pid", title: "Copy PID", shortcut: "⇧⌘C", run: () => void navigator.clipboard.writeText(String(r.p.pid)).then(() => toast(`Copied PID ${r.p.pid}`)) },
    ],
    [push, toast],
  );

  if (!state) return <div className="navlist__empty">Sampling…</div>;
  const { sample: s, history: h } = state;
  const mem = s.memory;
  const disk = s.disk;
  const bat = s.battery;
  return (
    <div className="sysmon-view">
      <div className="sysmon-grid">
        <section className="sysmon-card" aria-label="CPU">
          <header>
            <span>CPU</span>
            <strong className="mono">{pct(s.cpu.total)}</strong>
          </header>
          <Sparkline values={h.cpu} max={1} label="CPU history" />
          <div className="sysmon-cores" aria-label={`${s.cpu.cores.length} cores`}>
            {s.cpu.cores.map((c, i) => (
              <span key={i} className={level(c)} title={`Core ${i + 1}: ${pct(c)}`}>
                <span style={{ height: `${Math.max(4, c * 100)}%` }} />
              </span>
            ))}
          </div>
          <footer className="mono">Load {s.cpu.load.map((l) => l.toFixed(2)).join(" ")}</footer>
        </section>
        <section className="sysmon-card" aria-label="Memory">
          <header>
            <span>Memory</span>
            <strong className="mono">{mem ? pct(mem.usedBytes / mem.totalBytes) : "—"}</strong>
          </header>
          <Sparkline values={h.mem} max={1} label="Memory history" />
          {mem && (
            <footer className="mono">
              {formatBytes(mem.usedBytes)} / {formatBytes(mem.totalBytes, 0)} · app {formatBytes(mem.appBytes)} · wired {formatBytes(mem.wiredBytes)} · comp {formatBytes(mem.compressedBytes)}
            </footer>
          )}
        </section>
        <section className="sysmon-card" aria-label="Network">
          <header>
            <span>Network</span>
            <strong className="mono">↓ {formatRate(s.net.rxPerSec)}</strong>
          </header>
          <div className="sysmon-net">
            <Sparkline values={h.rx} label="Download history" className="is-rx" />
            <Sparkline values={h.tx} label="Upload history" className="is-tx" />
          </div>
          <footer className="mono">↑ {formatRate(s.net.txPerSec)} · total ↓ {formatBytes(s.net.rxTotal)} ↑ {formatBytes(s.net.txTotal)}</footer>
        </section>
        <section className="sysmon-card" aria-label="Disk, battery and uptime">
          <div className="sysmon-line">
            <span>Disk</span>
            {disk ? (
              <>
                <Meter value={disk.usedBytes / disk.totalBytes} />
                <span className="mono">{formatBytes(disk.availableBytes, 0)} free</span>
              </>
            ) : (
              <span>—</span>
            )}
          </div>
          <div className="sysmon-line">
            <span>Battery</span>
            {bat ? (
              <>
                <Meter value={bat.percent / 100} />
                <span className="mono">
                  {bat.percent}% {bat.state === "charging" ? "⚡︎" : ""}
                  {bat.remainingMin ? ` · ${Math.floor(bat.remainingMin / 60)}:${String(bat.remainingMin % 60).padStart(2, "0")}` : ""}
                </span>
              </>
            ) : (
              <span className="sysmon-dim">No battery</span>
            )}
          </div>
          <div className="sysmon-line">
            <span>Uptime</span>
            <span className="mono">{formatUptime(s.uptimeSec)}</span>
          </div>
          <footer className="sysmon-dim">{s.cpu.model}</footer>
        </section>
      </div>
      <NavList<Row>
        items={rows}
        actions={actions}
        emptyText="Collecting processes…"
        onActivate={() => push({ id: "processes.list" })}
        renderItem={(r, selected) => (
          <div className={`row sysmon-row ${selected ? "row--selected" : ""}`}>
            <span className="icon icon--md">⚙️</span>
            <div className="row__main">
              <span className="row__title">{r.p.name}</span>
              <span className="row__subtitle">PID {r.p.pid}</span>
            </div>
            <span className="sysmon-metric mono">{r.p.cpu.toFixed(1)}%</span>
            <span className="sysmon-metric sysmon-dim mono">{formatBytes(r.p.rssKb * 1024)}</span>
          </div>
        )}
      />
    </div>
  );
}
