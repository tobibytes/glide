import { describe, expect, it } from "vitest";
import { DEFAULT_USER_EXCLUSIONS, Exclusions, protectedFolders } from "../exclusions";

const home = "/Users/me";
const make = (extra: Partial<ConstructorParameters<typeof Exclusions>[0]> = {}) =>
  new Exclusions({ home, includeHidden: false, userPatterns: DEFAULT_USER_EXCLUSIONS, ruleRoots: [home, "/private/tmp/scope"], ...extra });

describe("built-in and user exclusions", () => {
  it("skips VCS, dependency, build and cache folders", () => {
    const ex = make();
    for (const n of [".git", "node_modules", "build", "dist", "target", ".next", ".cache", "__pycache__", ".venv"]) expect(ex.excluded(`${home}/p/${n}`, n, true), n).toBe(true);
    expect(ex.excluded(`${home}/p/src`, "src", true)).toBe(false);
  });
  it("skips ~/Library except iCloud Drive, and Caches anywhere", () => {
    const ex = make();
    expect(ex.excluded(`${home}/Library/Preferences`, "Preferences", true)).toBe(true);
    expect(ex.excluded(`${home}/Library/Mobile Documents`, "Mobile Documents", true)).toBe(false);
    expect(ex.excluded(`${home}/Library/Mobile Documents/com~apple~CloudDocs/a.txt`, "a.txt", false)).toBe(false);
    expect(ex.excluded(`/Volumes/x/Library/Caches`, "Caches", true)).toBe(true);
  });
  it("hides dot-files unless enabled", () => {
    expect(make().excluded(`${home}/.zshrc`, ".zshrc", false)).toBe(true);
    expect(make({ includeHidden: true }).excluded(`${home}/.zshrc`, ".zshrc", false)).toBe(false);
  });
  it("indexes bundles without descending", () => {
    const ex = make();
    expect(ex.excluded("/Applications/Safari.app", "Safari.app", true)).toBe(false);
    for (const n of ["Safari.app", "Photos Library.photoslibrary", "Music Library.musiclibrary", "x.xcarchive"]) expect(ex.descend(n), n).toBe(false);
    expect(ex.descend("Projects")).toBe(true);
  });
  it("matches user globs relative to the scope root (a scope under /private/tmp is not swallowed by **/tmp/**)", () => {
    const ex = make();
    expect(ex.excluded("/private/tmp/scope/report.txt", "report.txt", false)).toBe(false);
    expect(ex.excluded("/private/tmp/scope/a/tmp/x.txt", "x.txt", false)).toBe(true);
    expect(ex.excluded(`${home}/notes.tmp`, "notes.tmp", false)).toBe(true);
  });
  it("supports absolute/~ user paths and blocked (protected) folders", () => {
    const ex = make({ userPatterns: ["~/Archive", "/Volumes/Big"], blocked: protectedFolders(home) });
    expect(ex.excluded(`${home}/Archive/a.zip`, "a.zip", false)).toBe(true);
    expect(ex.excluded(`${home}/Documents`, "Documents", true)).toBe(true);
    expect(ex.excluded(`${home}/Library/Mobile Documents`, "Mobile Documents", true)).toBe(true);
    expect(ex.excluded(`${home}/Music`, "Music", true)).toBe(false);
  });
});
