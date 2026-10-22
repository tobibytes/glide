/**
 * MCP resources: glide://notes/<id> (when search_notes is allowed without asking) and
 * glide://clipboard/recent (only when clipboard_history_search is allowed without asking).
 */
import { gateFor, type McpServerSettings } from "./policy";
import { mcpToolByName } from "./tools";

export interface ResourceSource {
  notes(): Promise<Array<{ id: string; title: string; updatedAt?: number }>>;
  note(id: string): Promise<{ id: string; body: string } | null>;
  clipboardRecent(limit: number): Promise<Array<{ type: string; title: string; preview: string; copiedAt: number }>>;
}

export const NOTE_PREFIX = "glide://notes/";
export const CLIPBOARD_URI = "glide://clipboard/recent";

export function createResources(src: ResourceSource, settings: () => McpServerSettings) {
  const allowed = (tool: string, client: string) => {
    const t = mcpToolByName(tool);
    return !!t && gateFor(t, settings(), client).kind === "run";
  };
  return {
    async list(client: string) {
      const out: Array<{ uri: string; name: string; title?: string; mimeType: string; description?: string }> = [];
      if (allowed("search_notes", client))
        for (const n of (await src.notes().catch(() => [])).slice(0, 100)) out.push({ uri: `${NOTE_PREFIX}${encodeURIComponent(n.id)}`, name: n.title || n.id, title: n.title || "Untitled note", mimeType: "text/markdown" });
      if (allowed("clipboard_history_search", client)) out.push({ uri: CLIPBOARD_URI, name: "clipboard-recent", title: "Recent clipboard history", mimeType: "application/json", description: "The 20 most recent Glide clipboard history entries (text previews)" });
      return out;
    },
    templates(client: string) {
      return allowed("search_notes", client) ? [{ uriTemplate: `${NOTE_PREFIX}{id}`, name: "note", title: "Glide note", mimeType: "text/markdown", description: "A Glide floating note by id (ids from search_notes)" }] : [];
    },
    async read(uri: string, client: string): Promise<{ uri: string; mimeType: string; text: string }> {
      if (uri.startsWith(NOTE_PREFIX)) {
        if (!allowed("search_notes", client)) throw new Error("Reading notes is turned off in Glide Settings → MCP Server (search_notes).");
        const id = decodeURIComponent(uri.slice(NOTE_PREFIX.length));
        const n = await src.note(id);
        if (!n) throw new Error(`No note with id ${id}`);
        return { uri, mimeType: "text/markdown", text: n.body };
      }
      if (uri === CLIPBOARD_URI) {
        if (!allowed("clipboard_history_search", client)) throw new Error("Clipboard history is turned off in Glide Settings → MCP Server (clipboard_history_search).");
        return { uri, mimeType: "application/json", text: JSON.stringify(await src.clipboardRecent(20)) };
      }
      throw new Error(`Unknown resource ${uri}`);
    },
  };
}

export type Resources = ReturnType<typeof createResources>;
