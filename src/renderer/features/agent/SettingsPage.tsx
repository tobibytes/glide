/** Settings → Agent: per-tool "Allow without asking" and where the model/key come from. */
import { useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { agent, type AgentSettings, type AgentStatus, type ToolInfo } from "./api";

export function AgentSettingsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    void Promise.all([agent.listTools(), agent.getSettings(), agent.status()]).then(([t, s, st]) => {
      setTools(t);
      setSettings(s);
      setStatus(st);
    });
  }, []);

  if (!settings || !status) return <div className="page">Loading…</div>;

  const setAllow = async (name: string, on: boolean) => setSettings(await agent.setSettings({ allow: { ...settings.allow, [name]: on } }));
  const mutating = tools.filter((t) => t.mutating);
  const readOnly = tools.filter((t) => !t.mutating);

  return (
    <div className="page agent-settings" data-testid="agent-settings">
      <p className="page__lead">
        Glide Agent turns a sentence into actions — “put Safari left and Notes right, start a 25 min timer”. Open it from the launcher with <b>Ask Glide Agent</b> (Tab to type the request) or the “Ask Glide Agent” row under any search.
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

      <Group title="Allow without asking" footer="Off (default): Glide shows exactly what will happen and waits for ⏎ before running these. Read-only tools never ask.">
        {mutating.map((t) => (
          <Row key={t.name} label={t.title} hint={t.description}>
            <Toggle checked={settings.allow[t.name] === true} onChange={(v) => void setAllow(t.name, v)} label={`Allow ${t.title} without asking`} />
          </Row>
        ))}
      </Group>

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
