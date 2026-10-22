# Glide as an MCP server

Glide can expose its tools to external AI agents (Claude Code, Claude Desktop, Goose, Cursor…)
through the [Model Context Protocol](https://modelcontextprotocol.io). It is **off by default**:
turn it on in **Settings → MCP Server**.

## Transport

| | |
| --- | --- |
| Endpoint | Streamable HTTP at `http://127.0.0.1:<port>/mcp` (default port 47811; any free port if taken) |
| Auth | `Authorization: Bearer <token>`; the token is 256 random bits, created on first enable, stored in `<userData>/features/mcp-server/token` (0600). Settings → Regenerate Token replaces it. |
| Discovery | `<userData>/features/mcp-server/server.json` (0600): `{ port, pid, url, version, startedAt }` while the server runs |
| Hardening | Binds 127.0.0.1 only; Host must be `127.0.0.1:<port>`/`localhost:<port>` and a browser Origin must be the same loopback origin (DNS-rebinding guard); 4 MB body cap; ≤ 32 sessions, idle sessions dropped after 30 min |
| SDK | `@modelcontextprotocol/sdk` 1.32.1, low-level `Server` + `StreamableHTTPServerTransport`, one session (server + transport) per `initialize` |

### stdio bridge: `glide-mcp`

Most agents launch MCP servers as commands. `glide-mcp` is a tiny stdio ⇄ HTTP proxy
(`src/main/features/mcp-server/bridge.ts`): it reads `server.json` and `token`, then relays JSON-RPC
messages unchanged between stdin/stdout and the HTTP endpoint (SDK `StdioServerTransport` ⇄
`StreamableHTTPClientTransport`). Because it finds the port on every launch, configs that use it
contain no secret and survive port changes. If Glide or the server is off it prints a clear
message to stderr and exits 1.

Build: `node scripts/glide-mcp.mjs` writes

- `dist/mcp/glide-mcp.cjs`: the bridge bundled with esbuild (SDK included, no `node_modules` needed; Node ≥ 18)
- `dist/mcp/glide-mcp`: a POSIX `sh` launcher. Inside `Glide.app/Contents/Resources/` it runs the bundle
  with Glide's own Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1 Contents/MacOS/Glide glide-mcp.cjs`),
  so users need no Node install; elsewhere it falls back to `node`.

Options: `--data-dir <Glide userData or the mcp-server dir>`, `--url <endpoint>`; env `GLIDE_MCP_DIR`, `GLIDE_USER_DATA`.

### Packaging (to apply in the build scripts)

1. `package.json` → `"build:main": "node scripts/build-main.mjs && node scripts/build-fileindex-worker.mjs && node scripts/glide-mcp.mjs"`.
2. `scripts/package.mjs` → add both files to `extraResource` (Electron Packager copies them to `Contents/Resources/`):
   ```js
   const extraResource = [...stageHelper(), ...stageEsbuild(), path.join(root, "extensions-examples"), path.join(root, "store"),
     path.join(root, "dist/mcp/glide-mcp"), path.join(root, "dist/mcp/glide-mcp.cjs")];
   ```
   The app's `codesign --deep` seal then covers them (they are scripts, not Mach-O, so no separate signing).
   Electron's `RunAsNode` fuse must stay enabled (it is: package.mjs flips no fuses).

## Client configuration

Settings → MCP Server shows these with the real paths and a Copy button (packaged app shown):

**Claude Code**
```sh
claude mcp add --scope user glide -- /Applications/Glide.app/Contents/Resources/glide-mcp
# or direct HTTP (no bridge; contains the token and current port):
claude mcp add --scope user --transport http glide http://127.0.0.1:47811/mcp --header 'Authorization: Bearer <token>'
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`)
```json
{ "mcpServers": { "glide": { "command": "/Applications/Glide.app/Contents/Resources/glide-mcp", "args": [] } } }
```

