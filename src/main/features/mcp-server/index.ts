/**
 * Glide as an MCP server: external agents (Claude Code, Claude Desktop, Goose, Cursor…) call
 * Glide's tools over Streamable HTTP on 127.0.0.1 (bearer token) or through the glide-mcp stdio
 * bridge. Off by default; Settings → MCP Server turns it on, sets per-tool permissions and shows
 * the request log. State-changing calls wait for Allow / Deny / Always in the launcher.
 */
import path from "node:path";
import { app, clipboard, Notification } from "electron";
import type { ItemAction } from "@shared/ipc";
import type { FeatureContext, FeatureModule } from "../types";
import { defaultServerDir, loadOrCreateToken, readToken, regenerateToken, removeDiscovery, writeDiscovery } from "./auth";
import { createBackend } from "./backend";
import { createCallHandler, type CallHandler } from "./calls";
import { createConfirmations, type Decision, type PendingRequest } from "./confirm";
import { startHttpServer, type McpHttpServer } from "./http";
import { createSessionServer } from "./mcp";
import { cleanPatch, DEFAULT_SETTINGS, defaultPolicy, policyFor, type McpServerSettings, type ToolPolicy } from "./policy";
import { createRateLimiter } from "./ratelimit";
import { createRequestLog, type LogEntry, type RequestLog } from "./requestlog";
import { createResources, type Resources } from "./resources";
import { buildSnippets, type ShimCommand, type Snippet } from "./snippets";
import { MCP_TOOLS, type McpToolMeta } from "./tools";

const ID = "mcp-server";
const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

export interface McpToolRow extends McpToolMeta {
  policy: ToolPolicy;
  defaultPolicy: ToolPolicy;
  available: boolean;
}

export interface McpServerState {
  settings: McpServerSettings;
  running: boolean;
  starting: boolean;
  url: string | null;
  port: number | null;
  error: string | null;
  sessions: number;
  tools: McpToolRow[];
  pending: PendingRequest[];
  shim: ShimCommand;
  dataDir: string;
  hasToken: boolean;
}

let ctx: FeatureContext | undefined;
let server: McpHttpServer | null = null;
let starting: Promise<void> | null = null;
let lastError: string | null = null;
let featureIds: ReadonlySet<string> = new Set();
let handler: CallHandler | undefined;
let resources: Resources | undefined;
let requestLog: RequestLog | undefined;
const limiter = createRateLimiter();

const need = () => {
  if (!ctx) throw new Error("MCP server feature not started");
  return ctx;
};
const settings = (): McpServerSettings => {
  const s = need().settings(DEFAULT_SETTINGS);
  return { ...s, tools: { ...(s.tools ?? {}) }, always: { ...(s.always ?? {}) } };
};
const loadFeatures = async (): Promise<FeatureModule[]> => (await import("../registry")).FEATURES;

const confirmations = createConfirmations({
  timeoutMs: () => (ctx ? settings().confirmTimeoutSec * 1000 : 60_000),
  onChange: (list) => ctx?.emit("pending", list),
  onRequest(r) {
    const c = ctx;
    if (!c) return;
    c.log(`confirmation requested: ${r.client} → ${r.tool}`);
    c.openView({ id: `${ID}.confirm`, props: { requestId: r.id } });
    try {
      if (Notification.isSupported()) new Notification({ title: `MCP request from ${r.client}`, body: r.summary, silent: false }).show();
    } catch {
      // notifications are a courtesy
    }
  },
});

function shimCommand(): ShimCommand {
  const userData = app.getPath("userData");
  const extra = path.join(userData, "features", ID) === defaultServerDir({}) ? [] : ["--data-dir", userData];
  if (app.isPackaged) return { command: path.join(process.resourcesPath, "glide-mcp"), args: extra };
  return { command: "node", args: [path.join(app.getAppPath(), "dist", "mcp", "glide-mcp.cjs"), ...extra] };
}

function emitState(): void {
  ctx?.emit("state");
}

function toolRows(): McpToolRow[] {
  const s = settings();
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    readOnly: t.readOnly,
    destructive: t.destructive,
    sensitive: t.sensitive,
    requires: t.requires,
    policy: policyFor(t, s),
    defaultPolicy: defaultPolicy(t),
    available: !t.requires || featureIds.has(t.requires),
  }));
}

function state(): McpServerState {
  const c = need();
  return {
    settings: settings(),
    running: !!server,
    starting: !!starting,
    url: server?.url ?? null,
    port: server?.port ?? null,
    error: lastError,
    sessions: server?.sessions() ?? 0,
    tools: toolRows(),
    pending: confirmations.pending(),
    shim: shimCommand(),
    dataDir: c.dataDir(),
    hasToken: !!readToken(c.dataDir()),
  };
}

