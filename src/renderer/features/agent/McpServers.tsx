/**
 * Settings → Agent → MCP Servers: add/edit/remove stdio or Streamable HTTP servers, test the
 * connection (lists tools), per-tool "offer" and "allow without asking", and import from a Claude
 * Desktop config or a `.mcp.json` file (pasted, or picked with the file chooser — Glide never reads
 * those files on its own). Saved header/env values are never sent here; they show as "saved".
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Group, Row, Toggle } from "../../components/form";
import { Kbd } from "../../components/Kbd";
import { SECRET_KEEP, type McpImportPreview, type McpSaveResult, type McpServerConfig, type McpServerView, type McpTestResult, type McpToolView, type McpTransportKind } from "../../../main/features/agent/mcp-types";
import type { AgentSettings } from "./api";
import "./mcp.css";

const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.glide.feature<T>("agent", method, ...args);
export const mcpApi = {
  list: () => call<McpServerView[]>("mcpList"),
  save: (s: Partial<McpServerConfig>) => call<McpSaveResult>("mcpSave", s),
  setEnabled: (id: string, on: boolean) => call<McpSaveResult>("mcpSetEnabled", id, on),
  remove: (id: string) => call<boolean>("mcpRemove", id),
  test: (s: string | Partial<McpServerConfig>) => call<McpTestResult>("mcpTest", s),
  importConfig: (text: string, apply: boolean) => call<McpImportPreview>("mcpImport", text, apply),
};

interface Draft {
  id?: string;
  name: string;
  transport: McpTransportKind;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  bearer: string;
  autoRunReadOnly: boolean;
  timeoutSec: number;
  rateLimitPerMinute: number;
  disabledTools: string[];
  enabled: boolean;
}

const EMPTY: Draft = { name: "", transport: "stdio", command: "", args: "", env: "", cwd: "", url: "", headers: "", bearer: "", autoRunReadOnly: false, timeoutSec: 30, rateLimitPerMinute: 30, disabledTools: [], enabled: true };
const SAVED = "saved";

/** KEY=value lines (env) / Key: value lines (headers); saved secrets show as "KEY=saved". */
const toLines = (r: Record<string, string> | undefined, sep: string, skip?: string) =>
  Object.entries(r ?? {})
    .filter(([k]) => k !== skip)
    .map(([k, v]) => `${k}${sep}${v === SECRET_KEEP ? SAVED : v}`)
    .join("\n");
function fromLines(text: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = sep.exec(line);
    if (!m || m.index === 0) continue;
    const k = line.slice(0, m.index).trim();
    const v = line.slice(m.index + m[0].length).trim();
    if (k) out[k] = v === SAVED ? SECRET_KEEP : v;
  }
  return out;
}

function toDraft(s: McpServerView): Draft {
  const auth = s.headers?.Authorization;
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    command: s.command ?? "",
    args: (s.args ?? []).join("\n"),
    env: toLines(s.env, "="),
    cwd: s.cwd ?? "",
    url: s.url ?? "",
    headers: toLines(s.headers, ": ", auth !== undefined ? "Authorization" : undefined),
    bearer: auth === undefined ? "" : auth === SECRET_KEEP ? SECRET_KEEP : auth.replace(/^Bearer\s+/i, ""),
    autoRunReadOnly: s.autoRunReadOnly,
    timeoutSec: Math.round(s.timeoutMs / 1000),
    rateLimitPerMinute: s.rateLimitPerMinute,
    disabledTools: s.disabledTools,
    enabled: s.enabled,
  };
}

function fromDraft(d: Draft): Partial<McpServerConfig> {
  const base = { ...(d.id ? { id: d.id } : {}), name: d.name.trim(), transport: d.transport, enabled: d.enabled, autoRunReadOnly: d.autoRunReadOnly, timeoutMs: Math.max(1, d.timeoutSec) * 1000, rateLimitPerMinute: d.rateLimitPerMinute, disabledTools: d.disabledTools };
  if (d.transport === "stdio") {
    const env = fromLines(d.env, /=/);
    return { ...base, command: d.command.trim(), args: d.args.split("\n").map((a) => a.trim()).filter(Boolean), ...(Object.keys(env).length ? { env } : {}), ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}) };
  }
  const headers = fromLines(d.headers, /:\s?/);
  if (d.bearer.trim()) headers.Authorization = d.bearer === SECRET_KEEP ? SECRET_KEEP : `Bearer ${d.bearer.trim()}`;
  return { ...base, url: d.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
}

