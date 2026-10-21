// Pack a built extension folder into a store package (.tgz) and print its store/index.json entry.
//
//   node scripts/store-pack.mjs <extension-folder> [--out <file.tgz>] [--url <download url>]
//        [--id <id>] [--categories "A,B"] [--min-glide 0.2.0] [--screenshot <url>]...
//
// Packs package.json, dist/, assets/, README/CHANGELOG/LICENSE and the command entry files, under
// "package/" like npm. Symlinks are refused. The archive is reproducible (fixed mtimes, sorted paths).
// Uses the same tar code as the installer (Node's built-in TypeScript type stripping).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createTgz } from "../src/main/features/extensions/store-tar.ts";

const args = process.argv.slice(2);
const opts = { screenshots: [] };
let folder;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) fail(`${a} needs a value`);
    return v;
  };
  if (a === "--out") opts.out = next();
  else if (a === "--url") opts.url = next();
  else if (a === "--id") opts.id = next();
  else if (a === "--categories") opts.categories = next();
  else if (a === "--min-glide") opts.minGlide = next();
  else if (a === "--screenshot") opts.screenshots.push(next());
  else if (a === "-h" || a === "--help") usage(0);
  else if (a.startsWith("-")) fail(`Unknown option ${a}`);
  else folder = a;
}
if (!folder) usage(1);

function usage(code) {
  console.error("usage: node scripts/store-pack.mjs <extension-folder> [--out file.tgz] [--url URL] [--id ID] [--categories A,B] [--min-glide 0.2.0] [--screenshot URL]");
  process.exit(code);
}
function fail(msg) {
  console.error(`store-pack: ${msg}`);
  process.exit(1);
}

const root = path.resolve(folder);
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
} catch (err) {
  fail(`cannot read ${path.join(root, "package.json")}: ${err.message}`);
}
const isRaycast = Array.isArray(pkg.commands);
const meta = isRaycast ? pkg : pkg.glide;
if (!meta || !Array.isArray(meta.commands) || !meta.commands.length) fail('package.json needs "glide.commands" (Glide) or "commands" (Raycast)');
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(pkg.name ?? "")) fail(`invalid package name ${JSON.stringify(pkg.name)}`);
if (!/^\d+\.\d+\.\d+/.test(pkg.version ?? "")) fail(`package.json "version" must be semver (got ${JSON.stringify(pkg.version)})`);

const files = new Map(); // archive path -> absolute path
function addFile(rel) {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) fail(`${rel} is a symlink; store packages may only contain regular files`);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) if (!name.startsWith(".")) addFile(path.posix.join(rel, name));
  } else if (st.isFile()) files.set(rel, abs);
}
const exists = (rel) => fs.existsSync(path.join(root, rel));
addFile("package.json");
for (const extra of ["dist", "assets", "README.md", "CHANGELOG.md", "LICENSE", "LICENSE.md"]) if (exists(extra)) addFile(extra);
for (const c of meta.commands) {
  const candidates = isRaycast ? [`dist/${c.name}.js`] : [`dist/${c.name}.js`, `dist/${c.name}.cjs`, `${c.name}.js`, `${c.name}.cjs`, `src/${c.name}.js`, `src/${c.name}.cjs`];
  const entry = candidates.find(exists);
  if (!entry) fail(`command "${c.name}" is not built (looked for ${candidates.join(", ")})${isRaycast ? " — run `npm run build` (ray build) first" : ""}`);
  if (!files.has(entry)) addFile(entry);
}
if (typeof meta.icon === "string" && /\.(png|jpe?g|svg|webp)$/i.test(meta.icon) && !exists(path.join("assets", meta.icon))) console.error(`store-pack: warning: icon ${meta.icon} is not in assets/`);

const entries = [...files.keys()].sort().map((rel) => {
  const st = fs.statSync(files.get(rel));
  return { path: `package/${rel}`, data: fs.readFileSync(files.get(rel)), mode: st.mode & 0o111 ? 0o755 : 0o644 };
});
const tgz = createTgz(entries);
const out = path.resolve(opts.out ?? `${pkg.name}-${pkg.version}.tgz`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, tgz);
const sha256 = crypto.createHash("sha256").update(tgz).digest("hex");

const icon = typeof meta.icon === "string" && !/\.(png|jpe?g|svg|webp)$/i.test(meta.icon) ? meta.icon : undefined;
const entry = {
  id: (opts.id ?? pkg.name).toLowerCase(),
  name: pkg.name,
  title: meta.title ?? pkg.name,
  description: meta.description ?? pkg.description ?? "",
  author: typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? meta.author ?? "unknown"),
  version: pkg.version,
  categories: opts.categories ? opts.categories.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(meta.categories) ? meta.categories : [],
  ...(icon ? { icon } : {}),
  kind: isRaycast ? "raycast" : "glide",
  minGlideVersion: opts.minGlide ?? "0.2.0",
  commands: meta.commands.map((c) => ({ name: c.name, title: c.title ?? c.name, ...(c.description ? { description: c.description } : {}), ...(c.mode ? { mode: c.mode } : {}) })),
  download: { url: opts.url ?? path.basename(out), sha256, size: tgz.length },
  screenshots: opts.screenshots,
  changelog: [{ version: pkg.version, notes: "Describe this release." }],
  ...(pkg.license ? { license: pkg.license } : {}),
};
console.error(`store-pack: wrote ${out} (${tgz.length} bytes, ${entries.length} files)`);
console.log(JSON.stringify(entry, null, 2));