async function startServer(): Promise<void> {
  if (server || starting) return starting ?? undefined;
  const c = need();
  const run = async () => {
    try {
      const dir = c.dataDir();
      loadOrCreateToken(dir);
      const s = settings();
      server = await startHttpServer(s.port, {
        token: () => readToken(dir) ?? "",
        createServer: () => createSessionServer({ handler: handler!, resources: resources!, version: app.getVersion() }),
        onSessionsChanged: () => emitState(),
        log: (...a) => c.log(...a),
      });
      writeDiscovery(dir, { port: server.port, pid: process.pid, url: server.url, version: app.getVersion(), startedAt: Date.now() });
      lastError = null;
      c.log(`listening on ${server.url}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      c.log("could not start:", lastError);
    } finally {
      starting = null;
      emitState();
    }
  };
  starting = run();
  emitState();
  return starting;
}

async function stopServer(): Promise<void> {
  if (starting) await starting;
  confirmations.denyAll();
  const s = server;
  server = null;
  if (s) await s.close().catch(() => undefined);
  if (ctx) removeDiscovery(ctx.dataDir(), process.pid);
  emitState();
}

async function applySettings(patch: unknown): Promise<McpServerState> {
  const c = need();
  const before = settings();
  const clean = cleanPatch(patch, TOOL_NAMES);
  c.setSettings(clean);
  const after = settings();
  if (before.enabled && !after.enabled) await stopServer();
  else if (after.enabled && (!before.enabled || !server)) await startServer();
  else if (after.enabled && before.port !== after.port) {
    await stopServer();
    await startServer();
  }
  if (clean.tools || clean.always) server?.notifyListChanged();
  emitState();
  return state();
}

function grantAlways(client: string, tool: string): void {
  const s = settings();
  const list = new Set(s.always[client] ?? []);
  list.add(tool);
  need().setSettings({ always: { ...s.always, [client]: [...list] } });
  emitState();
}

export const feature: FeatureModule = {
  id: ID,
  start(c) {
    ctx = c;
    requestLog = createRequestLog({ file: path.join(c.dataDir(), "requests.json"), onChange: () => c.emit("log") });
    const backend = createBackend(c, loadFeatures, () => featureIds);
    handler = createCallHandler({ tools: MCP_TOOLS, settings, backend, confirm: confirmations, limiter, log: requestLog, grantAlways });
    resources = createResources(backend.resources, settings);
    void loadFeatures().then((f) => {
      featureIds = new Set(f.map((m) => m.id));
      if (settings().enabled) void startServer();
    });
  },
  async stop() {
    await stopServer();
  },
  items() {
    if (!ctx) return [];
    const base = { kind: "command" as const, kindLabel: "MCP", feature: ID, icon: { kind: "emoji" as const, value: "🔌" } };
    return [
      { ...base, id: `${ID}:settings`, title: "MCP Server Settings", subtitle: "Let AI agents use Glide's tools", keywords: ["mcp", "agent", "claude", "goose", "cursor", "server", "tools"], data: { action: "settings" } },
      { ...base, id: `${ID}:requests`, title: "MCP Requests", subtitle: "Pending requests from AI agents", keywords: ["mcp", "requests", "approve", "allow", "deny"], data: { action: "requests" } },
    ];
  },
  actions(item): ItemAction[] {
    return item.data?.action === "requests" ? [{ id: "requests", title: "Show MCP Requests", shortcut: "⏎" }] : [{ id: "settings", title: "Open MCP Server Settings", shortcut: "⏎" }];
  },
  async runAction(item, actionId) {
    const a = actionId === "default" ? item.item.data?.action : actionId;
    if (a === "requests") return { ok: true, view: { id: `${ID}.confirm`, props: {} } };
    need().openSettings(ID);
    return { ok: true, hide: true };
  },
  methods: {
    state: () => state(),
    setSettings: (patch) => applySettings(patch),
    setEnabled: (on) => applySettings({ enabled: on === true }),
    setToolPolicy: (name, policy) => (typeof name === "string" && TOOL_NAMES.has(name) ? applySettings({ tools: { ...settings().tools, [name]: policy } }) : state()),
    resetToolPolicies: () => applySettings({ tools: {} }),
    revokeAlways: (client, tool) => {
      const s = settings();
      const always = { ...s.always };
      if (typeof client === "string") {
        if (typeof tool === "string") always[client] = (always[client] ?? []).filter((t) => t !== tool);
        else delete always[client];
      }
      return applySettings({ always });
    },
    pending: () => confirmations.pending(),
    /** Answer a pending confirmation ("allow" | "deny" | "always"). Also the e2e test hook. */
    respond: (id, decision) => typeof id === "string" && confirmations.respond(id, decision as Decision),
    log: (): LogEntry[] => requestLog?.list() ?? [],
    clearLog: () => {
      requestLog?.clear();
      return [];
    },
    regenerateToken: async () => {
      regenerateToken(need().dataDir());
      emitState();
      return state();
    },
    snippets: (reveal): Snippet[] => {
      const c = need();
      const token = reveal === true ? (readToken(c.dataDir()) ?? "") : "<token>";
      return buildSnippets({ shim: shimCommand(), url: server?.url ?? null, token });
    },
    /** Copy through Electron's clipboard (faked in headless mode). */
    copy: (text) => {
      if (typeof text !== "string") return false;
      clipboard.writeText(text);
      return true;
    },
  },
};
