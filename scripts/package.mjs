// Builds release/Glide-darwin-arm64/Glide.app: a menu-bar app (no Dock icon) with its own icon,
// ad-hoc signed so macOS runs it locally.
//
// Usage: node scripts/package.mjs [--zip] [--install]
//   --zip       also write release/Glide-darwin-arm64.zip and .sha256 (the assets the updater downloads)
//   --zip-only  only (re)zip an existing release/Glide-darwin-arm64/Glide.app (used after notarizing)
//   --install   copy the app to /Applications and delete release/ (one copy on disk)
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const appPath = path.join(releaseDir, "Glide-darwin-arm64", "Glide.app");
const ZIP_NAME = "Glide-darwin-arm64.zip";
const args = new Set(process.argv.slice(2));
const keep = [/^\/package\.json$/, /^\/dist(\/|$)/];
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** Stage build/bin/glide-helper alone so packager copies exactly it to Contents/Resources/bin/. */
function stageHelper() {
  const helper = path.join(root, "build/bin/glide-helper");
  if (!existsSync(helper)) {
    console.warn("warning: build/bin/glide-helper is missing (run `pnpm build:helper`); packaging without native features.");
    return [];
  }
  const stage = path.join(releaseDir, ".stage/bin");
  rmSync(path.dirname(stage), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(helper, path.join(stage, "glide-helper"));
  return [stage];
}

/**
 * Stage esbuild + its darwin-arm64 binary as <stage>/esbuild/node_modules/..., copied with symlinks
 * resolved (pnpm layout). Main loads it from Resources/esbuild to build imported Raycast extensions.
 */
function stageEsbuild() {
  const req = createRequire(path.join(root, "package.json"));
  let pkgDir, binDir;
  try {
    pkgDir = path.dirname(req.resolve("esbuild/package.json"));
    binDir = path.dirname(createRequire(path.join(pkgDir, "package.json")).resolve("@esbuild/darwin-arm64/package.json"));
  } catch {
    console.warn("warning: esbuild not found; packaged Glide can only import Raycast extensions that ship dist/ files.");
    return [];
  }
  const stage = path.join(releaseDir, ".stage-esbuild/esbuild");
  rmSync(path.dirname(stage), { recursive: true, force: true });
  cpSync(pkgDir, path.join(stage, "node_modules/esbuild"), { recursive: true, dereference: true });
  rmSync(path.join(stage, "node_modules/esbuild/node_modules"), { recursive: true, force: true });
  cpSync(binDir, path.join(stage, "node_modules/@esbuild/darwin-arm64"), { recursive: true, dereference: true });
  writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "glide-esbuild", private: true }) + "\n");
  return [stage];
}

/**
 * "Glide Local Signing" from scripts/setup-signing.mjs when it exists (a stable identity keeps
 * macOS privacy grants across rebuilds), else ad-hoc. GLIDE_SIGN_IDENTITY overrides.
 */
function signingIdentity() {
  if (process.env.GLIDE_SIGN_IDENTITY) return { id: process.env.GLIDE_SIGN_IDENTITY, args: [] };
  const keychain = path.join(homedir(), "Library/Keychains/glide-signing.keychain-db");
  const passFile = path.join(homedir(), ".config/glide/signing-keychain-password");
  if (!existsSync(keychain) || !existsSync(passFile)) return { id: "-", args: [] };
  try {
    execFileSync("security", ["unlock-keychain", "-p", readFileSync(passFile, "utf8").trim(), keychain]);
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning", keychain], { encoding: "utf8" });
    if (!out.includes('"Glide Local Signing"')) throw new Error("identity not trusted yet");
    return { id: "Glide Local Signing", args: ["--keychain", keychain] };
  } catch (err) {
    console.warn(`warning: Glide Local Signing unusable (${err.message}); signing ad-hoc, so privacy grants reset on reinstall.`);
    return { id: "-", args: [] };
  }
}

