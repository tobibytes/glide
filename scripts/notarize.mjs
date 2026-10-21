// Signs release/Glide-darwin-<arch>/Glide.app with a Developer ID (hardened runtime), notarizes it
// with Apple and staples the ticket. Run after `pnpm package`; pass --zip to rebuild the release zip.
// --arch arm64|x64|universal picks the build (default: the host arch, like package.mjs).
//
// Needs: APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD (an app-specific password from appleid.apple.com)
// and a "Developer ID Application" certificate in the login keychain. Optional: APPLE_SIGN_IDENTITY
// (a SHA-1 or full name) to pick between several identities. Without them it changes nothing and exits 1.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const ARCH = (() => {
  const i = argv.indexOf("--arch");
  const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--arch="))?.slice(7);
  return v ?? (process.arch === "x64" ? "x64" : "arm64");
})();
if (!["arm64", "x64", "universal"].includes(ARCH)) {
  console.error(`unknown --arch "${ARCH}" (use arm64, x64 or universal)`);
  process.exit(1);
}
const app = path.join(root, `release/Glide-darwin-${ARCH}/Glide.app`);
const appEntitlements = path.join(root, "build/entitlements.mac.plist");
const helperEntitlements = path.join(root, "build/entitlements.helper.plist");
const helperPath = path.join(app, "Contents/Resources/bin/glide-helper");

function findIdentities() {
  const r = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"/.exec(l))
    .filter(Boolean)
    .map((m) => ({ sha: m[1], name: m[2] }))
    .filter((i) => i.name.startsWith("Developer ID Application:"));
}

function preflight() {
  const missing = [];
  for (const key of ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_APP_PASSWORD"]) if (!process.env[key]) missing.push(`environment variable ${key}`);
  const team = process.env.APPLE_TEAM_ID;
  const wanted = process.env.APPLE_SIGN_IDENTITY;
  const ids = findIdentities().filter((i) => (wanted ? i.sha === wanted || i.name === wanted : !team || i.name.endsWith(`(${team})`)));
  if (!ids.length) missing.push(`a "Developer ID Application" signing identity${team ? ` for team ${team}` : ""} in your keychain`);
  if (ids.length > 1 && !wanted) missing.push(`APPLE_SIGN_IDENTITY to choose between: ${ids.map((i) => i.name).join("; ")}`);
  if (!existsSync(app)) missing.push(`${path.relative(root, app)} (run \`pnpm package\` first)`);
  if (!missing.length) return ids[0];

  console.error(`Cannot notarize Glide. Missing:\n${missing.map((m) => `  - ${m}`).join("\n")}

What you need (nothing has been changed):
  1. An Apple Developer Program membership (https://developer.apple.com/programs/).
  2. A "Developer ID Application" certificate: Xcode > Settings > Accounts > Manage Certificates > +,
     or developer.apple.com > Certificates. It must be in your login keychain with its private key;
     check with: security find-identity -v -p codesigning
  3. An app-specific password for your Apple ID: https://account.apple.com > Sign-In and Security.
  4. Then run:
       APPLE_ID=you@example.com APPLE_TEAM_ID=ABCDE12345 APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \\
         pnpm package && node scripts/notarize.mjs --zip --arch ${ARCH}`);
  process.exit(1);
}

const isMachO = (file) => {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(4);
    if (readSync(fd, b, 0, 4, 0) < 4) return false;
    const m = b.readUInt32BE(0);
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(m);
  } finally {
    closeSync(fd);
  }
};

/** Every nested bundle and loose Mach-O, deepest first (codesign must go inside-out). */
function nestedCode(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      nestedCode(p, out);
      if (/\.(app|framework|xpc|appex)$/.test(name)) out.push(p);
    } else if (st.isFile() && (st.mode & 0o111 || name.endsWith(".dylib") || name.endsWith(".node")) && isMachO(p)) out.push(p);
  }
  return out;
}

function sign(target, identity, entitlements) {
  const args = ["--force", "--timestamp", "--options", "runtime", "--sign", identity.sha];
  if (entitlements) args.push("--entitlements", entitlements);
  execFileSync("codesign", [...args, target], { stdio: "inherit" });
}

const identity = preflight();
console.log(`Signing with ${identity.name}`);
const contents = path.join(app, "Contents");
const nested = [...nestedCode(path.join(contents, "Frameworks")), ...(existsSync(path.join(contents, "Resources")) ? nestedCode(path.join(contents, "Resources")) : [])];
nested.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
for (const target of nested) {
  const entitlements = target === helperPath ? helperEntitlements : target.endsWith(".app") ? appEntitlements : undefined;
  sign(target, identity, entitlements);
}
sign(app, identity, appEntitlements);
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });

const tmp = mkdtempSync(path.join(tmpdir(), "glide-notarize-"));
try {
  const upload = path.join(tmp, "Glide.zip");
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, upload], { stdio: "inherit" });
  console.log("Submitting to Apple notary service (this can take several minutes)…");
  execFileSync(
    "xcrun",
    ["notarytool", "submit", upload, "--apple-id", process.env.APPLE_ID, "--team-id", process.env.APPLE_TEAM_ID, "--password", process.env.APPLE_APP_PASSWORD, "--wait"],
    { stdio: "inherit" },
  );
  execFileSync("xcrun", ["stapler", "staple", app], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", app], { stdio: "inherit" });
  execFileSync("spctl", ["--assess", "--type", "execute", "--verbose", app], { stdio: "inherit" });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("Notarized and stapled", app);
if (process.argv.includes("--zip")) execFileSync(process.execPath, [path.join(root, "scripts/package.mjs"), "--zip-only", "--arch", ARCH], { stdio: "inherit" });
