/** Test helpers: a fake backend and an in-process MCP server (no Electron). */
import { createCallHandler } from "./calls";
import type { McpBackend, PreparedCall } from "./calls";
import { createConfirmations, type PendingRequest } from "./confirm";
import { startHttpServer } from "./http";
import { createSessionServer } from "./mcp";
import { DEFAULT_SETTINGS, type McpServerSettings } from "./policy";
import { createRateLimiter } from "./ratelimit";
import { createRequestLog } from "./requestlog";
import { createResources, type ResourceSource } from "./resources";
import { MCP_TOOLS } from "./tools";

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

export function fakeBackend(): McpBackend & { calls: FakeCall[]; resources: ResourceSource } {
  const calls: FakeCall[] = [];
  return {
    calls,
    available: () => true,
    prepare(t, args): PreparedCall | { error: string } {
      if (t.name === "search_glide" && typeof args.query !== "string") return { error: '"query" is required' };
      return {
        describe: async () => `${t.title} ${JSON.stringify(args)}`,
        async run() {
          calls.push({ tool: t.name, args });
          if (args.fail) throw new Error("boom");
          return `ran ${t.name}`;
        },
      };
    },
    resources: {
      notes: async () => [{ id: "n1", title: "Groceries" }],
      note: async (id) => (id === "n1" ? { id, body: "# Groceries\nmilk" } : null),
      clipboardRecent: async () => [{ type: "text", title: "secret", preview: "secret", copiedAt: 1 }],
    },
  };
}

export function harness(overrides: Partial<McpServerSettings> = {}, opts: { timeoutMs?: number } = {}) {
  let settings: McpServerSettings = { ...DEFAULT_SETTINGS, enabled: true, ...overrides };
  const backend = fakeBackend();
  const requests: PendingRequest[] = [];
  const confirm = createConfirmations({ timeoutMs: () => opts.timeoutMs ?? 2000, onChange: () => undefined, onRequest: (r) => requests.push(r) });
  const log = createRequestLog();
  const handler = createCallHandler({
    tools: MCP_TOOLS,
    settings: () => settings,
    backend,
    confirm,
    limiter: createRateLimiter(),
    log,
    grantAlways: (client, tool) => {
      settings = { ...settings, always: { ...settings.always, [client]: [...(settings.always[client] ?? []), tool] } };
    },
  });
  const resources = createResources(backend.resources, () => settings);
  return {
    backend,
    confirm,
    requests,
    log,
    handler,
    resources,
    settings: () => settings,
    set(patch: Partial<McpServerSettings>) {
      settings = { ...settings, ...patch };
    },
    /** Start a real loopback HTTP server around the handler. */
    async serve(token: string) {
      return startHttpServer(0, { token: () => token, createServer: () => createSessionServer({ handler, resources, version: "test" }) });
    },
  };
}

/** Wait until `fn` returns a truthy value. */
export async function until<T>(fn: () => T | undefined | null | false, timeout = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
