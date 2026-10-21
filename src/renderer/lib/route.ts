export type Route =
  | { mode: "launcher" }
  /** page "feature": a feature's settings page; `id` is the feature id ("#/settings/<featureId>") */
  | { mode: "settings"; page: SettingsPage; id?: string; anchor?: string }
  /** stand-alone feature window "#/<featureId>/<name>" */
  | { mode: "window"; route: string };

export type SettingsPage = "general" | "workflows" | "quicklinks" | "snippets" | "aliases" | "hotkeys" | "about" | "feature";

const PAGES: SettingsPage[] = ["general", "workflows", "quicklinks", "snippets", "aliases", "hotkeys", "about"];

/** Parse "#/settings/workflows/abc", "settings/workflows/abc", "/settings", "#/ai/chat" into a Route. */
export function parseRoute(input: string): Route {
  let raw = input.trim();
  if (raw.startsWith("#")) raw = raw.slice(1);
  raw = raw.replace(/^\/+/, "");
  let anchor: string | undefined;
  const hashIdx = raw.indexOf("#");
  if (hashIdx >= 0) {
    anchor = raw.slice(hashIdx + 1) || undefined;
    raw = raw.slice(0, hashIdx);
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] !== "settings") {
    if (parts.length >= 2) return { mode: "window", route: `${parts[0]}/${parts[1].split("?")[0]}` }; // windows read extra params from location.hash
    return { mode: "launcher" };
  }
  const seg = parts[1] ?? "";
  if (!seg) return { mode: "settings", page: "general", anchor };
  if ((PAGES as string[]).includes(seg)) return { mode: "settings", page: seg as SettingsPage, id: parts[2] ? safeDecode(parts[2]) : undefined, anchor };
  // Unknown pages are feature settings pages; Settings falls back to General when no such feature exists.
  return { mode: "settings", page: "feature", id: safeDecode(seg), anchor };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function settingsHash(page: SettingsPage, id?: string, anchor?: string): string {
  let h = page === "feature" ? `#/settings/${encodeURIComponent(id ?? "")}` : `#/settings/${page}`;
  if (page !== "feature" && id) h += `/${encodeURIComponent(id)}`;
  if (anchor) h += `#${anchor}`;
  return h;
}

export function navigateTo(page: SettingsPage, id?: string, anchor?: string): void {
  location.hash = settingsHash(page, id, anchor);
}
