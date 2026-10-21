/**
 * Current Wi-Fi network via the helper's CoreWLAN read ("wifi.info"). macOS 14+ hides the SSID
 * from processes without Location access, so callers get `needsLocation: true` and should point
 * the user at Settings → Finder → "Allow Location Access…" (requestWifiLocation) instead of prompting.
 */
import type { NativeHelper, WifiInfo } from "./helper";

/** Never prompts. null when the helper is missing/too old or the call fails. */
export async function getWifiInfo(helper: NativeHelper): Promise<WifiInfo | null> {
  if (!helper.available()) return null;
  try {
    return await helper.call("wifi.info");
  } catch {
    return null;
  }
}

/** Convenience for automations: the SSID, or null when disconnected, unknown or hidden. */
export async function currentWifiSsid(helper: NativeHelper): Promise<string | null> {
  return (await getWifiInfo(helper))?.ssid ?? null;
}

/** Shows the Location prompt (first time only). Call ONLY from an explicit user action. */
export async function requestWifiLocation(helper: NativeHelper): Promise<WifiInfo | null> {
  if (!helper.available()) return null;
  try {
    await helper.call("permissions.request", { kind: "location" });
  } catch {
    /* refused (headless) or failed: report the current state */
  }
  return getWifiInfo(helper);
}
