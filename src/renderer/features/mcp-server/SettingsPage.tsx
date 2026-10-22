import { useCallback, useEffect, useState } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { call, errorText, useLog, useMcpState, type LogEntry, type McpServerState, type Snippet } from "./api";

type Policy = "off" | "ask" | "allow";

const OUTCOME: Record<LogEntry["outcome"], string> = {
  ok: "Done",
  error: "Failed",
  denied: "Denied",
  timeout: "Timed out",
  off: "Tool off",
  "rate-limited": "Rate limited",
  invalid: "Invalid",
};

const time = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function SnippetBlock({ s, onCopy }: { s: Snippet; onCopy(text: string): void }) {
  const [reveal, setReveal] = useState(false);
  const [text, setText] = useState(s.text);
  useEffect(() => setText(s.text), [s.text]);
  const toggleReveal = () => {
    if (reveal) return setReveal(false);
    void call<Snippet[]>("snippets", true).then((all) => {
      setText(all.find((x) => x.id === s.id)?.text ?? s.text);
      setReveal(true);
    });
  };
  const copy = async () => {
    if (!s.secret) return onCopy(s.text);
    const all = await call<Snippet[]>("snippets", true);
    onCopy(all.find((x) => x.id === s.id)?.text ?? s.text);
  };
  return (
    <div className="mcp-server-snippet">
      <div className="mcp-server-snippet__head">
        <div>
          <div className="mcp-server-snippet__title">{s.title}</div>
          <div className="row__hint">{s.hint}</div>
        </div>
        <div className="mcp-server-snippet__btns">
          {s.secret && (
            <button type="button" className="btn btn--sm" onClick={toggleReveal}>
              {reveal ? "Hide Token" : "Show Token"}
            </button>
          )}
          <button type="button" className="btn btn--sm" aria-label={`Copy ${s.title} configuration`} onClick={() => void copy()}>
            Copy
          </button>
        </div>
      </div>
      <pre className="mcp-server-snippet__code" data-test-dynamic={s.secret ? "" : undefined}>
        {reveal ? text : s.text}
      </pre>
    </div>
  );
}

