import { describe, expect, it } from "vitest";
import { compareSemver, isNewer, normaliseVersion, parseSemver } from "./semver";

describe("semver", () => {
  it("parses with and without v prefix", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("1.2.3-beta.2+build.7")?.prerelease).toEqual(["beta", 2]);
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
  });

  it("orders core versions numerically, not lexically", () => {
    expect(compareSemver("0.10.0", "0.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("v2.0.0", "10.0.0")).toBe(-1);
  });

  it("follows SemVer prerelease precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i < ordered.length - 1; i++) expect(compareSemver(ordered[i]!, ordered[i + 1]!)).toBe(-1);
  });

  it("ignores build metadata and treats junk as oldest", () => {
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compareSemver("nonsense", "0.0.1")).toBe(-1);
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(normaliseVersion("v0.2.0")).toBe("0.2.0");
  });
});
