import { useEffect, useRef, useState } from "react";
import type { SearchItem } from "@shared/types";
import { Group, Row, Toggle } from "../../components/form";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { Kbd } from "../../components/Kbd";
import { glide } from "../../lib/glide";
import { defaultTrigger, describeTrigger, TRIGGER_KINDS, type AutomationsState, type Target, type Trigger, type TriggerKind } from "../../../main/features/automations/model";
import { automationsCall } from "./common";

export interface Draft {
  id: string;
  name: string;
  enabled: boolean;
  askBeforeRunning: boolean;
  /** once the user flips "ask before running" we stop recomputing its default */
  askTouched: boolean;
  trigger: Trigger;
  target: Target | null;
  isNew: boolean;
}

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_TITLES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function riskyTarget(target: Target | null, workflows: AutomationsState["workflows"]): boolean {
  if (!target) return false;
  if (target.kind === "command") return !/^(app|quicklink):/.test(target.itemId);
  return workflows.find((w) => w.id === target.workflowId)?.risky ?? true;
}

interface Props {
  draft: Draft;
  workflows: AutomationsState["workflows"];
  onChange(next: Draft): void;
  /** focus the first field when this increments (Enter on the list) */
  focusSignal: number;
}

export function Editor({ draft, workflows, onChange, focusSignal }: Props) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal) nameRef.current?.focus();
  }, [focusSignal]);

  const set = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch };
    if (patch.target !== undefined && !next.askTouched) next.askBeforeRunning = riskyTarget(next.target, workflows);
    onChange(next);
  };
  const setTrigger = (patch: Partial<Trigger>) => set({ trigger: { ...draft.trigger, ...patch } as Trigger });
  const t = draft.trigger;
  const risky = riskyTarget(draft.target, workflows);

  return (
    <div className="automations-editor__form">
      <Group title="Automation">
        <Row label="Name" htmlFor="automation-name">
          <input id="automation-name" ref={nameRef} className="input automations-input--wide" value={draft.name} placeholder={describeTrigger(t)} onChange={(e) => set({ name: e.target.value })} />
        </Row>
        <Row label="Enabled" hint="Disabled automations never fire on their own">
          <Toggle checked={draft.enabled} label="Enabled" onChange={(v) => set({ enabled: v })} />
        </Row>
      </Group>

      <Group title="When">
        <Row label="Trigger" htmlFor="automation-trigger">
          <select id="automation-trigger" className="select" value={t.kind} onChange={(e) => set({ trigger: defaultTrigger(e.target.value as TriggerKind) })}>
            {TRIGGER_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.icon} {k.title}
              </option>
            ))}
          </select>
        </Row>
        <TriggerFields trigger={t} setTrigger={setTrigger} />
      </Group>

      <Group title="Do" footer={draft.target?.kind === "command" ? "{{input}} in the argument is replaced by the trigger's value (the added file, the app name, the network…)." : "The trigger's value (the added file's path, the app name, the network…) is the workflow's {{input}}."}>
        <TargetFields target={draft.target} workflows={workflows} onChange={(target) => set({ target })} />
      </Group>

      <Group title="Safety" footer="Automatic runs are limited to once every 10 seconds per automation, so an automation can't trigger itself in a loop.">
        <Row label="Ask before running" hint={risky ? "Recommended — this can run scripts, type, send requests or open files." : "Shows a notification with Run / Skip first."}>
          <Toggle checked={draft.askBeforeRunning} label="Ask before running" onChange={(v) => set({ askBeforeRunning: v, askTouched: true })} />
        </Row>
      </Group>
    </div>
  );
}

