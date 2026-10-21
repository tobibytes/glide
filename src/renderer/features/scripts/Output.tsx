import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewProps, NavAction } from "../types";
import { glide } from "../../lib/glide";
import { useNavController, useNavHost } from "../../lib/navHost";
import { eventMatchesShortcut } from "../../lib/keys";
import { ActionPanel } from "../../components/ActionPanel";
import { Kbd } from "../../components/Kbd";
import type { OutputChunk, RunExit, RunSnapshot } from "../../../main/features/scripts/types";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("scripts", method, ...args);

export function ScriptOutput({ props, toast, setPlaceholder }: ViewProps<{ runId?: string }>) {
  const host = useNavHost();
  const [runId, setRunId] = useState(typeof props.runId === "string" ? props.runId : "");
  const [meta, setMeta] = useState<Omit<RunSnapshot, "chunks"> | null>(null);
  const [chunks, setChunks] = useState<Map<number, OutputChunk>>(new Map());
  const [panel, setPanel] = useState<NavAction[] | null>(null);
  const [now, setNow] = useState(Date.now());
  const preRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => setPlaceholder("Script output"), [setPlaceholder]);

  useEffect(() => {
    if (!runId) return;
    setChunks(new Map());
    setMeta(null);
    // Subscribe first, then merge the snapshot by sequence number so nothing is lost or doubled.
    const off = glide().onFeatureEvent((e) => {
      if (e.feature !== "scripts") return;
      const p = e.payload as (OutputChunk & RunExit) | undefined;
      if (!p || p.runId !== runId) return;
      if (e.event === "output") setChunks((m) => new Map(m).set(p.seq, p));
      if (e.event === "exit") setMeta((m) => (m ? { ...m, done: true, code: p.code, error: p.error, endedAt: p.endedAt } : m));
    });
    void call<RunSnapshot | null>("getRun", runId).then((snap) => {
      if (!snap) return;
      const { chunks: list, ...rest } = snap;
      setMeta((m) => (m?.done ? { ...rest, ...m } : rest));
      setChunks((m) => {
        const next = new Map(m);
        for (const c of list) next.set(c.seq, c);
        return next;
      });
    });
    return off;
  }, [runId]);

  useEffect(() => {
    if (meta?.done) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [meta?.done]);

  const ordered = useMemo(() => [...chunks.values()].sort((a, b) => a.seq - b.seq), [chunks]);
  const text = useMemo(() => ordered.map((c) => c.text).join(""), [ordered]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [ordered]);

  const copy = () => void navigator.clipboard.writeText(text).then(() => toast("Output copied"));
  const rerun = async () => {
    const res = await call<{ ok: boolean; runId?: string; error?: string }>("rerun", runId);
    if (res.runId) {
      stick.current = true;
      setRunId(res.runId);
    } else toast(res.error ?? "Could not rerun", "error");
  };
  const stop = () => void call("stopRun", runId);

  const actions: NavAction[] = [
    { id: "copy", title: "Copy Output", shortcut: "⏎", run: copy },
    { id: "rerun", title: "Run Again", shortcut: "⌘R", run: rerun },
    ...(meta && !meta.done ? [{ id: "stop", title: "Stop Script", shortcut: "⌘.", destructive: true, run: stop }] : []),
  ];

  const scrollBy = (lines: number) => {
    const el = preRef.current;
    if (!el) return;
    el.scrollTop += lines * 18;
    stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  };

  useEffect(() => {
    host?.setFooter({ primary: "Copy Output", hasActions: true });
    return () => host?.setFooter(null);
  }, [host]);

  useNavController({
    nav: (c) => {
      const el = preRef.current;
      if (!el) return;
      if (c.type === "move") scrollBy(c.delta * 3);
      else if (c.type === "halfPage") scrollBy(c.dir * c.count * Math.floor(el.clientHeight / 36));
      else if (c.type === "goto") {
        el.scrollTop = c.index === "last" ? el.scrollHeight : 0;
        stick.current = c.index === "last";
      }
    },
    activate: copy,
    secondary: () => void rerun(),
    toggleActions: () => setPanel((p) => (p ? null : actions)),
    findAction: async (kind) => (kind === "copy" ? { title: "Copy Output", run: copy } : kind === "delete" && meta && !meta.done ? { title: "Stop Script", run: stop } : null),
    shortcut: (e) => {
      const hit = actions.find((a) => a.shortcut && a.shortcut !== "⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) void hit.run();
      return !!hit;
    },
  });

  const elapsed = meta ? Math.max(0, ((meta.endedAt ?? now) - meta.startedAt) / 1000) : 0;
  const status = !meta ? "Starting…" : !meta.done ? "Running…" : meta.error ? meta.error : meta.code === 0 ? "Finished" : `Exited with code ${meta.code}`;
  const bad = !!meta?.done && (meta.code !== 0 || !!meta.error);

  return (
    <div className="scripts-out">
      <div className="scripts-out__head">
        <span className="scripts-out__icon">{meta?.icon && !/[./]/.test(meta.icon) ? meta.icon : "📜"}</span>
        <span className="scripts-out__title">{meta?.title ?? "Script"}</span>
        <span className={`scripts-out__status ${bad ? "scripts-out__status--bad" : meta?.done ? "scripts-out__status--ok" : ""}`}>
          {!meta?.done && <span className="scripts-out__spinner" aria-hidden="true" />}
          {status} · {elapsed.toFixed(1)} s
        </span>
      </div>
      <pre
        ref={preRef}
        className="scripts-out__pre"
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        }}
      >
        {ordered.length === 0 && <span className="faint">{meta?.done ? "(no output)" : "Waiting for output…"}</span>}
        {ordered.map((c) => (
          <span key={c.seq} className={c.stream === "stderr" ? "scripts-out__err" : undefined}>
            {c.text}
          </span>
        ))}
      </pre>
      <div className="scripts-out__keys faint">
        <span>
          <Kbd keys="⏎" /> copy
        </span>
        <span>
          <Kbd keys="⌘R" /> run again
        </span>
        {meta && !meta.done && (
          <span>
            <Kbd keys="⌘." /> stop
          </span>
        )}
        <span>
          <Kbd keys="⌃J ⌃K" /> scroll
        </span>
        <span>
          <Kbd keys="⌘K" /> actions
        </span>
      </div>
      {panel && (
        <ActionPanel
          title="Script Output"
          actions={panel}
          onRun={(a) => {
            setPanel(null);
            host?.focusSearch();
            void a.run();
          }}
          onClose={() => {
            setPanel(null);
            host?.focusSearch();
          }}
        />
      )}
    </div>
  );
}
