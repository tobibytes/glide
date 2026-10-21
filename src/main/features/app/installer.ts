/**
 * Downloads, verifies and swaps in a new Glide.app. Electron-free so it can be tested end to end
 * against a local fake release; the caller injects `trash` (shell.trashItem in the app).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { parseSha256File, type FetchLike, type UpdateCandidate } from "./releases";
import { compareSemver } from "./semver";

const run = promisify(execFile);

export type InstallPhase = "downloading" | "verifying" | "extracting" | "checking-signature" | "replacing" | "done";

export interface InstallOptions {
  candidate: UpdateCandidate;
  /** The bundle being replaced, e.g. /Applications/Glide.app. */
  currentAppPath: string;
  /** Scratch directory (created; removed afterwards by the caller or the OS). */
  workDir: string;
  /** Move a path to the Trash (shell.trashItem). */
  trash(p: string): Promise<void>;
  fetchImpl?: FetchLike;
  onPhase?(phase: InstallPhase): void;
}

export interface InstallResult {
  appPath: string;
  version: string;
}

async function download(url: string, dest: string, doFetch: FetchLike): Promise<void> {
  const res = await doFetch(url, { headers: { Accept: "application/octet-stream", "User-Agent": "Glide-Updater" }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${path.basename(dest)}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(file);
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function readPlistValue(appPath: string, key: string): Promise<string> {
  const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(appPath, "Contents/Info.plist")]);
  return stdout.trim();
}

export async function verifyCodeSignature(appPath: string): Promise<void> {
  try {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || String(err);
    throw new Error(`The downloaded app's code signature is invalid: ${detail}`);
  }
}

/** Rename, falling back to a copy when the paths are on different volumes. */
async function move(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await run("/usr/bin/ditto", [from, to]);
    await fs.rm(from, { recursive: true, force: true });
  }
}

export async function installUpdate(opts: InstallOptions): Promise<InstallResult> {
  const { candidate, currentAppPath, workDir } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const phase = (p: InstallPhase) => opts.onPhase?.(p);
  await fs.mkdir(workDir, { recursive: true });

  phase("downloading");
  const zipPath = path.join(workDir, candidate.zip.name);
  const shaPath = path.join(workDir, candidate.sha256.name);
  await download(candidate.sha256.url, shaPath, doFetch);
  await download(candidate.zip.url, zipPath, doFetch);

  phase("verifying");
  const expected = parseSha256File(await fs.readFile(shaPath, "utf8"));
  if (!expected) throw new Error("The checksum file is malformed");
  const actual = await sha256File(zipPath);
  if (actual !== expected) throw new Error(`Checksum mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);

  phase("extracting");
  const extractDir = path.join(workDir, "extracted");
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir);
  await run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
  const apps = (await fs.readdir(extractDir)).filter((n) => n.endsWith(".app"));
  if (apps.length !== 1) throw new Error(`Expected one .app in the update, found ${apps.length}`);
  const newApp = path.join(extractDir, apps[0]!);

  phase("checking-signature");
  await verifyCodeSignature(newApp);
  const [newId, currentId] = await Promise.all([readPlistValue(newApp, "CFBundleIdentifier"), readPlistValue(currentAppPath, "CFBundleIdentifier")]);
  if (newId !== currentId) throw new Error(`Bundle identifier mismatch: update is "${newId}", installed app is "${currentId}"`);
  const newVersion = await readPlistValue(newApp, "CFBundleShortVersionString");
  if (compareSemver(newVersion, candidate.release.version) !== 0) {
    throw new Error(`The update bundle reports version ${newVersion}, but the release is ${candidate.release.version}`);
  }

  phase("replacing");
  // Stage next to the current bundle first so the final step is a same-volume rename.
  const staged = path.join(path.dirname(currentAppPath), `.${path.basename(currentAppPath)}.update-${Date.now()}`);
  await move(newApp, staged);
  try {
    await opts.trash(currentAppPath);
  } catch (err) {
    await fs.rm(staged, { recursive: true, force: true });
    throw new Error(`Could not move the current app to the Trash: ${err instanceof Error ? err.message : String(err)}`);
  }
  await fs.rename(staged, currentAppPath);
  phase("done");
  return { appPath: currentAppPath, version: newVersion };
}
