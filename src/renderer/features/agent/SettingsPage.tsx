/** Settings → Agent: safety (read-only mode, per-tool "Allow without asking"), history and privacy, launcher shortcut. */
import { useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { Kbd } from "../../components/Kbd";
import { agent, type AgentSettings, type AgentStatus, type ToolInfo } from "./api";
import { McpServersSection } from "./McpServers";

export function AgentSettingsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [cleared, setCleared] = useState<number | null>(null);

  useEffect(() => {
    void Promise.all([agent.listTools(), agent.getSettings(), agent.status()]).then(([t, s, st]) => {
      setTools(t);
      setSettings(s);
      setStatus(st);
    });
  }, []);

  if (!settings || !status) return <div className="page">Loading…</div>;

  const patch = async (p: Partial<AgentSettings>) => setSettings(await agent.setSettings(p));
  const setAllow = (name: string, on: boolean) => void patch({ allow: { ...settings.allow, [name]: on } });
  const available = tools.filter((t) => t.available);
  const mutating = available.filter((t) => t.mutating && !t.alwaysConfirm);
  const always = available.filter((t) => t.alwaysConfirm);
  const readOnly = available.filter((t) => !t.mutating && t.name !== "plan");

  return (
    <div className="page agent-settings" data-testid="agent-settings">
      <p className="page__lead">
        Glide Agent turns a sentence into actions — “put Safari left and Notes right, start a 25 min timer”. Type a request in the launcher and press <Kbd keys="⌘⏎" />, or use <b>Ask Glide Agent</b>. Follow-ups keep the conversation's context; <Kbd keys="⌘Z" /> undoes what can be undone.
      </p>

      <Group title="Model" footer="The agent uses the API key, model and effort from Settings → AI. At most 12 tool calls run per request.">
        <Row label="Model">
          <span className="agent-settings__value">{status.model}</span>
        </Row>
        <Row label="API key">
          <span className={status.hasKey ? "agent-badge agent-badge--ok" : "agent-badge"}>{status.mock ? "Mock client (test hook)" : status.hasKey ? "Saved" : "Not set"}</span>
          {!status.hasKey && (
            <button type="button" className="btn" onClick={() => void agent.openAiSettings()}>
              Open Settings → AI
            </button>
          )}
        </Row>
      </Group>

      <Group title="Safety" footer="Read-only mode offers the agent only lookup tools: it can answer questions but not change anything. Quitting processes and running shortcuts always ask, are limited to 3 per minute, and core macOS processes are never quit.">
        <Row label="Read-only mode" hint="Only look things up; never change anything">
          <Toggle checked={settings.readOnly} onChange={(v) => void patch({ readOnly: v })} label="Read-only mode" />
        </Row>
      </Group>

      <Group title="Launcher" footer="When on, ⌘⏎ in the root search sends the query to the agent instead of running the selected row's secondary action (still available in ⌘K).">
        <Row label="⌘⏎ asks Glide Agent">
          <Toggle checked={settings.launcherShortcut} onChange={(v) => void patch({ launcherShortcut: v })} label="Command-Return sends the query to Glide Agent" />
        </Row>
      </Group>

      <Group title="History & privacy" footer="Conversations are stored on this Mac only. Clipboard, clipboard-history and selected-text contents are replaced with “[redacted]” in saved history unless you turn on the second switch.">
        <Row label="Save conversations" hint="Search and resume them from Glide Agent History (⌘Y)">
          <Toggle checked={settings.saveHistory} onChange={(v) => void patch({ saveHistory: v })} label="Save conversations" />
        </Row>
        <Row label="Keep clipboard & selection text in history">
          <Toggle checked={settings.keepSensitive} onChange={(v) => void patch({ keepSensitive: v })} label="Keep clipboard and selection text in saved history" />
        </Row>
        <Row label="Saved conversations">
          <button
            type="button"
            className="btn"
            onClick={() =>
              void agent.clearHistory().then((n) => {
                setCleared(n);
              })
            }
          >
            Delete All…
          </button>
          {cleared !== null && <span className="agent-settings__value">Deleted {cleared}</span>}
        </Row>
      </Group>

      <Group title="Allow without asking" footer="Off (default): Glide shows exactly what will happen and waits for ⏎ before running these.">
        {mutating.map((t) => (
          <Row key={t.name} label={t.title} hint={t.description}>
            <Toggle checked={settings.allow[t.name] === true} onChange={(v) => setAllow(t.name, v)} label={`Allow ${t.title} without asking`} />
          </Row>
        ))}
      </Group>

      <Group title="Always ask">
        {always.map((t) => (
          <Row key={t.name} label={t.title} hint={t.description}>
            <span className="agent-settings__value">Asks every time{t.destructive ? " · rate-limited" : ""}</span>
          </Row>
        ))}
      </Group>

      <McpServersSection settings={settings} onAllow={setAllow} />

      <Group title="Read-only tools (always allowed)">
        {readOnly.map((t) => (
          <Row key={t.name} label={t.title} hint={t.description}>
            <span className="agent-settings__value">Runs directly</span>
          </Row>
        ))}
      </Group>
    </div>
  );
}
