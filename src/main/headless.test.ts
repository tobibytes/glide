import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));
const { headlessBlockReason } = await import("./headless");

describe("headlessBlockReason", () => {
  it("blocks commands that act on the user's session", () => {
    expect(headlessBlockReason("/usr/bin/osascript", ["-e", "tell app \"Finder\" to activate"])).toBe("osascript");
    expect(headlessBlockReason("/usr/bin/open", ["-a", "Safari"])).toBe("open");
    expect(headlessBlockReason("screencapture", ["-i", "/tmp/x.png"])).toBe("screencapture");
    expect(headlessBlockReason("afplay", ["/System/Library/Sounds/Glass.aiff"])).toBe("afplay");
    expect(headlessBlockReason("killall", ["Dock"])).toBe("killall");
    expect(headlessBlockReason("defaults", ["write", "com.apple.finder", "AppleShowAllFiles", "-bool", "true"])).toBe("defaults write");
    expect(headlessBlockReason("pmset", ["sleepnow"])).toBe("pmset");
    expect(headlessBlockReason("/bin/zsh", ["-lc", "echo hi; open https://example.com"])).toBe("zsh -c …open…");
  });

  it("allows read-only tools and plain scripts", () => {
    expect(headlessBlockReason("/bin/ps", ["-axo", "pid,comm"])).toBeNull();
    expect(headlessBlockReason("defaults", ["read", "com.apple.finder"])).toBeNull();
    expect(headlessBlockReason("pmset", ["-g", "batt"])).toBeNull();
    expect(headlessBlockReason("/usr/bin/vm_stat")).toBeNull();
    expect(headlessBlockReason("/bin/zsh", ["-lc", "echo opener; cat file"])).toBeNull();
  });
});
