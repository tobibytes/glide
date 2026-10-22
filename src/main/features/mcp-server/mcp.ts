/** One MCP protocol session (SDK low-level Server) wired to the call handler and resources. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallHandler } from "./calls";
import type { Resources } from "./resources";
import { toListEntry } from "./tools";

export const INSTRUCTIONS =
  "Glide is the user's macOS launcher. Use search_glide to find apps, commands, workflows and quicklinks, then run_command with an item id. " +
  "State-changing tools ask the user to confirm in Glide and may be turned off; a denied call is final, so do not retry it. Read-only tools answer immediately.";

export interface SessionDeps {
  handler: CallHandler;
  resources: Resources;
  version: string;
}

/** Client name as reported in initialize (used for confirmations, Always grants and the log). */
export function clientLabel(server: Server): string {
  const v = server.getClientVersion();
  const name = (v?.title || v?.name || "MCP client").replace(/[\u0000-\u001f]/g, "").slice(0, 80);
  return name || "MCP client";
}

export function createSessionServer(deps: SessionDeps): Server {
  const server = new Server(
    { name: "glide", title: "Glide", version: deps.version },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: deps.handler.visibleTools(clientLabel(server)).map(toListEntry) }));
  server.setRequestHandler(CallToolRequestSchema, (req) => deps.handler.call(clientLabel(server), req.params.name, req.params.arguments ?? {}));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await deps.resources.list(clientLabel(server)) }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: deps.resources.templates(clientLabel(server)) }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({ contents: [await deps.resources.read(req.params.uri, clientLabel(server))] }));
  return server;
}