function TriggerFields({ trigger: t, setTrigger }: { trigger: Trigger; setTrigger(p: Partial<Trigger>): void }) {
  const [network, setNetwork] = useState<string | null | undefined>(undefined);
  switch (t.kind) {
    case "time":
      return (
        <>
          <Row label="Time" htmlFor="automation-time">
            <input id="automation-time" className="input" type="time" value={t.time} onChange={(e) => e.target.value && setTrigger({ time: e.target.value })} />
          </Row>
          <Row label="Days" hint={t.days.length ? describeTrigger(t).replace(/ at .*/, "") : "Every day"}>
            <div className="automations-days" role="group" aria-label="Days of week">
              {DAYS.map((d, i) => {
                const on = t.days.length === 0 || t.days.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    className={`automations-day ${on ? "automations-day--on" : ""}`}
                    aria-pressed={on}
                    title={DAY_TITLES[i]}
                    onClick={() => {
                      const all = t.days.length ? t.days : [0, 1, 2, 3, 4, 5, 6];
                      const next = all.includes(i) ? all.filter((x) => x !== i) : [...all, i];
                      if (next.length) setTrigger({ days: next.length === 7 ? [] : next.sort() });
                    }}
                  >
                    {d}
                  </button>
                );
              })}
              <button type="button" className="btn btn--sm" onClick={() => setTrigger({ days: [1, 2, 3, 4, 5] })}>
                Weekdays
              </button>
            </div>
          </Row>
        </>
      );
    case "interval":
      return (
        <Row label="Every" hint="minutes (1 or more)" htmlFor="automation-minutes">
          <input id="automation-minutes" className="input automations-input--num" type="number" min={1} value={t.minutes} onChange={(e) => setTrigger({ minutes: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
        </Row>
      );
    case "app":
      return (
        <>
          <Row label="Event">
            <select className="select" aria-label="App event" value={t.event} onChange={(e) => setTrigger({ event: e.target.value as typeof t.event })}>
              <option value="launched">Launches</option>
              <option value="quit">Quits</option>
              <option value="activated">Becomes active</option>
            </select>
          </Row>
          <Row label="App" hint="Name or bundle id; leave empty for any app" htmlFor="automation-app">
            <AppInput value={t.app} onChange={(app) => setTrigger({ app })} />
          </Row>
        </>
      );
    case "wifi":
      return (
        <>
          <Row label="Event">
            <select className="select" aria-label="Wi-Fi event" value={t.event} onChange={(e) => setTrigger({ event: e.target.value as typeof t.event })}>
              <option value="joined">Joining a network</option>
              <option value="left">Leaving a network</option>
              <option value="changed">Network changes</option>
            </select>
          </Row>
          {t.event !== "changed" && (
            <Row label="Network" hint={network === null ? "Not connected to Wi‑Fi right now" : "Empty = any network. macOS hides Wi‑Fi names from apps without Location access; “Use Current” stores a router signature instead."} align="start" htmlFor="automation-network">
              <input id="automation-network" className="input" value={t.network} placeholder="Any network" onChange={(e) => setTrigger({ network: e.target.value })} />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  void automationsCall<string | null>("currentNetwork").then((n) => {
                    setNetwork(n);
                    if (n) setTrigger({ network: n });
                  })
                }
              >
                Use Current
              </button>
            </Row>
          )}
        </>
      );
    case "power":
      return (
        <>
          <Row label="Event">
            <select className="select" aria-label="Power event" value={t.event} onChange={(e) => setTrigger({ event: e.target.value as typeof t.event })}>
              <option value="ac">Connected to power</option>
              <option value="battery">Switched to battery</option>
              <option value="below">Battery drops to…</option>
              <option value="above">Battery charges to…</option>
            </select>
          </Row>
          {(t.event === "below" || t.event === "above") && (
            <Row label="Level" hint="percent" htmlFor="automation-percent">
              <input id="automation-percent" className="input automations-input--num" type="number" min={1} max={100} value={t.percent} onChange={(e) => setTrigger({ percent: Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
            </Row>
          )}
        </>
      );
    case "display":
      return (
        <Row label="Event">
          <select className="select" aria-label="Display event" value={t.event} onChange={(e) => setTrigger({ event: e.target.value as typeof t.event })}>
            <option value="connected">A display is connected</option>
            <option value="disconnected">A display is disconnected</option>
            <option value="any">Either</option>
          </select>
        </Row>
      );
    case "folder":
      return (
        <>
          <Row label="Folder" htmlFor="automation-folder">
            <input id="automation-folder" className="input" value={t.path} onChange={(e) => setTrigger({ path: e.target.value })} />
            <button type="button" className="btn btn--sm" onClick={() => void automationsCall<string | null>("chooseFolder").then((p) => p && setTrigger({ path: p }))}>
              Choose…
            </button>
          </Row>
          <Row label="Event" hint={t.event === "added" ? "The new file's path is passed as input (hidden files and partial downloads are ignored)" : "Any change inside the folder (not subfolders)"}>
            <select className="select" aria-label="Folder event" value={t.event} onChange={(e) => setTrigger({ event: e.target.value as typeof t.event })}>
              <option value="added">A file is added</option>
              <option value="any">Anything changes</option>
            </select>
          </Row>
        </>
      );
    case "launch":
      return <Row label="Runs a few seconds after Glide starts (including at login, if enabled in General)." align="start"><span /></Row>;
    case "hotkey":
      return (
        <Row label="Hotkey" hint="Works in any app">
          <HotkeyRecorder value={t.accelerator || undefined} onChange={(a) => setTrigger({ accelerator: a ?? "" })} />
        </Row>
      );
  }
}

function AppInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [apps, setApps] = useState<string[]>([]);
  useEffect(() => {
    void glide()
      .listApps()
      .then((list) => setApps([...new Set(list.map((a) => a.title))].sort()));
  }, []);
  return (
    <>
      <input id="automation-app" className="input" list="automations-apps" value={value} placeholder="Any app" onChange={(e) => onChange(e.target.value)} />
      <datalist id="automations-apps">
        {apps.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
    </>
  );
}

function TargetFields({ target, workflows, onChange }: { target: Target | null; workflows: AutomationsState["workflows"]; onChange(t: Target): void }) {
  const kind = target?.kind ?? "workflow";
  return (
    <>
      <Row label="Run">
        <div className="automations-seg" role="radiogroup" aria-label="Run a workflow or a command">
          {(["workflow", "command"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={`automations-seg__btn ${kind === k ? "automations-seg__btn--on" : ""}`}
              onClick={() => k !== kind && onChange(k === "workflow" ? { kind: "workflow", workflowId: workflows[0]?.id ?? "" } : { kind: "command", itemId: "", title: "", argument: "" })}
            >
              {k === "workflow" ? "Workflow" : "Command"}
            </button>
          ))}
        </div>
      </Row>
      {kind === "workflow" ? (
        <Row label="Workflow" hint={workflows.length ? undefined : "No workflows yet — create one in Settings › Workflows"} htmlFor="automation-workflow">
          <select id="automation-workflow" className="select" value={target?.kind === "workflow" ? target.workflowId : ""} onChange={(e) => onChange({ kind: "workflow", workflowId: e.target.value })}>
            <option value="" disabled>
              Choose a workflow…
            </option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.risky ? " ⚠︎" : ""}
              </option>
            ))}
          </select>
        </Row>
      ) : (
        <CommandPicker target={target?.kind === "command" ? target : null} onChange={onChange} />
      )}
    </>
  );
}

