/** GitHub Releases as an update feed: feed parsing, the API call and asset selection. */
import { isNewer, normaliseVersion } from "./semver";

export type ReleaseArch = "arm64" | "x64" | "universal";
export const zipAssetName = (arch: ReleaseArch): string => `Glide-darwin-${arch}.zip`;
export const ZIP_ASSET = zipAssetName("arm64");
export const SHA_ASSET = `${ZIP_ASSET}.sha256`;
export const GITHUB_API = "https://api.github.com";

/**
 * Asset preference for a running process.arch: the native build first, then the universal one.
 * Unknown archs get only the universal build (it is the only one that could run there).
 */
export function assetPreference(processArch: string): ReleaseArch[] {
  if (processArch === "arm64") return ["arm64", "universal"];
  if (processArch === "x64") return ["x64", "universal"];
  return ["universal"];
}

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

/**
 * The zip + checksum pair for this arch (exact names, native build before universal), or null when
 * the release carries no complete pair that can run here.
 */
export function selectAssets(release: ReleaseInfo, processArch: string = process.arch): { zip: ReleaseAsset; sha256: ReleaseAsset } | null {
  for (const arch of assetPreference(processArch)) {
    const name = zipAssetName(arch);
    const zip = release.assets.find((a) => a.name === name);
    const sha256 = release.assets.find((a) => a.name === `${name}.sha256`);
    if (zip && sha256) return { zip, sha256 };
  }
  return null;
}

/** An update is offered only when the release is newer and has a complete asset pair for this arch. */
export function pickUpdate(release: ReleaseInfo | null, currentVersion: string, processArch: string = process.arch): UpdateCandidate | null {
  if (!release || !isNewer(release.version, currentVersion)) return null;
  const assets = selectAssets(release, processArch);
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
