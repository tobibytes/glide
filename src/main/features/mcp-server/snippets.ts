/** Ready-to-paste client configurations shown in Settings → MCP Server (pure). */
export interface ShimCommand {
  command: string;
  args: string[];
}

export interface SnippetInput {
  shim: ShimCommand;
  /** Current HTTP endpoint (null while the server is off). */
  url: string | null;
  /** Shown only when the user reveals it. */
  token: string;
  name?: string;
}

export interface Snippet {
  id: string;
  title: string;
  hint: string;
  text: string;
  /** Contains the bearer token (the UI masks it until revealed). */
  secret?: boolean;
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function buildSnippets(i: SnippetInput): Snippet[] {
  const name = i.name ?? "glide";
  const stdioJson = { mcpServers: { [name]: { command: i.shim.command, args: i.shim.args } } };
  const out: Snippet[] = [
    {
      id: "claude-code",
      title: "Claude Code",
      hint: "Run in a terminal. Uses the stdio bridge, so it keeps working when Glide picks a new port.",
      text: `claude mcp add --scope user ${name} -- ${[i.shim.command, ...i.shim.args].map(shq).join(" ")}`,
    },
    {
      id: "claude-desktop",
      title: "Claude Desktop",
      hint: "Merge into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop.",
      text: JSON.stringify(stdioJson, null, 2),
    },
    {
      id: "goose",
      title: "Goose",
      hint: "Add to ~/.config/goose/config.yaml (or goose configure → Add Extension → Command-line Extension).",
      text: [
        "extensions:",
        `  ${name}:`,
        `    name: ${name}`,
        "    type: stdio",
        "    enabled: true",
        `    cmd: ${JSON.stringify(i.shim.command)}`,
        `    args: [${i.shim.args.map((a) => JSON.stringify(a)).join(", ")}]`,
        "    timeout: 300",
      ].join("\n"),
    },
    {
      id: "cursor",
      title: "Cursor",
      hint: "Merge into ~/.cursor/mcp.json.",
      text: JSON.stringify(stdioJson, null, 2),
    },
  ];
  if (i.url)
    out.push({
      id: "claude-code-http",
      title: "Claude Code (direct HTTP)",
      hint: "No bridge process, but contains the token and the current port; re-add it if the port changes.",
      text: `claude mcp add --scope user --transport http ${name} ${i.url} --header ${shq(`Authorization: Bearer ${i.token}`)}`,
      secret: true,
    });
  return out;
}
