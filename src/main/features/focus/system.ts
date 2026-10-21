/** macOS lookups for Focus: frontmost app without permissions (lsappinfo) and the active browser tab URL. */
import { exec, osascript, asString } from "../../util/exec";
import type { NativeHelper } from "../../native/helper";

export interface Frontmost {
  name: string;
  bundleId: string | null;
  pid: number;
}

export function parseLsappinfo(out: string): Frontmost | null {
  const get = (key: string) => out.match(new RegExp(`"${key}"=(?:"([^"]*)"|(\\d+))`));
  const name = get("LSDisplayName")?.[1];
  const pid = Number(get("pid")?.[2]);
  if (!name || !pid) return null;
  return { name, bundleId: get("CFBundleIdentifier")?.[1] ?? null, pid };
}

export async function frontmostApp(helper: NativeHelper): Promise<Frontmost | null> {
  if (helper.available()) {
    try {
      const app = await helper.call("app.frontmost");
      if (app) return { name: app.name, bundleId: app.bundleId, pid: app.pid };
    } catch {
      // fall back to lsappinfo
    }
  }
  const front = await exec("lsappinfo", ["front"], { timeoutMs: 3_000 });
  const asn = front.stdout.trim();
  if (!asn.startsWith("ASN:")) return null;
  const info = await exec("lsappinfo", ["info", "-only", "bundleid", "-only", "name", "-only", "pid", asn], { timeoutMs: 3_000 });
  return parseLsappinfo(info.stdout);
}

const SAFARI = new Set(["com.apple.Safari", "com.apple.SafariTechnologyPreview"]);
const CHROMIUM = new Set(["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera"]);

export const isBrowser = (bundleId: string | null): boolean => !!bundleId && (SAFARI.has(bundleId) || CHROMIUM.has(bundleId));

/** Needs macOS Automation permission for that browser (asked once by macOS). */
export async function activeTabUrl(bundleId: string): Promise<string | null> {
  const script = SAFARI.has(bundleId)
    ? `tell application id ${asString(bundleId)} to return URL of current tab of front window`
    : CHROMIUM.has(bundleId)
      ? `tell application id ${asString(bundleId)} to return URL of active tab of front window`
      : null;
  if (!script) return null;
  try {
    const url = await osascript(script, { timeoutMs: 3_000 });
    return url || null;
  } catch {
    return null;
  }
}

/** Ask an app to quit politely (it can still prompt to save). Needs Automation permission for that app. */
export async function quitApp(app: { bundleId: string | null; name: string }): Promise<boolean> {
  const target = app.bundleId ? `application id ${asString(app.bundleId)}` : `application ${asString(app.name)}`;
  try {
    await osascript(`tell ${target} to quit`, { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function runShortcut(name: string): Promise<string | null> {
  try {
    const res = await exec("shortcuts", ["run", name], { timeoutMs: 15_000 });
    return res.code === 0 ? null : res.stderr.trim() || `shortcuts exited with ${res.code}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function bundleIdOf(appPath: string): Promise<string | null> {
  try {
    const res = await exec("/usr/bin/defaults", ["read", `${appPath}/Contents/Info`, "CFBundleIdentifier"], { timeoutMs: 3_000 });
    return res.code === 0 ? res.stdout.trim() || null : null;
  } catch {
    return null;
  }
}