export function McpServerSettingsPage() {
  const [st, refresh] = useMcpState();
  const [log, refreshLog] = useLog();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [port, setPort] = useState("");

  const loadSnippets = useCallback(() => void call<Snippet[]>("snippets", false).then(setSnippets, () => undefined), []);
  useEffect(() => {
    if (st) {
      setPort(String(st.settings.port));
      loadSnippets();
    }
  }, [st?.running, st?.url, st?.settings.port, loadSnippets]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setMessage({ text: ok });
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
    refresh();
  };
  const copy = (text: string) => void act(() => call("copy", text), "Copied to the clipboard");

  if (!st) return <div className="empty">Loading…</div>;
  const s = st.settings;
  const status = st.starting ? "Starting…" : st.running ? `Running at ${st.url} · ${st.sessions} connected session${st.sessions === 1 ? "" : "s"}` : st.error ? `Could not start: ${st.error}` : "Off";
  const alwaysRows = Object.entries(s.always).flatMap(([client, tools]) => tools.map((tool) => ({ client, tool })));
  const setPolicy = (name: string, p: Policy) => void act(() => call<McpServerState>("setToolPolicy", name, p));

  return (
    <div className="page mcp-server-page">
      <p className="page__lead">
        Let AI agents such as Claude Code, Claude Desktop, Goose or Cursor use Glide's tools through the Model Context Protocol. The server listens only on this Mac (127.0.0.1) and needs a secret token. Read-only tools are on by default; tools that change
        anything are off until you turn them on, and Glide asks you before each call.
      </p>

      <Group title="Server" footer={<span className={st.error ? "mcp-server-error" : undefined}>{status}</span>}>
        <Row label="Enable MCP server" hint="Starts a local server for AI agents. Nothing listens until you turn this on.">
          <Toggle label="Enable MCP server" checked={s.enabled} onChange={(v) => void act(() => call("setEnabled", v))} />
        </Row>
        <Row label="Port" hint="Glide picks a free port if this one is taken; the glide-mcp bridge always finds the current one." htmlFor="mcp-server-port">
          <input
            id="mcp-server-port"
            className="input mcp-server-port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && void act(() => call("setSettings", { port: Number(port) }))}
            onBlur={() => Number(port) !== s.port && void act(() => call("setSettings", { port: Number(port) }))}
          />
        </Row>
        <Row label="Access token" hint={st.hasToken ? `Stored in ${st.dataDir}/token (only your user can read it).` : "Created when you enable the server."}>
          <button type="button" className="btn btn--sm" onClick={() => void act(() => call("regenerateToken"), "New token created. Reconnect your agents (HTTP configs need the new token).")}>
            Regenerate Token
          </button>
        </Row>
        <Row label="Confirmation timeout" hint="Requests you don't answer are denied." htmlFor="mcp-server-timeout">
          <select id="mcp-server-timeout" className="input" value={s.confirmTimeoutSec} onChange={(e) => void act(() => call("setSettings", { confirmTimeoutSec: Number(e.target.value) }))}>
            {[15, 30, 60, 120, 300].map((n) => (
              <option key={n} value={n}>
                {n < 60 ? `${n} seconds` : `${n / 60} minute${n === 60 ? "" : "s"}`}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      {message && <div className={`mcp-server-message ${message.error ? "mcp-server-message--error" : ""}`}>{message.text}</div>}

      <Group title="Connect an agent" footer="The stdio bridge reads the port and token from Glide's data folder, so these configs contain no secret.">
        {snippets.map((sn) => (
          <SnippetBlock key={sn.id} s={sn} onCopy={copy} />
        ))}
      </Group>

      <Group title="Tools" footer="Ask: Glide shows “Allow / Deny / Always” in the launcher before each call. Tools that change things can't be allowed without asking, except per agent with Always.">
        {st.tools.map((t) => (
          <Row
            key={t.name}
            label={
              <span>
                {t.title} <code className="mcp-server-name">{t.name}</code>{" "}
                <span className={`mcp-server-badge mcp-server-badge--${t.readOnly ? (t.sensitive ? "sensitive" : "read") : "write"}`}>{t.readOnly ? (t.sensitive ? "Clipboard" : "Read-only") : t.destructive ? "Changes things" : "Creates"}</span>
              </span>
            }
            hint={t.available ? t.description : `${t.description} (Not available: the ${t.requires} feature is missing.)`}
          >
            <select className="input" aria-label={`Permission for ${t.title}`} value={t.policy} disabled={!t.available} onChange={(e) => setPolicy(t.name, e.target.value as Policy)}>
              <option value="off">Off</option>
              <option value="ask">Ask</option>
              {t.readOnly && <option value="allow">Allow</option>}
            </select>
          </Row>
        ))}
        <Row label="Reset permissions" hint="Read-only tools on, everything else off.">
          <button type="button" className="btn btn--sm" onClick={() => void act(() => call("resetToolPolicies"), "Permissions reset")}>
            Reset
          </button>
        </Row>
      </Group>

      <Group title="Always allowed">
        {alwaysRows.length === 0 ? (
          <div className="mcp-server-none faint">No agent has an “Always” grant.</div>
        ) : (
          alwaysRows.map((r) => (
            <Row key={`${r.client}/${r.tool}`} label={r.client} hint={r.tool}>
              <button type="button" className="btn btn--sm" aria-label={`Revoke ${r.tool} for ${r.client}`} onClick={() => void act(() => call("revokeAlways", r.client, r.tool))}>
                Revoke
              </button>
            </Row>
          ))
        )}
      </Group>

      <Group title="Request log" footer="Arguments and results are never stored.">
        <div className="mcp-server-log" role="table" aria-label="MCP request log">
          {log.length === 0 && <div className="mcp-server-none faint">No requests yet.</div>}
          {log.slice(0, 100).map((e) => (
            <div key={e.id} className="mcp-server-log__row" role="row">
              <span className="faint mcp-server-log__time" role="cell" data-test-dynamic>
                {time(e.at)}
              </span>
              <span role="cell" className="mcp-server-log__client">
                {e.client}
              </span>
              <span role="cell" className="mcp-server-log__summary" title={e.error}>
                <code>{e.tool}</code> {e.summary}
              </span>
              <span role="cell" className={`mcp-server-log__outcome mcp-server-log__outcome--${e.outcome}`}>
                {OUTCOME[e.outcome]}
                {e.approval === "user" ? " · approved" : e.approval === "always" ? " · always" : ""}
              </span>
            </div>
          ))}
        </div>
        <Row label="Clear log" hint={`${log.length} entr${log.length === 1 ? "y" : "ies"}`}>
          <button type="button" className="btn btn--sm" onClick={() => void act(() => call("clearLog").then(refreshLog), "Log cleared")}>
            Clear
          </button>
        </Row>
      </Group>
    </div>
  );
}
