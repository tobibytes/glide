/**
 * End-to-end install against a LOCAL fake GitHub release: a real signed .app is zipped with ditto,
 * served with its checksum from a localhost server, and installed over a temp copy of "Glide.app".
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHA_ASSET, ZIP_ASSET } from "./releases";
import { createUpdater, type UpdateState } from "./updater";

const ID = "dev.glide.launcher";
let root: string;
let exe: string;
let server: http.Server;
let base: string;
/** path -> body served by the fake server; the release JSON is rebuilt per scenario. */
const routes = new Map<string, Buffer | string>();

function plist(id: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>Glide</string>
<key>CFBundleName</key><string>Glide</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>`;
}

function makeApp(dir: string, id: string, version: string): string {
  const app = path.join(dir, "Glide.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), plist(id, version));
  fs.copyFileSync(exe, path.join(app, "Contents/MacOS/Glide"));
  fs.writeFileSync(path.join(app, "Contents/Resources/version.txt"), version);
  execFileSync("codesign", ["--force", "--sign", "-", app]);
  return app;
}

/** Package a release exactly like scripts/package.mjs --zip does and publish it on the fake server. */
function publish(name: string, opts: { id?: string; version?: string; tamper?: "zip" | "signature" } = {}): void {
  const version = opts.version ?? "0.2.0";
  const dir = path.join(root, `build-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const app = makeApp(dir, opts.id ?? ID, version);
  if (opts.tamper === "signature") fs.writeFileSync(path.join(app, "Contents/Resources/version.txt"), "tampered");
  const zip = path.join(dir, ZIP_ASSET);
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  const bytes = fs.readFileSync(zip);
  const sha = createHash("sha256").update(bytes).digest("hex");
  routes.set(`/dl/${name}/${ZIP_ASSET}`, opts.tamper === "zip" ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
  routes.set(`/dl/${name}/${SHA_ASSET}`, `${sha}  ${ZIP_ASSET}\n`);
  routes.set(
    "/repos/tobi/glide/releases/latest",
    JSON.stringify({
      tag_name: `v${version}`,
      name: `Glide ${version}`,
      body: "",
      html_url: "https://github.com/tobi/glide/releases",
      draft: false,
      prerelease: false,
      assets: [
        { name: ZIP_ASSET, browser_download_url: `${base}/dl/${name}/${ZIP_ASSET}` },
        { name: SHA_ASSET, browser_download_url: `${base}/dl/${name}/${SHA_ASSET}` },
      ],
    }),
  );
}

function scenario(name: string) {
  const appsDir = path.join(root, `Applications-${name}`);
  const trashDir = path.join(root, `Trash-${name}`);
  fs.mkdirSync(appsDir, { recursive: true });
  fs.mkdirSync(trashDir, { recursive: true });
  const current = makeApp(appsDir, ID, "0.1.0");
  let relaunched = 0;
  const states: UpdateState[] = [];
  const updater = createUpdater({
    currentVersion: "0.1.0",
    getFeed: () => "tobi/glide",
    getAutoCheck: () => false,
    currentAppPath: () => current,
    workDir: () => path.join(root, `work-${name}`),
    trash: async (p) => fs.renameSync(p, path.join(trashDir, path.basename(p))),
    relaunch: () => void relaunched++,
    onChange: (s) => states.push(s),
    onAvailable: () => undefined,
    baseUrl: base, // what GLIDE_UPDATE_BASE_URL feeds in the app
    log: () => undefined,
  });
  return { current, trashDir, updater, states, relaunches: () => relaunched };
}

const version = (app: string) => fs.readFileSync(path.join(app, "Contents/Resources/version.txt"), "utf8");

describe.runIf(process.platform === "darwin")("update install (local fake release)", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "glide-updater-test-"));
    exe = path.join(root, "glide-bin");
    execFileSync("cc", ["-x", "c", "-o", exe, "-"], { input: "int main(void){return 0;}" });
    server = http.createServer((req, res) => {
      const body = routes.get(req.url ?? "");
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": typeof body === "string" ? "application/json" : "application/zip" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds, verifies, installs and relaunches", async () => {
    publish("ok");
    const s = scenario("ok");
    expect((await s.updater.check()).status).toBe("available");
    expect(s.updater.state().latestVersion).toBe("0.2.0");
    const end = await s.updater.install();
    expect(end.error).toBeUndefined();
    expect(end.phase).toBe("done");
    expect(version(s.current)).toBe("0.2.0");
    expect(version(path.join(s.trashDir, "Glide.app"))).toBe("0.1.0");
    execFileSync("codesign", ["--verify", "--deep", "--strict", s.current]);
    expect(s.relaunches()).toBe(1);
    const phases = s.states.map((x) => x.phase).filter((p, i, a) => p && p !== a[i - 1]);
    expect(phases).toEqual(["downloading", "verifying", "extracting", "checking-signature", "replacing", "done"]);
    expect(fs.readdirSync(path.dirname(s.current))).toEqual(["Glide.app"]); // no staging leftovers
  }, 30_000);

  it("reports up to date when the release is not newer", async () => {
    publish("same", { version: "0.1.0" });
    expect((await scenario("same").updater.check()).status).toBe("up-to-date");
  }, 30_000);

  const rejects: Array<[string, Parameters<typeof publish>[1], RegExp]> = [
    ["badsha", { tamper: "zip" }, /Checksum mismatch/],
    ["badsig", { tamper: "signature" }, /code signature is invalid/],
    ["badid", { id: "com.evil.app" }, /Bundle identifier mismatch/],
  ];
  for (const [name, opts, err] of rejects) {
    it(`refuses ${name} and leaves the installed app untouched`, async () => {
      publish(name, opts);
      const s = scenario(name);
      expect((await s.updater.check()).status).toBe("available");
      const end = await s.updater.install();
      expect(end.status).toBe("error");
      expect(end.error).toMatch(err);
      expect(version(s.current)).toBe("0.1.0");
      expect(fs.readdirSync(s.trashDir)).toEqual([]);
      expect(s.relaunches()).toBe(0);
    }, 30_000);
  }

  it("does nothing on the network without a feed", async () => {
    const before = routes.size;
    const u = createUpdater({
      currentVersion: "0.1.0",
      getFeed: () => "",
      getAutoCheck: () => true,
      currentAppPath: () => null,
      workDir: () => root,
      trash: async () => undefined,
      relaunch: () => undefined,
      onChange: () => undefined,
      onAvailable: () => undefined,
      fetchImpl: () => Promise.reject(new Error("network must not be used")),
      log: () => undefined,
    });
    expect((await u.check()).status).toBe("disabled");
    u.dispose();
    expect(routes.size).toBe(before);
  });
});
