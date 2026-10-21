// Builds release/Glide-darwin-<arch>/Glide.app: a menu-bar app (no Dock icon) with its own icon,
// signed with "Glide Local Signing" when set up (scripts/setup-signing.mjs), else ad-hoc.
//
// Usage: node scripts/package.mjs [--arch arm64|x64|universal] [--zip] [--zip-only] [--install]
//   --arch      target architecture; defaults to the host arch. `universal` builds x64 + arm64 slices
//               and stitches them with @electron/universal (needs the x64 Electron zip, which
//               @electron/packager downloads into its cache on first use).
//   --zip       also write release/Glide-darwin-<arch>.zip and .sha256 (the assets the updater downloads)
//   --zip-only  only (re)zip an existing release/Glide-darwin-<arch>/Glide.app (used after notarizing)
//   --install   copy the app to /Applications and delete release/ (one copy on disk)
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const argv = process.argv.slice(2);
const args = new Set(argv);
const ARCH = (() => {
  const i = argv.indexOf("--arch");
  const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--arch="))?.slice(7);
  return v ?? (process.arch === "x64" ? "x64" : "arm64");
})();
if (!["arm64", "x64", "universal"].includes(ARCH)) {
  console.error(`unknown --arch "${ARCH}" (use arm64, x64 or universal)`);
  process.exit(1);
}
/** Mach-O slices (as `lipo -archs` names them) every shipped binary must carry. */
const SLICES = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[ARCH];
/** @esbuild/* platform packages to stage: the JS loader picks one by process.arch at runtime. */
const ESBUILD_PLATFORMS = { arm64: ["darwin-arm64"], x64: ["darwin-x64"], universal: ["darwin-arm64", "darwin-x64"] }[ARCH];
const appPath = path.join(releaseDir, `Glide-darwin-${ARCH}`, "Glide.app");
const ZIP_NAME = `Glide-darwin-${ARCH}.zip`;
const keep = [/^\/package\.json$/, /^\/dist(\/|$)/];
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function archsOf(file) {
  try {
    return execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);
  } catch {
    return [];
  }
}
const covers = (file) => SLICES.every((s) => archsOf(file).includes(s));

/**
 * Stage the helper alone so packager copies exactly it to Contents/Resources/bin/. Reuses
 * build/bin/glide-helper when it already has every slice; otherwise compiles one for ARCH into the
 * stage (build/bin keeps its fast host-arch dev build).
 */
function stageHelper() {
  const helper = path.join(root, "build/bin/glide-helper");
  const stage = path.join(releaseDir, ".stage/bin");
  rmSync(path.dirname(stage), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const staged = path.join(stage, "glide-helper");
  if (existsSync(helper) && covers(helper)) {
    cpSync(helper, staged);
    return [stage];
  }
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/build-helper.mjs"), "--arch", ARCH, "--out", staged, "--force"], { stdio: "inherit" });
  } catch {
    // Without a helper the app still runs; native features report "helper not available".
  }
  if (existsSync(staged) && covers(staged)) return [stage];
  console.warn(`warning: no ${ARCH} glide-helper could be built; packaging without native features.`);
  rmSync(path.dirname(stage), { recursive: true, force: true });
  return [];
}

/**
 * Stage esbuild + its darwin binaries for ARCH as <stage>/esbuild/node_modules/..., copied with
 * symlinks resolved (pnpm layout). Main loads it from Resources/esbuild to build imported Raycast
 * extensions. pnpm installs only the host's @esbuild/* package, so a missing one is skipped: on that
 * arch Glide can then only import Raycast extensions that ship prebuilt dist/ files.
 */
