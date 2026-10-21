// Compiles the Swift helper (src/native/GlideHelper/*.swift) into build/bin/glide-helper.
// Skips work when the binary is newer than every source and already has the requested slices;
// never fails the build on non-macOS hosts.
//
// Usage: node scripts/build-helper.mjs [--arch arm64|x64|universal] [--out <path>] [--force]
//   --arch defaults to the host arch (fast dev builds); releases pass --arch universal, which
//   compiles an arm64 and an x86_64 slice and joins them with `lipo`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src/native/GlideHelper");
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const out = path.resolve(root, option("out") ?? "build/bin/glide-helper");
const force = argv.includes("--force");
const archArg = option("arch");
const arch = archArg ?? (process.arch === "x64" ? "x64" : "arm64");
if (!["arm64", "x64", "universal"].includes(arch)) {
  console.error(`[build-helper] unknown --arch "${arch}" (use arm64, x64 or universal)`);
  process.exit(1);
}
/** Mach-O arch names (as `lipo -archs` prints them) the output must contain. */
const SLICES = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[arch];

if (process.platform !== "darwin") {
  console.log("[build-helper] skipped: the helper only builds on macOS");
  process.exit(0);
}

function archsOf(file) {
  try {
    return execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/).sort();
  } catch {
    return [];
  }
}

const sources = readdirSync(srcDir).filter((f) => f.endsWith(".swift")).map((f) => path.join(srcDir, f));
const plist = path.join(srcDir, "Info.plist");
const newest = Math.max(...[...sources, plist].map((f) => statSync(f).mtimeMs));
const sameSlices = (have) => have.join(" ") === [...SLICES].sort().join(" ");
if (!force && existsSync(out) && statSync(out).mtimeMs >= newest && sameSlices(archsOf(out))) {
  console.log(`[build-helper] up to date (${SLICES.join(" + ")})`);
  process.exit(0);
}

mkdirSync(path.dirname(out), { recursive: true });
const swiftArgs = (slice, output) => [
  "-O",
  "-swift-version", "5",
  "-target", `${slice}-apple-macos14.0`,
  "-module-name", "GlideHelper",
  // Embedded Info.plist: gives TCC a bundle id and the calendar usage string.
  "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
  "-o", output,
  ...sources,
];
const started = Date.now();
const sliceOut = (slice) => (SLICES.length === 1 ? out : `${out}.${slice}`);
try {
  for (const slice of SLICES) execFileSync("xcrun", ["swiftc", ...swiftArgs(slice, sliceOut(slice))], { stdio: "inherit" });
} catch {
  console.error("[build-helper] swiftc failed");
  process.exit(1);
}
if (SLICES.length > 1) {
  rmSync(out, { force: true });
  execFileSync("lipo", ["-create", ...SLICES.map(sliceOut), "-output", out], { stdio: "inherit" });
  for (const slice of SLICES) rmSync(sliceOut(slice), { force: true });
}
execFileSync("codesign", ["--force", "--sign", "-", "--identifier", "dev.glide.launcher.helper", out], { stdio: "inherit" });
const got = archsOf(out);
if (!sameSlices(got)) {
  console.error(`[build-helper] expected slices ${SLICES.join(" ")}, got ${got.join(" ") || "none"}`);
  process.exit(1);
}
console.log(`[build-helper] built ${path.relative(root, out)} [${got.join(" ")}] in ${((Date.now() - started) / 1000).toFixed(1)}s`);
