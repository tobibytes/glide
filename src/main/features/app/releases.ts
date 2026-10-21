/** GitHub Releases as an update feed: feed parsing, the API call and asset selection. */
import { isNewer, normaliseVersion } from "./semver";

export const ZIP_ASSET = "Glide-darwin-arm64.zip";
export const SHA_ASSET = `${ZIP_ASSET}.sha256`;
export const GITHUB_API = "https://api.github.com";

export interface ReleaseAsset {
  name: string;
  url: string;
  size?: number;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  pageUrl: string;
  assets: ReleaseAsset[];
}

export interface UpdateCandidate {
  release: ReleaseInfo;
  zip: ReleaseAsset;
  sha256: ReleaseAsset;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Accepts "owner/repo", "github.com/owner/repo" or a full https URL (".git" ok). Returns "owner/repo" or null. */
export function parseFeed(input: string): string | null {
  const s = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^(www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return null;
  return s.split("/").some((part) => /^\.+$/.test(part)) ? null : s;
}

export function latestReleaseUrl(feed: string, baseUrl = GITHUB_API): string {
  return `${baseUrl.replace(/\/+$/, "")}/repos/${feed}/releases/latest`;
}

/** Turn a GitHub "release" JSON object into ReleaseInfo; null for drafts, prereleases or bad tags. */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  if (!isRecord(raw) || raw.draft === true || raw.prerelease === true) return null;
  const tag = str(raw.tag_name);
  const version = normaliseVersion(tag);
  if (!version) return null;
  const assets: ReleaseAsset[] = (Array.isArray(raw.assets) ? raw.assets : []).flatMap((a): ReleaseAsset[] => {
    if (!isRecord(a) || !str(a.name) || !str(a.browser_download_url)) return [];
    return [{ name: str(a.name), url: str(a.browser_download_url), size: typeof a.size === "number" ? a.size : undefined }];
  });
  return { version, tag, name: str(raw.name) || tag, notes: str(raw.body), pageUrl: str(raw.html_url), assets };
}

/** The zip + checksum pair, or null when the release does not carry both. */
export function selectAssets(release: ReleaseInfo): { zip: ReleaseAsset; sha256: ReleaseAsset } | null {
  const zip = release.assets.find((a) => a.name === ZIP_ASSET);
  const sha256 = release.assets.find((a) => a.name === SHA_ASSET);
  return zip && sha256 ? { zip, sha256 } : null;
}

/** An update is offered only when the release is newer and has both assets. */
export function pickUpdate(release: ReleaseInfo | null, currentVersion: string): UpdateCandidate | null {
  if (!release || !isNewer(release.version, currentVersion)) return null;
  const assets = selectAssets(release);
  return assets ? { release, ...assets } : null;
}

/** Parse a `shasum -a 256` style file ("<hex>  name") or a bare hex digest. */
export function parseSha256File(text: string): string | null {
  const m = /\b([a-fA-F0-9]{64})\b/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export async function fetchLatestRelease(feed: string, opts: { baseUrl?: string; fetchImpl?: FetchLike; userAgent?: string } = {}): Promise<ReleaseInfo | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(latestReleaseUrl(feed, opts.baseUrl), {
    headers: { Accept: "application/vnd.github+json", "User-Agent": opts.userAgent ?? "Glide-Updater" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`No published release found for ${feed}`);
  if (!res.ok) throw new Error(`Update check failed: HTTP ${res.status}`);
  return parseRelease((await res.json()) as unknown);
}
