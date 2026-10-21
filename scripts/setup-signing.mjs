// One-time: creates a self-signed "Glide Local Signing" code-signing identity in its own keychain
// (~/Library/Keychains/glide-signing.keychain-db) and trusts it for code signing only.
// A stable identity keeps macOS privacy grants (Accessibility, …) across rebuilds; ad-hoc
// signatures are identified by their cdhash, which changes on every build.
//
// Usage: node scripts/setup-signing.mjs   (macOS asks once to approve the trust setting)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const IDENTITY = "Glide Local Signing";
export const KEYCHAIN = path.join(homedir(), "Library/Keychains/glide-signing.keychain-db");
export const PASSWORD_FILE = path.join(homedir(), ".config/glide/signing-keychain-password");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

if (existsSync(KEYCHAIN)) {
  console.log(`${KEYCHAIN} already exists; delete it with \`security delete-keychain\` to start over.`);
  process.exit(0);
}

const work = mkdtempSync(path.join(tmpdir(), "glide-signing-"));
try {
  writeFileSync(
    path.join(work, "cert.cnf"),
    [
      "[req]", "distinguished_name=dn", "x509_extensions=ext", "prompt=no",
      "[dn]", `CN=${IDENTITY}`,
      "[ext]", "basicConstraints=critical,CA:false", "keyUsage=critical,digitalSignature", "extendedKeyUsage=critical,codeSigning",
    ].join("\n"),
  );
  const key = path.join(work, "key.pem");
  const cert = path.join(work, "cert.pem");
  const p12 = path.join(work, "id.p12");
  const p12Pass = randomBytes(16).toString("hex");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "3650", "-config", path.join(work, "cert.cnf")], { stdio: "ignore" });
  run("openssl", ["pkcs12", "-export", "-legacy", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${p12Pass}`]);

  const kcPass = randomBytes(24).toString("hex");
  mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
  writeFileSync(PASSWORD_FILE, kcPass, { mode: 0o600 });
  run("security", ["create-keychain", "-p", kcPass, KEYCHAIN]);
  run("security", ["set-keychain-settings", KEYCHAIN]); // no auto-lock timeout
  run("security", ["unlock-keychain", "-p", kcPass, KEYCHAIN]);
  run("security", ["import", p12, "-k", KEYCHAIN, "-P", p12Pass, "-T", "/usr/bin/codesign"], { stdio: "ignore" });
  run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", kcPass, KEYCHAIN], { stdio: "ignore" });
  // Add to the search list so codesign finds the identity by name.
  const list = run("security", ["list-keychains", "-d", "user"]).split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (!list.includes(KEYCHAIN)) run("security", ["list-keychains", "-d", "user", "-s", ...list, KEYCHAIN]);
  console.log("Approve the macOS prompt to trust the certificate for code signing…");
  run("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", KEYCHAIN, cert], { stdio: "inherit" });
  console.log(run("security", ["find-identity", "-v", "-p", "codesigning", KEYCHAIN]));
} finally {
  rmSync(work, { recursive: true, force: true }); // the private key now lives only in the keychain
}