async function build() {
  // Bundled extension store (read by src/main/features/extensions from <Resources>/extensions-examples).
  const extraResource = [...stageHelper(), ...stageEsbuild(), path.join(root, "extensions-examples")];
  const [outDir] = await packager({
    dir: root,
    name: "Glide",
    executableName: "Glide",
    appBundleId: "dev.glide.launcher",
    appVersion: pkg.version,
    buildVersion: pkg.version,
    appCategoryType: "public.app-category.productivity",
    platform: "darwin",
    arch: "arm64",
    icon: path.join(root, "build/icon.icns"),
    out: releaseDir,
    overwrite: true,
    asar: true,
    // Everything is bundled by esbuild/Vite, so no node_modules ship (pnpm symlinks also break pruning).
    prune: false,
    darwinDarkModeSupport: true,
    extraResource,
    // The renderer and main process are fully bundled, so only dist/ and package.json ship.
    ignore: (file) => file !== "" && !keep.some((re) => re.test(file)),
    extendInfo: {
      LSUIElement: true, // menu-bar app: no Dock icon, like Raycast
      NSHumanReadableCopyright: "Glide",
      // Purpose strings for the TCC prompts Glide (or its helper, which TCC attributes to Glide) can trigger.
      // Accessibility and Input Monitoring have no Info.plist key: macOS shows its own prompt for those.
      NSAppleEventsUsageDescription: "Glide runs AppleScript actions in your workflows, pastes snippets and reads menus of the frontmost app.",
      NSCalendarsFullAccessUsageDescription: "Glide shows your upcoming events and lets you join meetings from the launcher.",
      NSCalendarsUsageDescription: "Glide shows your upcoming events and lets you join meetings from the launcher.",
      NSDesktopFolderUsageDescription: "Glide's file search can find files on your Desktop.",
      NSDocumentsFolderUsageDescription: "Glide's file search can find files in your Documents folder.",
      NSDownloadsFolderUsageDescription: "Glide's file search can find files in your Downloads folder.",
    },
  });
  rmSync(path.join(releaseDir, ".stage"), { recursive: true, force: true });
  rmSync(path.join(releaseDir, ".stage-esbuild"), { recursive: true, force: true });
  const app = path.join(outDir, "Glide.app");

  // --deep does not reach executables under Contents/Resources, so sign the helper first; the app's
  // seal then covers it, and the updater's `codesign --verify --deep --strict` checks both.
  const helper = path.join(app, "Contents/Resources/bin/glide-helper");
  const sign = signingIdentity();
  if (existsSync(helper)) execFileSync("codesign", ["--force", "--sign", sign.id, ...sign.args, "--identifier", "dev.glide.helper", helper], { stdio: "inherit" });
  const esbuildBin = path.join(app, "Contents/Resources/esbuild/node_modules/@esbuild/darwin-arm64/bin/esbuild");
  if (existsSync(esbuildBin)) execFileSync("codesign", ["--force", "--sign", "-", esbuildBin], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--deep", "--sign", sign.id, ...sign.args, app], { stdio: "inherit" });
  console.log(`signed with ${sign.id === "-" ? "an ad-hoc signature" : sign.id}`);
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  if (existsSync(helper)) execFileSync("codesign", ["--verify", "--strict", helper], { stdio: "inherit" });
  console.log("built", app, `(v${pkg.version})`);
}

/** release/Glide-darwin-arm64.zip + .sha256, in the format the updater verifies. */
function zip() {
  if (!existsSync(appPath)) throw new Error(`${appPath} does not exist; run without --zip-only first`);
  const zipPath = path.join(releaseDir, ZIP_NAME);
  rmSync(zipPath, { force: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { stdio: "inherit" });
  const sha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(`${zipPath}.sha256`, `${sha}  ${ZIP_NAME}\n`);
  console.log("zipped", zipPath, sha);
  console.log(`Publish both files as assets of a GitHub release tagged v${pkg.version}.`);
}

if (!args.has("--zip-only")) await build();
if (args.has("--zip") || args.has("--zip-only")) zip();

if (args.has("--install")) {
  const target = "/Applications/Glide.app";
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(appPath, target, { recursive: true, verbatimSymlinks: true });
  console.log("installed", target);
  // Leave a single copy on disk: Spotlight and Launchpad list every Glide.app they find.
  rmSync(releaseDir, { recursive: true, force: true });
}
