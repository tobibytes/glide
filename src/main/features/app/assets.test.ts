import { describe, expect, it } from "vitest";
import { assetPreference, parseRelease, pickUpdate, selectAssets, zipAssetName, type ReleaseInfo } from "./releases";
import { compareSemver, isNewer } from "./semver";
import { backgroundChecksAllowed } from "./updater";

const release = (archs: Array<"arm64" | "x64" | "universal">, opts: { noShaFor?: string } = {}): ReleaseInfo =>
  parseRelease({
    tag_name: "v1.0.0",
    name: "Glide 1.0.0",
    body: "",
    html_url: "https://github.com/tobibytes/glide/releases/tag/v1.0.0",
    assets: archs.flatMap((a) => {
      const name = zipAssetName(a);
      const out = [{ name, browser_download_url: `https://x/${name}` }];
      if (opts.noShaFor !== a) out.push({ name: `${name}.sha256`, browser_download_url: `https://x/${name}.sha256` });
      return out;
    }),
  })!;

describe("arch-aware asset selection", () => {
  it("prefers the native build, then universal", () => {
    expect(assetPreference("arm64")).toEqual(["arm64", "universal"]);
    expect(assetPreference("x64")).toEqual(["x64", "universal"]);
    expect(assetPreference("ia32")).toEqual(["universal"]);
  });

  it("picks the exact arch zip when present", () => {
    const r = release(["arm64", "x64", "universal"]);
    expect(selectAssets(r, "arm64")?.zip.name).toBe("Glide-darwin-arm64.zip");
    expect(selectAssets(r, "arm64")?.sha256.name).toBe("Glide-darwin-arm64.zip.sha256");
    expect(selectAssets(r, "x64")?.zip.name).toBe("Glide-darwin-x64.zip");
  });

  it("falls back to universal", () => {
    const r = release(["universal"]);
    expect(selectAssets(r, "arm64")?.zip.name).toBe("Glide-darwin-universal.zip");
    expect(selectAssets(r, "x64")?.zip.name).toBe("Glide-darwin-universal.zip");
    expect(selectAssets(r, "x64")?.sha256.name).toBe("Glide-darwin-universal.zip.sha256");
  });

  it("never offers another arch's build", () => {
    expect(selectAssets(release(["arm64"]), "x64")).toBeNull();
    expect(selectAssets(release(["x64"]), "arm64")).toBeNull();
    expect(selectAssets(release(["arm64", "x64"]), "ppc")).toBeNull();
  });

  it("skips a native zip without its checksum and uses universal instead", () => {
    const r = release(["arm64", "universal"], { noShaFor: "arm64" });
    expect(selectAssets(r, "arm64")?.zip.name).toBe("Glide-darwin-universal.zip");
    expect(selectAssets(release(["arm64"], { noShaFor: "arm64" }), "arm64")).toBeNull();
  });

  it("pickUpdate combines version compare and arch selection", () => {
    expect(pickUpdate(release(["universal"]), "0.9.9", "x64")?.zip.name).toBe("Glide-darwin-universal.zip");
    expect(pickUpdate(release(["universal"]), "1.0.0", "x64")).toBeNull();
    expect(pickUpdate(release(["universal"]), "1.0.0-rc.1", "arm64")?.release.version).toBe("1.0.0");
    expect(pickUpdate(release(["arm64"]), "0.1.0", "x64")).toBeNull();
  });
});

describe("version compare used by the updater", () => {
  it("orders release tags", () => {
    expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.2.1", "0.10.0")).toBe(false);
    expect(compareSemver("1.0.0", "1.0.0-beta.11")).toBe(1);
    expect(compareSemver("not-a-version", "0.0.1")).toBe(-1);
  });
});

describe("background update checks", () => {
  it("run only in a packaged, non-headless app unless a test feed is set", () => {
    expect(backgroundChecksAllowed({ packaged: true, headless: false })).toBe(true);
    expect(backgroundChecksAllowed({ packaged: false, headless: false })).toBe(false);
    expect(backgroundChecksAllowed({ packaged: true, headless: true })).toBe(false);
    expect(backgroundChecksAllowed({ packaged: false, headless: true, testBaseUrl: "http://127.0.0.1:1" })).toBe(true);
  });
});