const STATE_LABEL: Record<McpServerView["state"], string> = { idle: "Not connected", connecting: "Connecting…", ready: "Connected", error: "Error", closed: "Disconnected" };

export function McpServersSection({ settings, onAllow }: { settings: AgentSettings; onAllow(name: string, on: boolean): void }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [tests, setTests] = useState<Record<string, McpTestResult | "running">>({});
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => setServers(await mcpApi.list()), []);
  useEffect(() => {
    void refresh();
    return window.glide.onFeatureEvent((e) => {
      if (e.feature === "agent" && e.event === "mcp" && Array.isArray(e.payload)) setServers(e.payload as McpServerView[]);
    });
  }, [refresh]);

  const runTest = async (key: string, target: string | Partial<McpServerConfig>) => {
    setTests((t) => ({ ...t, [key]: "running" }));
    const r = await mcpApi.test(target);
    setTests((t) => ({ ...t, [key]: r }));
    void refresh();
  };

  const toggleTool = async (s: McpServerView, tool: string, offer: boolean) => {
    const disabledTools = offer ? s.disabledTools.filter((t) => t !== tool) : [...new Set([...s.disabledTools, tool])];
    const r = await mcpApi.save({ ...s, disabledTools });
    if (!r.ok) setMessage(r.error ?? "Couldn't save");
    void refresh();
  };

  return (
    <div className="agent-mcp" data-testid="agent-mcp">
      <Group
        title="MCP Servers"
        footer="Glide Agent can use the tools of any Model Context Protocol server. Servers start the first time the agent needs them and stay connected while Glide runs. Tools the server marks read-only can run without asking if you allow it per server; every other tool asks first — unless you turn on “Allow without asking” for it. Headers and environment values are stored encrypted."
      >
        {servers.length === 0 && (
          <Row label="No servers yet" hint="Add one, or import your Claude Desktop / .mcp.json config">
            <span className="agent-settings__value">—</span>
          </Row>
        )}
        {servers.map((s) => {
          const test = tests[s.id];
          const tools: McpToolView[] = test && test !== "running" && test.ok ? test.tools : s.tools;
          return (
            <div key={s.id} className="agent-mcp__server" data-testid="agent-mcp-server" data-name={s.name} data-state={s.state}>
              <Row
                label={
                  <>
                    {s.name} <span className={`agent-badge agent-mcp__state agent-mcp__state--${s.state}`}>{STATE_LABEL[s.state]}</span>
                  </>
                }
                hint={s.transport === "stdio" ? `${s.command} ${(s.args ?? []).join(" ")}` : `${s.transport === "sse" ? "SSE" : "HTTP"} · ${s.url}`}
              >
                <button type="button" className="btn btn--sm" onClick={() => void runTest(s.id, s.id)} disabled={test === "running"} data-testid="agent-mcp-test">
                  {test === "running" ? "Testing…" : "Test Connection"}
                </button>
                <button type="button" className="btn btn--sm" onClick={() => setEditing(toDraft(s))}>
                  Edit…
                </button>
                {removing === s.id ? (
                  <button type="button" className="btn btn--sm btn--danger" autoFocus onBlur={() => setRemoving(null)} onClick={() => void mcpApi.remove(s.id).then(() => (setRemoving(null), refresh()))}>
                    Confirm Remove
                  </button>
                ) : (
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => setRemoving(s.id)}>
                    Remove…
                  </button>
                )}
                <Toggle checked={s.enabled} onChange={(v) => void mcpApi.setEnabled(s.id, v).then(refresh)} label={`Enable ${s.name}`} />
              </Row>
              {s.error && <div className="agent-mcp__error" role="status">{s.error}</div>}
              {test && test !== "running" && (
                <div className={test.ok ? "agent-mcp__test agent-mcp__test--ok" : "agent-mcp__test agent-mcp__error"} role="status" data-testid="agent-mcp-test-result">
                  {test.ok ? `Connected to ${test.serverInfo?.name ?? s.name}${test.serverInfo?.version ? ` ${test.serverInfo.version}` : ""} in ${test.ms} ms — ${test.tools.length} tool${test.tools.length === 1 ? "" : "s"}` : test.error}
                </div>
              )}
              {tools.length > 0 && (
                <ul className="agent-mcp__tools" aria-label={`${s.name} tools`}>
                  {tools.map((t) => {
                    const auto = t.readOnly && s.autoRunReadOnly;
                    return (
                      <li key={t.name} className="agent-mcp__tool" data-testid="agent-mcp-tool" data-tool={t.agentName}>
                        <div className="agent-mcp__tool-main">
                          <span className="agent-mcp__tool-name">{t.title}</span>
                          {t.readOnly && <span className="tag">read-only</span>}
                          {t.destructive && <span className="tag">may change data</span>}
                          <div className="row__hint">
                            <code>{t.agentName}</code> {t.description}
                          </div>
                        </div>
                        <label className="agent-mcp__check">
                          <input type="checkbox" checked={t.enabled} onChange={(e) => void toggleTool(s, t.name, e.target.checked)} /> Offer
                        </label>
                        {auto ? (
                          <span className="agent-settings__value">Runs directly</span>
                        ) : (
                          <label className="agent-mcp__check">
                            <input type="checkbox" checked={settings.allow[t.agentName] === true} onChange={(e) => onAllow(t.agentName, e.target.checked)} /> Allow without asking
                          </label>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
        <Row label="">
          <button type="button" className="btn" onClick={() => (setImporting(false), setEditing({ ...EMPTY }))} data-testid="agent-mcp-add">
            Add Server…
          </button>
          <button type="button" className="btn" onClick={() => (setEditing(null), setImporting(true))}>
            Import…
          </button>
        </Row>
      </Group>
      {message && <div className="agent-mcp__error" role="status">{message}</div>}
      {editing && (
        <McpEditor
          draft={editing}
          onCancel={() => setEditing(null)}
          onTest={(d) => runTest("draft", fromDraft(d))}
          test={tests.draft}
          onSave={async (d) => {
            const r = await mcpApi.save(fromDraft(d));
            if (!r.ok) return r.error ?? "Couldn't save";
            setEditing(null);
            setTests(({ draft: _d, ...rest }) => rest);
            void refresh();
            return null;
          }}
        />
      )}
      {importing && (
        <McpImport
          onDone={(n) => {
            setImporting(false);
            setMessage(n ? `Imported ${n} server${n === 1 ? "" : "s"} — review each one and turn it on.` : null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function McpEditor({ draft, onCancel, onSave, onTest, test }: { draft: Draft; onCancel(): void; onSave(d: Draft): Promise<string | null>; onTest(d: Draft): void; test?: McpTestResult | "running" }) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const save = async () => setError(await onSave(d));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  const id = (k: string) => `agent-mcp-${k}`;
  return (
    <section className="group agent-mcp__editor" aria-label={d.id ? `Edit ${d.name}` : "Add MCP server"} onKeyDown={onKey} data-testid="agent-mcp-editor">
      <h3 className="group__title">{d.id ? `Edit “${draft.name}”` : "Add MCP Server"}</h3>
      <div className="group__box agent-mcp__form">
        <label htmlFor={id("name")}>Name</label>
        <input id={id("name")} ref={first} className="input" value={d.name} placeholder="github" onChange={(e) => set({ name: e.target.value })} />
        <label htmlFor={id("transport")}>Transport</label>
        <select id={id("transport")} className="input" value={d.transport} onChange={(e) => set({ transport: e.target.value as McpTransportKind })}>
          <option value="stdio">stdio — run a command</option>
          <option value="http">Streamable HTTP — URL</option>
          <option value="sse">SSE (legacy) — URL</option>
        </select>
        {d.transport === "stdio" ? (
          <>
            <label htmlFor={id("command")}>Command</label>
            <input id={id("command")} className="input" value={d.command} placeholder="/opt/homebrew/bin/npx" onChange={(e) => set({ command: e.target.value })} />
            <label htmlFor={id("args")}>Arguments (one per line)</label>
            <textarea id={id("args")} className="input" rows={3} value={d.args} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/Users/me/Documents"} onChange={(e) => set({ args: e.target.value })} />
            <label htmlFor={id("env")}>Environment (KEY=value per line, stored encrypted)</label>
            <textarea id={id("env")} className="input" rows={2} value={d.env} placeholder="GITHUB_TOKEN=…" onChange={(e) => set({ env: e.target.value })} />
            <label htmlFor={id("cwd")}>Working directory</label>
            <input id={id("cwd")} className="input" value={d.cwd} placeholder="(optional)" onChange={(e) => set({ cwd: e.target.value })} />
          </>
        ) : (
          <>
            <label htmlFor={id("url")}>URL</label>
            <input id={id("url")} className="input" value={d.url} placeholder="https://example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
            <label htmlFor={id("bearer")}>Bearer token (stored encrypted)</label>
            <input
              id={id("bearer")}
              className="input"
              type="password"
              value={d.bearer === SECRET_KEEP ? "" : d.bearer}
              placeholder={d.bearer === SECRET_KEEP ? "saved — type to replace" : "(optional)"}
              onChange={(e) => set({ bearer: e.target.value })}
            />
            <label htmlFor={id("headers")}>Other headers (Key: value per line, stored encrypted)</label>
            <textarea id={id("headers")} className="input" rows={2} value={d.headers} placeholder="X-Api-Key: …" onChange={(e) => set({ headers: e.target.value })} />
          </>
        )}
        <label htmlFor={id("timeout")}>Timeout per call (seconds)</label>
        <input id={id("timeout")} className="input" type="number" min={1} max={600} value={d.timeoutSec} onChange={(e) => set({ timeoutSec: Number(e.target.value) || 30 })} />
        <label htmlFor={id("rate")}>Max calls per minute (0 = no limit)</label>
        <input id={id("rate")} className="input" type="number" min={0} max={1000} value={d.rateLimitPerMinute} onChange={(e) => set({ rateLimitPerMinute: Math.max(0, Number(e.target.value) || 0) })} />
        <span>Run read-only tools without asking</span>
        <Toggle checked={d.autoRunReadOnly} onChange={(v) => set({ autoRunReadOnly: v })} label="Run this server's read-only tools without asking" />
      </div>
      {error && <div className="agent-mcp__error" role="alert">{error}</div>}
      {test && (
        <div className={test !== "running" && test.ok ? "agent-mcp__test agent-mcp__test--ok" : "agent-mcp__test"} role="status">
          {test === "running" ? "Testing…" : test.ok ? `Connected — ${test.tools.length} tools: ${test.tools.map((t) => t.name).join(", ")}` : test.error}
        </div>
      )}
      <div className="agent-mcp__actions">
        <button type="button" className="btn" onClick={() => onTest(d)}>
          Test Connection
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel <Kbd keys="esc" />
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void save()}>
          Save <Kbd keys="⌘⏎" />
        </button>
      </div>
    </section>
  );
}

function McpImport({ onDone }: { onDone(imported: number): void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<McpImportPreview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  const check = async (t: string) => setPreview(t.trim() ? await mcpApi.importConfig(t, false) : null);
  return (
    <section
      className="group agent-mcp__editor"
      aria-label="Import MCP servers"
      data-testid="agent-mcp-import"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDone(0);
        }
      }}
    >
      <h3 className="group__title">Import MCP Servers</h3>
      <p className="group__footer">Paste the contents of claude_desktop_config.json or a project's .mcp.json, or choose the file. Imported servers start turned off so you can check each command first.</p>
      <textarea
        ref={area}
        className="input agent-mcp__paste"
        rows={8}
        aria-label="Config JSON"
        value={text}
        placeholder={'{ "mcpServers": { "name": { "command": "npx", "args": [] } } }'}
        onChange={(e) => {
          setText(e.target.value);
          void check(e.target.value);
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          void f.text().then((t) => {
            setText(t);
            void check(t);
          });
        }}
      />
      {preview && (
        <div className="agent-mcp__test" role="status" data-testid="agent-mcp-import-preview">
          {preview.ok ? (
            <ul>
              {preview.servers.map((s) => (
                <li key={s.name}>
                  <b>{s.name}</b> — {s.transport === "stdio" ? `${s.command} ${(s.args ?? []).join(" ")}` : s.url}
                  {s.envKeys.length ? ` · env ${s.envKeys.join(", ")}` : ""}
                  {s.headerKeys.length ? ` · headers ${s.headerKeys.join(", ")}` : ""}
                  {s.exists ? " · already exists (skipped)" : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {preview.error && <div className="agent-mcp__error">{preview.error}</div>}
        </div>
      )}
      <div className="agent-mcp__actions">
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          Choose File…
        </button>
        <button type="button" className="btn" onClick={() => onDone(0)}>
          Cancel <Kbd keys="esc" />
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!preview?.ok || !preview.servers.some((s) => !s.exists)}
          onClick={() => void mcpApi.importConfig(text, true).then((r) => onDone(r.imported ?? 0))}
        >
          Import {preview?.ok ? preview.servers.filter((s) => !s.exists).length : ""}
        </button>
      </div>
    </section>
  );
}
