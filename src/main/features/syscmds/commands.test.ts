import { describe, expect, it } from "vitest";
import { findSysCommand, parseDefaultsBool, READ_FALLBACK, SYS_COMMANDS } from "./commands";

describe("extra system commands", () => {
  it("toggles hidden files from the current Finder setting, then restarts Finder", () => {
    const c = findSysCommand("toggleHiddenFiles")!;
    expect(c.read).toEqual({ cmd: "/usr/bin/defaults", args: ["read", "com.apple.finder", "AppleShowAllFiles"], allowFail: true });
    expect(c.steps(false)).toEqual([
      { cmd: "/usr/bin/defaults", args: ["write", "com.apple.finder", "AppleShowAllFiles", "-bool", "true"] },
      { cmd: "/usr/bin/killall", args: ["Finder"], allowFail: true },
    ]);
    expect(c.steps(true)[0]!.args.at(-1)).toBe("false");
    expect(c.done(false)).toBe("Hidden files are now shown");
  });
  it("toggles desktop icons (missing key means visible)", () => {
    const c = findSysCommand("toggleDesktopIcons")!;
    expect(READ_FALLBACK.toggleDesktopIcons).toBe(true);
    expect(c.steps(true)[0]!.args).toEqual(["write", "com.apple.finder", "CreateDesktop", "-bool", "false"]);
    expect(c.steps(false)[0]!.args.at(-1)).toBe("true");
  });
  it("parses defaults output", () => {
    expect(parseDefaultsBool("1\n", false)).toBe(true);
    expect(parseDefaultsBool("NO", true)).toBe(false);
    expect(parseDefaultsBool("", true)).toBe(true);
    expect(parseDefaultsBool(undefined, false)).toBe(false);
  });
  it("asks before destructive commands and never uses a shell", () => {
    expect(findSysCommand("restartFinder")!.confirm).toBeTruthy();
    expect(findSysCommand("logOut")!.confirm).toBeTruthy();
    expect(findSysCommand("restartDock")!.steps(undefined)).toEqual([{ cmd: "/usr/bin/killall", args: ["Dock"] }]);
    expect(findSysCommand("sleepDisplays")!.steps(undefined)).toEqual([{ cmd: "/usr/bin/pmset", args: ["displaysleepnow"] }]);
    for (const c of SYS_COMMANDS) for (const s of c.steps(false)) expect(s.cmd).toMatch(/^\/usr\/bin\//);
    expect(new Set(SYS_COMMANDS.map((c) => c.id)).size).toBe(SYS_COMMANDS.length);
  });
});
