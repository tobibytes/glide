// Builds the glide-mcp stdio bridge (src/main/features/mcp-server/cli.ts) into dist/mcp/:
//   dist/mcp/glide-mcp.cjs  self-contained bundle (MCP SDK included; runs on Node ≥ 18 or Electron as Node)
//   dist/mcp/glide-mcp      POSIX sh launcher: inside Glide.app it runs the bundle with Glide's own
//                           Electron binary (ELECTRON_RUN_AS_NODE=1), so no Node install is needed.
// Packaging: scripts/package.mjs should add both files to `extraResource` so they land in
// Glide.app/Contents/Resources/ (see docs/MCP.md).
import { build } from "esbuild";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "mcp");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/main/features/mcp-server/cli.ts")],
  outfile: path.join(outDir, "glide-mcp.cjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: true,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  external: ["electron"],
  logLevel: "info",
});
chmodSync(path.join(outDir, "glide-mcp.cjs"), 0o755);

const launcher = `#!/bin/sh
# glide-mcp: connects an MCP client (stdio) to the MCP server built into Glide.
# Inside Glide.app this runs the bundled bridge with Glide's Electron binary in Node mode.
SELF=$(readlink -f "$0" 2>/dev/null || echo "$0")
DIR=$(cd "$(dirname "$SELF")" && pwd)
APP_BIN="$DIR/../MacOS/Glide"
if [ -x "$APP_BIN" ]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$APP_BIN" "$DIR/glide-mcp.cjs" "$@"
fi
exec node "$DIR/glide-mcp.cjs" "$@"
`;
writeFileSync(path.join(outDir, "glide-mcp"), launcher, { mode: 0o755 });
chmodSync(path.join(outDir, "glide-mcp"), 0o755);
console.log(`[glide-mcp] wrote ${path.relative(root, outDir)}/glide-mcp{,.cjs}`);
