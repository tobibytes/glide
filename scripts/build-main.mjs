// Bundles the Electron main process and preload script with esbuild.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  alias: { "@shared": path.join(root, "src/shared"), "@engine": path.join(root, "src/engine") },
  logLevel: "info",
};
const targets = [
  { entryPoints: [path.join(root, "src/main/index.ts")], outfile: path.join(root, "dist/main/index.cjs") },
  { entryPoints: [path.join(root, "src/preload/index.ts")], outfile: path.join(root, "dist/preload/index.cjs") },
];
if (watch) {
  const { context } = await import("esbuild");
  for (const t of targets) (await context({ ...common, ...t })).watch();
  console.log("[build-main] watching…");
} else {
  for (const t of targets) await build({ ...common, ...t });
}
