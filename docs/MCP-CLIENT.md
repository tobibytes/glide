# Glide Agent as an MCP client

Glide Agent can use the tools of any [Model Context Protocol](https://modelcontextprotocol.io) server.
(Glide can also *be* an MCP server; that is the separate `mcp-server` feature.)

## Setting it up

**Settings → Agent → MCP Servers**

- **Add Server…**: pick a transport.
  - **stdio**: a command, its arguments (one per line), environment (`KEY=value` per line) and an optional working directory.
  - **Streamable HTTP** (or legacy **SSE**): a URL, an optional bearer token and other headers (`Key: value` per line).
- **Test Connection** connects and lists the server's tools, with their read-only and "may change data" hints.
- **Enable toggle**: a disabled server is disconnected right away, and its stdio process is stopped.
- **Import…**: paste a Claude Desktop `claude_desktop_config.json` or a project `.mcp.json`, or use **Choose File…**.
  Glide only parses what you give it. It never reads those files by itself. Imported servers start **off**, so you can
  check each command before Glide runs it. A server whose name already exists is skipped.
- **Per tool**: **Offer** controls whether Claude sees the tool. **Allow without asking** adds the tool to the same
  allow list that built-in tools use; the confirmation's "Run & don't ask again ⌘⏎" also adds to it.
- **Per server**: per-call timeout (default 30 s), maximum calls per minute (default 30; 0 means no limit), and
  **Run read-only tools without asking** (default off).

Header and env values are secrets. They are stored encrypted with `safeStorage` in
`<userData>/features/agent/mcp-servers.json` and are never sent to the renderer. The UI shows them as `saved`, and
leaving `saved` unchanged keeps the stored value. If encryption isn't available, Glide refuses to save secrets
rather than writing them as plain text.

## How tools reach Claude

- **Names**: each tool is offered as `mcp__<server>__<tool>`. Characters outside `[A-Za-z0-9_-]` become `_`. Names
  are capped at 64 characters; a long name is shortened and gets a short hash so it stays unique. Duplicate names
  get a numeric suffix.
- **Schemas**: the server's JSON Schema is passed through. Glide removes `$schema`/`$id` and forces the top level to
  `type: "object"`. A top-level `anyOf`/`oneOf`/`allOf` is not allowed by the Messages API, so the object properties
  from its branches are merged in as optional (`allOf` keeps its required keys). Schemas over 32 KB fall back to a
  free-form object.
- **Descriptions** start with `[MCP server “name”; read-only | may change or delete data | …]`.
- **Results**: text content is sent as it is. Images and audio are noted but not sent, e.g.
  `[image image/png, ~3 KB — returned by the tool but not shown to the model]`. Resource links and embedded text
  resources are included, and binary resources are noted. If there is no content, `structuredContent` is sent as JSON.
  Output over 5,000 characters is cut off with a note. `isError` results, protocol errors, timeouts and disconnects
  all become tool errors (`is_error: true`) and never crash the run.

## Safety policy (annotations)

| Tool | In Read-only mode | Confirmation |
| --- | --- | --- |
| `readOnlyHint: true`, server set to run read-only tools without asking | offered | runs directly |
| `readOnlyHint: true`, server not trusted (default) | offered | asks, unless the tool is allow-listed |
| anything else | **not offered** | asks, unless the tool is allow-listed |

The confirmation reads "Run `<tool>` on `<server>` with `{args}`". If the tool may change or delete data (by MCP's
default, any tool that isn't read-only, unless it sets `destructiveHint: false`), the confirmation adds
"— the server says this may change or delete data". Each server's rate limit uses a sliding one-minute window.
MCP steps appear in the transcript as `server › Tool`.

## Lifecycle

- **Lazy**: nothing starts until an agent request needs tools, or until you press Test Connection. The connection
  then stays open while Glide runs. When the server reports that its tool list changed, Glide reads the list again.
- **Reconnect**: after a connection drops unexpectedly, Glide retries with exponential backoff (1 s, 2 s, 4 s…, up to
  30 s, at most 5 tries). The next request tries again after that. During a backoff wait, a request skips that
  server and says so in a transcript notice.
- **No orphans**: every stdio server runs under a small `/bin/sh` watchdog
  (`mcp-transport.ts` → `WATCHDOG_SCRIPT`). The watchdog stops the server if Glide's process disappears, for example
  after a crash or a force quit. On quit (`will-quit` → agent `stop()` → `killAll()`) and on disable, edit or remove,
  Glide closes stdin and signals the watchdog, which forwards the signal to the server.
- **PATH**: apps launched from the Dock get a minimal PATH, so Glide adds `/opt/homebrew/bin`, `/usr/local/bin`,
  `~/.local/bin`, `~/.bun/bin` and `~/.cargo/bin`.

## Code

| File | What it does |
| --- | --- |
| `src/main/features/agent/mcp-types.ts` | Types shared with the renderer, and `SECRET_KEEP` |
| `mcp-config.ts` | Validation, Claude Desktop / `.mcp.json` import, encrypted store, secret masking |
| `mcp-schema.ts` | Tool names, schema trimming, result mapping and truncation |
| `mcp-transport.ts` | SDK transports (stdio under the watchdog, Streamable HTTP, SSE) |
| `mcp-connection.ts` | One connection: lazy connect, tool list, timeouts, backoff reconnect, close and kill |
| `mcp-tools.ts` | MCP tools → agent tools (policy, summaries, rate limit) |
| `mcp-manager.ts` | All servers: `agentTools()`, `test`, `save`, `import`, `killAll` |
| `src/renderer/features/agent/McpServers.tsx` | The settings section |

Changes to existing agent files (all additions):

- `tooling.ts`: `ToolMeta.askFirst`.
- `loop.ts`: tools with `askFirst` go through the confirmation step; new `LoopOptions.notices`.
- `index.ts`: the MCP manager, MCP tools added to each run, `mcp*` methods, MCP names accepted in `allow`, and
  `killAll` on stop.
- `SettingsPage.tsx`: renders the new section.

Renderer methods (`window.glide.feature("agent", …)`): `mcpList`, `mcpSave(config)`, `mcpSetEnabled(id, on)`,
`mcpRemove(id)`, `mcpTest(id | draft)`, `mcpReconnect(id)`, `mcpImport(text, apply)`. When anything changes, the
`mcp` event pushes the server list.

## Tests

- `pnpm vitest run src/main/features/agent/mcp.test.ts` uses fixture servers written for these tests:
  - in-process (SDK `Server` + `InMemoryTransport`);
  - a real stdio child under the watchdog;
  - Streamable HTTP on 127.0.0.1 with a bearer token.

  It covers naming, schema mapping, result mapping, import, encryption, lazy connect, listing and calling,
  annotations → confirmation, allow lists, Read-only mode, disabled tools, timeouts, rate limits, error results,
  reconnect, unreachable servers, close on disable, quit cleanup and the watchdog.
- Headless end-to-end: `pnpm build:main && pnpm build:renderer`, then
  `GLIDE_TEST_PORT_BASE=9497 GLIDE_TEST_PORT_COUNT=2 node src/main/features/agent/e2e/mcp-cdp.mjs`. It uses
  `GLIDE_AGENT_MOCK=e2e/mcp-mock.json` and the stdio fixture `e2e/mcp-fixture-server.mjs`, and checks:
  - Test Connection in Settings;
  - a turn where `echo` (read-only) runs without asking and `add_note` waits for ⏎;
  - the transcript;
  - that the server process is gone after `app.quit()`;
  - that the server is gone after Glide is SIGKILLed (the watchdog).

## Known gaps

- No OAuth for remote servers: use a bearer token or headers. The SDK's `authProvider` could be wired in later.
- Only tools are supported: no MCP resources, prompts, sampling or elicitation.
- Tool calls aren't cancelled when you press esc. The call runs until it finishes or reaches its timeout, and its
  result is then discarded.
