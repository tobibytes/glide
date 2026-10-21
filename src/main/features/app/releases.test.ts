import { describe, expect, it } from "vitest";
import { latestReleaseUrl, parseFeed, parseRelease, parseSha256File, pickUpdate, selectAssets, SHA_ASSET, ZIP_ASSET } from "./releases";

const gh = (over: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.0",
  name: "Glide 0.2.0",
  body: "Notes",
  html_url: "https://github.com/o/r/releases/tag/v0.2.0",
  draft: false,
  prerelease: false,
  assets: [
    { name: "Glide-darwin-x64.zip", browser_download_url: "https://x/x64.zip" },
    { name: ZIP_ASSET, browser_download_url: "https://x/arm.zip", size: 10 },
    { name: SHA_ASSET, browser_download_url: "https://x/arm.zip.sha256" },
  ],
  ...over,
});

describe("update feed", () => {
  it("parses owner/repo and GitHub URLs", () => {
    expect(parseFeed("tobi/glide")).toBe("tobi/glide");
    expect(parseFeed(" https://github.com/tobi/glide.git ")).toBe("tobi/glide");
    expect(parseFeed("github.com/tobi/glide/")).toBe("tobi/glide");
    expect(parseFeed("")).toBeNull();
    expect(parseFeed("tobi")).toBeNull();
    expect(parseFeed("a/b/c")).toBeNull();
    expect(parseFeed("../etc")).toBeNull();
  });
  it("builds the latest-release URL, honouring a base override", () => {
    expect(latestReleaseUrl("o/r")).toBe("https://api.github.com/repos/o/r/releases/latest");
    expect(latestReleaseUrl("o/r", "http://127.0.0.1:5/")).toBe("http://127.0.0.1:5/repos/o/r/releases/latest");
  });
});

describe("release selection", () => {
  it("selects the arm64 zip and its checksum by exact name", () => {
    const r = parseRelease(gh())!;
    expect(r.version).toBe("0.2.0");
    expect(selectAssets(r, "arm64")).toEqual({ zip: { name: ZIP_ASSET, url: "https://x/arm.zip", size: 10 }, sha256: { name: SHA_ASSET, url: "https://x/arm.zip.sha256", size: undefined } });
  });
  it("offers an update only when newer and complete", () => {
    expect(pickUpdate(parseRelease(gh()), "0.1.0", "arm64")?.release.version).toBe("0.2.0");
    expect(pickUpdate(parseRelease(gh()), "0.2.0")).toBeNull();
    expect(pickUpdate(parseRelease(gh()), "0.10.0")).toBeNull();
    const noSha = gh({ assets: [{ name: ZIP_ASSET, browser_download_url: "https://x/a.zip" }] });
    expect(pickUpdate(parseRelease(noSha), "0.1.0", "arm64")).toBeNull();
  });
  it("ignores drafts, prereleases and non-semver tags", () => {
    expect(parseRelease(gh({ draft: true }))).toBeNull();
    expect(parseRelease(gh({ prerelease: true }))).toBeNull();
    expect(parseRelease(gh({ tag_name: "nightly" }))).toBeNull();
    expect(parseRelease("nope")).toBeNull();
  });
  it("reads shasum output and bare digests", () => {
    const hex = "a".repeat(64);
    expect(parseSha256File(`${hex}  Glide-darwin-arm64.zip\n`)).toBe(hex);
    expect(parseSha256File(hex.toUpperCase())).toBe(hex);
    expect(parseSha256File("abc")).toBeNull();
  });
});