/** Search the launcher catalogue (same engine as the launcher) and pick an item; ↑/↓ + ⏎ to choose. */
function CommandPicker({ target, onChange }: { target: Extract<Target, { kind: "command" }> | null; onChange(t: Target): void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let live = true;
    void glide()
      .search(q)
      .then((r) => {
        if (!live) return;
        const items = r.sections.flatMap((s) => s.items.map((i) => i.item)).filter((i) => i.feature !== "automations" && i.kind !== "calculator" && i.kind !== "fallback" && i.kind !== "file");
        setResults(items.slice(0, 6));
        setSel(0);
      });
    return () => {
      live = false;
    };
  }, [q]);
  const pick = (i: SearchItem) => {
    onChange({ kind: "command", itemId: i.id, title: i.title, argument: target?.argument ?? "" });
    setQ("");
  };
  return (
    <>
      <Row label="Command" hint={target?.itemId ? <span className="mono">{target.itemId}</span> : "Search for any launcher command, app, quicklink or workflow"} align="start" htmlFor="automation-command">
        <div className="automations-picker">
          <input
            id="automation-command"
            className="input automations-input--wide"
            value={q}
            placeholder={target?.title || "Search commands…"}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (!results.length) return;
              if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) setSel((s) => Math.min(results.length - 1, s + 1));
              else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) setSel((s) => Math.max(0, s - 1));
              else if (e.key === "Enter") pick(results[sel]!);
              else return;
              e.preventDefault();
            }}
          />
          {results.length > 0 && (
            <ul className="automations-picker__list" role="listbox" aria-label="Matching commands">
              {results.map((i, idx) => (
                <li key={i.id} role="option" aria-selected={idx === sel} className={`automations-picker__item ${idx === sel ? "automations-picker__item--on" : ""}`} onMouseDown={(e) => (e.preventDefault(), pick(i))}>
                  <span>{i.title}</span>
                  <span className="faint">{i.kindLabel ?? i.kind}</span>
                </li>
              ))}
            </ul>
          )}
          {target?.title && !q && (
            <div className="automations-picker__chosen">
              Selected: <strong>{target.title}</strong> <Kbd keys="⏎" /> to change after searching
            </div>
          )}
        </div>
      </Row>
      {target?.itemId && (
        <Row label="Argument" hint="Optional; for commands that take text (quicklinks, workflows with input…)" htmlFor="automation-argument">
          <input id="automation-argument" className="input" value={target.argument} placeholder="{{input}}" onChange={(e) => onChange({ ...target, argument: e.target.value })} />
        </Row>
      )}
    </>
  );
}
