/**
 * Entry point of the glide-mcp command (bundled to dist/mcp/glide-mcp.cjs).
 *   glide-mcp [--data-dir <dir>] [--url <http://127.0.0.1:port/mcp>]
 * Env: GLIDE_MCP_DIR (server dir) or GLIDE_USER_DATA (Glide's userData).
 */
import { defaultServerDir } from "./auth";
import { runBridge } from "./bridge";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("glide-mcp: connects an MCP client over stdio to the MCP server built into Glide.\nUsage: glide-mcp [--data-dir DIR] [--url URL]\n");
  process.exit(0);
}

const dataDir = arg("--data-dir");
const dir = dataDir ? (dataDir.endsWith("mcp-server") ? dataDir : `${dataDir.replace(/\/$/, "")}/features/mcp-server`) : defaultServerDir();

void runBridge({ dir, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, url: arg("--url") }).then((code) => process.exit(code));
