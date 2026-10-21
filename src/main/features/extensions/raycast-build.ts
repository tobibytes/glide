/**
 * Building an imported Raycast extension: each command's src/<name>.tsx is bundled with esbuild
 * into <out>/<name>.cjs. `react`, `@raycast/api` and `@raycast/utils` stay external — the extension
 * process maps them to Glide's shims. Other imports resolve from the extension's own node_modules.
 * Glide never downloads packages: a missing dependency is reported, not installed.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ExtensionManifest } from "./manifest";
import { raycastSourceCandidates } from "./raycast-manifest";

export interface EsbuildMessage {
  text: string;
  location?: { file?: string; line?: number; column?: number } | null;
}

/** The subset of esbuild's API used here (so tests can inject it and main can load it lazily). */
export interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ errors: EsbuildMessage[]; warnings: EsbuildMessage[] }>;
}

export const RAYCAST_EXTERNALS = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "@raycast/api", "@raycast/utils", "electron"];

/**
 * Load esbuild without bundling it into main: a runtime require from the app folder (dev) or from
 * Resources/esbuild (a packaged app that ships it). Returns null when it is not available.
 */
export function loadEsbuild(searchDirs: string[]): EsbuildLike | null {
  for (const dir of searchDirs) {
    if (!dir) continue;
    try {
      const req = createRequire(path.join(dir, "package.json"));
      const mod = req("esbuild") as EsbuildLike;
      if (typeof mod?.build === "function") return mod;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

export function describeEsbuildError(m: EsbuildMessage, srcDir: string): string {
  const missing = /^Could not resolve "([^"]+)"/.exec(m.text);
  const where = m.location?.file ? ` (${path.relative(srcDir, path.resolve(srcDir, m.location.file))}${m.location.line ? `:${m.location.line}` : ""})` : "";
  if (missing) {
    const pkg = missing[1].startsWith("@") ? missing[1].split("/").slice(0, 2).join("/") : missing[1].split("/")[0];
    if (pkg.startsWith(".") || pkg.startsWith("/")) return `Missing file "${missing[1]}"${where}`;
    return `Missing dependency "${pkg}"${where}. Glide does not download packages: run \`npm install\` in the extension folder yourself, then import it again.`;
  }
  return `${m.text}${where}`;
}

export interface BuildResult {
  built: string[];
  errors: string[];
}

/** Bundle every command of `manifest` from `srcDir` into `outDir`. Falls back to a pre-built dist/<name>.js. */
export async function buildRaycastCommands(srcDir: string, outDir: string, manifest: ExtensionManifest, esbuild: EsbuildLike | null): Promise<BuildResult> {
  const result: BuildResult = { built: [], errors: [] };
  fs.mkdirSync(outDir, { recursive: true });
  for (const cmd of manifest.commands) {
    const source = raycastSourceCandidates(cmd.name).find((rel) => fs.existsSync(path.join(srcDir, rel)));
    const outfile = path.join(outDir, `${cmd.name}.cjs`);
    if (source && esbuild) {
      try {
        const res = await esbuild.build({
          absWorkingDir: srcDir,
          entryPoints: [path.join(srcDir, source)],
          outfile,
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node20",
          jsx: "automatic",
          jsxImportSource: "react",
          external: RAYCAST_EXTERNALS,
          define: { "process.env.NODE_ENV": '"production"' },
          loader: { ".png": "file", ".svg": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file" },
          assetNames: "assets/[name]-[hash]",
          logLevel: "silent",
          write: true,
        });
        if (res.errors.length) result.errors.push(...res.errors.map((e) => `${cmd.name}: ${describeEsbuildError(e, srcDir)}`));
        else result.built.push(cmd.name);
      } catch (err) {
        const e = err as { errors?: EsbuildMessage[]; message?: string };
        if (e.errors?.length) result.errors.push(...e.errors.map((m) => `${cmd.name}: ${describeEsbuildError(m, srcDir)}`));
        else result.errors.push(`${cmd.name}: ${e.message ?? String(err)}`);
      }
      continue;
    }
    const prebuilt = path.join(srcDir, "dist", `${cmd.name}.js`);
    if (fs.existsSync(prebuilt)) {
      fs.copyFileSync(prebuilt, outfile);
      result.built.push(cmd.name);
      continue;
    }
    if (!source) result.errors.push(`${cmd.name}: no source file (expected ${raycastSourceCandidates(cmd.name).join(", ")})`);
    else
      result.errors.push(
        `${cmd.name}: building TypeScript/JSX needs esbuild, which this Glide build does not include. Build the extension with \`ray build\` (dist/${cmd.name}.js) or use a development build of Glide.`,
      );
  }
  return result;
}