function stageEsbuild() {
  const req = createRequire(path.join(root, "package.json"));
  let pkgDir;
  try {
    pkgDir = path.dirname(req.resolve("esbuild/package.json"));
  } catch {
    console.warn("warning: esbuild not found; packaged Glide can only import Raycast extensions that ship dist/ files.");
    return [];
  }
  const esReq = createRequire(path.join(pkgDir, "package.json"));
  const found = ESBUILD_PLATFORMS.flatMap((platform) => {
    try {
      return [{ platform, dir: path.dirname(esReq.resolve(`@esbuild/${platform}/package.json`)) }];
    } catch {
      console.warn(`warning: @esbuild/${platform} is not installed; on that arch packaged Glide can only import Raycast extensions that ship dist/ files.`);
      return [];
    }
  });
  if (!found.length) return [];
  const stage = path.join(releaseDir, ".stage-esbuild/esbuild");
  rmSync(path.dirname(stage), { recursive: true, force: true });
  cpSync(pkgDir, path.join(stage, "node_modules/esbuild"), { recursive: true, dereference: true });
  rmSync(path.join(stage, "node_modules/esbuild/node_modules"), { recursive: true, force: true });
  for (const { platform, dir } of found) cpSync(dir, path.join(stage, `node_modules/@esbuild/${platform}`), { recursive: true, dereference: true });
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
  // store/ holds the extension-store index (categories, changelogs) read from <Resources>/store.
  const extraResource = [...stageHelper(), ...stageEsbuild(), path.join(root, "extensions-examples"), path.join(root, "store")];
  const cleanStages = () => {
    rmSync(path.join(releaseDir, ".stage"), { recursive: true, force: true });
    rmSync(path.join(releaseDir, ".stage-esbuild"), { recursive: true, force: true });
  };
  if (ARCH !== process.arch) console.log(`note: ${ARCH} needs the darwin-${ARCH === "universal" ? "x64 (and arm64)" : ARCH} Electron zip; @electron/packager downloads it into its cache if missing.`);
  let outDir;
  try {
    [outDir] = await packager({
      dir: root,
      name: "Glide",
      executableName: "Glide",
      appBundleId: "dev.glide.launcher",
      appVersion: pkg.version,
      buildVersion: pkg.version,
      appCategoryType: "public.app-category.productivity",
      platform: "darwin",
      arch: ARCH,
      // The staged esbuild binaries are per-platform packages, identical in both slices (the JS
      // loader picks one at runtime), so @electron/universal must copy rather than lipo them.
      osxUniversal: { x64ArchFiles: "Contents/Resources/esbuild/**" },
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
        NSRemindersFullAccessUsageDescription: "Glide creates and completes reminders from the launcher.",
        NSRemindersUsageDescription: "Glide creates and completes reminders from the launcher.",
        NSLocationWhenInUseUsageDescription: "macOS only reveals your Wi‑Fi network name to apps with Location access; Glide uses it for Wi‑Fi automations.",
        NSLocationUsageDescription: "macOS only reveals your Wi‑Fi network name to apps with Location access; Glide uses it for Wi‑Fi automations.",
        // glide://oauth delivers OAuth redirects to extensions.
        CFBundleURLTypes: [{ CFBundleURLName: "dev.glide.launcher", CFBundleURLSchemes: ["glide"] }],
      },
    });
  } finally {
    cleanStages();
  }
  const app = path.join(outDir, "Glide.app");

  // --deep does not reach executables under Contents/Resources, so sign the helper first; the app's
  // seal then covers it, and the updater's `codesign --verify --deep --strict` checks both.
  const helper = path.join(app, "Contents/Resources/bin/glide-helper");
  const sign = signingIdentity();
  if (existsSync(helper)) execFileSync("codesign", ["--force", "--sign", sign.id, ...sign.args, "--identifier", "dev.glide.helper", helper], { stdio: "inherit" });
  const esbuildPkgs = path.join(app, "Contents/Resources/esbuild/node_modules/@esbuild");
  for (const platform of existsSync(esbuildPkgs) ? readdirSync(esbuildPkgs) : []) {
    const bin = path.join(esbuildPkgs, platform, "bin/esbuild");
    if (existsSync(bin)) execFileSync("codesign", ["--force", "--sign", "-", bin], { stdio: "inherit" });
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", sign.id, ...sign.args, app], { stdio: "inherit" });
  console.log(`signed with ${sign.id === "-" ? "an ad-hoc signature" : sign.id}`);
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  if (existsSync(helper)) execFileSync("codesign", ["--verify", "--strict", helper], { stdio: "inherit" });
  const mainBin = path.join(app, "Contents/MacOS/Glide");
  for (const bin of [mainBin, helper]) {
    if (!existsSync(bin)) continue;
    if (!covers(bin)) throw new Error(`${path.relative(app, bin)} has slices [${archsOf(bin).join(" ")}], expected [${SLICES.join(" ")}]`);
    console.log(`${path.relative(app, bin)}: ${archsOf(bin).join(" ")}`);
  }
  console.log("built", app, `(v${pkg.version}, ${ARCH})`);
}

/** release/Glide-darwin-<arch>.zip + .sha256, in the format the updater verifies. */
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