**Goose** (`~/.config/goose/config.yaml`)
```yaml
extensions:
  glide:
    name: glide
    type: stdio
    enabled: true
    cmd: "/Applications/Glide.app/Contents/Resources/glide-mcp"
    args: []
    timeout: 300
```

In a dev checkout the command is `node <repo>/dist/mcp/glide-mcp.cjs` (plus `--data-dir` when `GLIDE_USER_DATA` is set).

## Tools

Agent-backed tools reuse the Glide Agent's validated implementations (`src/main/features/agent/tools*.ts`
over `capabilities.ts`, i.e. `ctx.search`, `ctx.executeItem`, other features' methods); the rest are in `backend.ts`.

| Tool | Default | Annotations | Backed by |
| --- | --- | --- | --- |
| search_glide | allow | read-only | agent `search_catalogue` (ctx.search) |
| list_workflows, list_layouts, list_automations | allow | read-only | agent tools |
| list_timers | allow | read-only | `timers.state` |
| search_notes, convert, transform_text, system_status, search_bookmarks | allow | read-only | agent tools |
| list_reminders | allow | read-only | `reminders.state` (needs Reminders access; feature-detected) |
| capture_text_from_image | allow | read-only | helper `ocr.recognize` on an image **file** (never the screen; never auto-copies) |
| clipboard_history_search | **off** | read-only, clipboard | agent tool |
| run_command | off | destructive | agent `execute_item` (ctx.executeItem) |
| run_workflow, run_automation, stop_timer | off | destructive | agent tools / `timers.stop` |
| window_action, restore_layout, save_layout, start_timer, create_note, create_reminder | off | state-changing | agent tools (`create_note` defaults to `open: false`) |

Tools whose feature isn't installed are hidden.

Resources: `glide://notes/{id}` (Markdown; listed when `search_notes` is allowed without asking) and
`glide://clipboard/recent` (JSON, only when `clipboard_history_search` is set to Allow).

## Safety

- **Per-tool policy** (Settings → MCP Server → Tools): Off (hidden and refused), Ask, Allow. Read-only tools
  default to Allow; state-changing and clipboard tools default to Off. A state-changing tool can never be
  set to Allow; it always asks unless the user picks **Always** for that client in the prompt (revocable
  under “Always allowed”).
- **Confirmation**: an Ask call opens the launcher view `mcp-server.confirm` (“MCP request: *client* wants
  to … ” with the exact action) plus a notification. ⏎ Allow Once, ⌘⏎ Always, ⌘⌫ Deny. No answer within
  the timeout (default 60 s) → denied. At most 5 requests wait at once; stopping the server denies them all.
- **Rate limits** per client: 120 calls/min, 20 state-changing calls/min.
- **Request log** (Settings): time, client, tool, the action's summary and outcome. Arguments and results
  are never stored; clipboard/text tools log only their title.
- API keys are never reachable: no tool reads settings or key stores, and the agent's own items
  (`agent:`) and the server's (`mcp-server:`) can't be run through `run_command`.

## Code map

`src/main/features/mcp-server/`: `index.ts` (feature, lifecycle, renderer methods), `tools.ts` (catalogue),
`policy.ts`, `calls.ts` (policy → rate limit → validation → confirmation → run → log), `confirm.ts`,
`ratelimit.ts`, `requestlog.ts`, `resources.ts`, `mcp.ts` (SDK Server per session), `http.ts`, `auth.ts`,
`backend.ts`, `bridge.ts` + `cli.ts` (glide-mcp), `snippets.ts`. Renderer: `src/renderer/features/mcp-server/`.

## Tests

```sh
pnpm vitest run src/main/features/mcp-server        # schemas, policy, pipeline, auth, HTTP + SDK client, shim
pnpm build:main && pnpm build:renderer && node scripts/glide-mcp.mjs
GLIDE_TEST_TMP=<dir> node src/main/features/mcp-server/e2e/mcp-e2e.mjs [--shots=<dir>]   # headless, CDP 9495, MCP 9496
```
