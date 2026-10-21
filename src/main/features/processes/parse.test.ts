import { describe, expect, it } from "vitest";
import { formatKb, killRisk, parseLsof, parsePortQuery, parsePs, processName, sortByCpu } from "./parse";

const PS = `    1     0   0.3  20048 root             /sbin/launchd
  339     1   0.1  24240 root             /usr/libexec/logd
  402     1  12.5 812345 _windowserver    /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
  934     1   0.0  20112 alice            /Applications/Ice.app/Contents/MacOS/Ice
 1200   934  45,2 302400 alice            /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
 1300     1   3.0   1024 alice            /Applications/Visual Studio Code.app/Contents/MacOS/Electron
    0     0   9.0      0 root             kernel_task
garbage line`;

describe("parsePs", () => {
  const list = parsePs(PS);
  it("parses every well-formed row, including commands with spaces and comma decimals", () => {
    expect(list).toHaveLength(7);
    const chrome = list.find((p) => p.pid === 1200)!;
    expect(chrome.cpu).toBeCloseTo(45.2);
    expect(chrome.ppid).toBe(934);
    expect(chrome.name).toBe("Google Chrome Helper (Renderer)");
    expect(chrome.appPath).toBe("/Applications/Google Chrome.app");
  });
  it("names the bundle's main executable after the app", () => {
    expect(list.find((p) => p.pid === 934)!.name).toBe("Ice");
    expect(list.find((p) => p.pid === 1300)!.name).toBe("Visual Studio Code");
    expect(processName("/usr/libexec/logd")).toBe("logd");
  });
  it("sorts by CPU", () => {
    expect(sortByCpu(list).map((p) => p.pid).slice(0, 3)).toEqual([1200, 402, 0]);
  });
});

const LSOF = `COMMAND     PID             USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      51234 alice   23u  IPv6 0x4e508c40ed23b1a7      0t0  TCP *:3000 (LISTEN)
node      51234 alice   24u  IPv4 0xb6f1720c1a2221      0t0  TCP *:3000 (LISTEN)
Python    777 alice    5u  IPv4 0x9b5b138c27f2a529      0t0  TCP 127.0.0.1:3000 (LISTEN)
rapportd  651 alice   14u  IPv6 0x4e508c40ed23b1a8      0t0  TCP [::1]:49152 (LISTEN)
`;

describe("parseLsof", () => {
  it("merges the IPv4/IPv6 sockets of one pid and keeps addresses", () => {
    const l = parseLsof(LSOF);
    expect(l.map((x) => [x.command, x.pid, x.port])).toEqual([
      ["node", 51234, 3000],
      ["Python", 777, 3000],
      ["rapportd", 651, 49152],
    ]);
    expect(l[1]!.address).toBe("127.0.0.1:3000");
    expect(l[2]!.address).toBe("[::1]:49152");
  });
  it("returns nothing for empty output (lsof exits 1)", () => expect(parseLsof("")).toEqual([]));
});

describe("parsePortQuery", () => {
  it.each([
    ["port 3000", 3000],
    ["kill port 8080", 8080],
    [":5173", 5173],
    ["port:22", 22],
    ["Port   443 ", 443],
  ])("%s", (q, n) => expect(parsePortQuery(q)).toBe(n));
  it.each(["port", "port 0", "port 70000", "portal 3000", "3000"])("rejects %s", (q) => expect(parsePortQuery(q)).toBeUndefined());
});

describe("killRisk", () => {
  const self = [4242, 4243];
  it("warns for launchd, kernel_task, WindowServer, loginwindow and Glide itself", () => {
    expect(killRisk({ pid: 1, name: "launchd", command: "/sbin/launchd" }, self).level).toBe("warn");
    expect(killRisk({ pid: 0, name: "kernel_task", command: "kernel_task" }, self).level).toBe("warn");
    expect(killRisk({ pid: 402, name: "WindowServer", command: "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer" }, self).level).toBe("warn");
    expect(killRisk({ pid: 500, name: "loginwindow", command: "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow" }, self).level).toBe("warn");
    expect(killRisk({ pid: 4243, name: "Electron", command: "/x/Electron" }, self).level).toBe("warn");
  });
  it("allows ordinary processes", () => expect(killRisk({ pid: 9000, name: "sleep", command: "/bin/sleep" }, self).level).toBe("ok"));
});

it("formatKb", () => {
  expect(formatKb(512)).toBe("512 KB");
  expect(formatKb(20112)).toBe("19.6 MB");
  expect(formatKb(3 * 1024 * 1024)).toBe("3.0 GB");
});
