// Bundles the file-index worker thread (src/main/features/fileindex/worker.ts)
// next to the main bundle as dist/main/fileindex-worker.cjs. The fileindex
// feature falls back to crawling inline in main when this file is missing.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {
  entryPoints: [path.join(root, "src/main/features/fileindex/worker.ts")],
  outfile: path.join(root, "dist/main/fileindex-worker.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  alias: { "@shared": path.join(root, "src/shared"), "@engine": path.join(root, "src/engine") },
  logLevel: "info",
};
if (process.argv.includes("--watch")) {
  const { context } = await import("esbuild");
  await (await context(options)).watch();
  console.log("[build-fileindex-worker] watching…");
} else {
  await build(options);
}
