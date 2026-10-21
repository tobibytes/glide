// Compiles the Swift helper (src/native/GlideHelper/*.swift) into build/bin/glide-helper.
// Skips work when the binary is newer than every source; never fails the build on non-macOS hosts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src/native/GlideHelper");
const out = path.join(root, "build/bin/glide-helper");
const force = process.argv.includes("--force");

if (process.platform !== "darwin") {
  console.log("[build-helper] skipped: the helper only builds on macOS");
  process.exit(0);
}

const sources = readdirSync(srcDir).filter((f) => f.endsWith(".swift")).map((f) => path.join(srcDir, f));
const plist = path.join(srcDir, "Info.plist");
const newest = Math.max(...[...sources, plist].map((f) => statSync(f).mtimeMs));
if (!force && existsSync(out) && statSync(out).mtimeMs >= newest) {
  console.log("[build-helper] up to date");
  process.exit(0);
}

mkdirSync(path.dirname(out), { recursive: true });
const args = [
  "-O",
  "-swift-version", "5",
  "-target", "arm64-apple-macos14.0",
  "-module-name", "GlideHelper",
  // Embedded Info.plist: gives TCC a bundle id and the calendar usage string.
  "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
  "-o", out,
  ...sources,
];
const started = Date.now();
try {
  execFileSync("xcrun", ["swiftc", ...args], { stdio: "inherit" });
} catch {
  console.error("[build-helper] swiftc failed");
  process.exit(1);
}
execFileSync("codesign", ["--force", "--sign", "-", "--identifier", "dev.glide.launcher.helper", out], { stdio: "inherit" });
console.log(`[build-helper] built ${path.relative(root, out)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
