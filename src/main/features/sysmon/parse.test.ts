import { describe, expect, it } from "vitest";
import { cpuDeltas, formatBytes, formatUptime, isSysmonQuery, parseDf, parseNetstat, parsePmset, parseVmStat } from "./parse";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     7863.
Pages active:                                 342423.
Pages inactive:                               333090.
Pages speculative:                              8550.
Pages throttled:                                   0.
Pages wired down:                             236734.
Pages purgeable:                                 259.
"Translation faults":                     1289252665.
Pages copy-on-write:                        47605481.
File-backed pages:                            249133.
Anonymous pages:                              434930.
Pages stored in compressor:                  2458166.
Pages occupied by compressor:                 601551.
Swapouts:                                    3198445.`;

describe("parseVmStat", () => {
  it("computes Activity-Monitor style used memory", () => {
    const total = 25769803776;
    const m = parseVmStat(VM_STAT, total)!;
    const page = 16384;
    expect(m.appBytes).toBe((434930 - 259) * page);
    expect(m.wiredBytes).toBe(236734 * page);
    expect(m.compressedBytes).toBe(601551 * page);
    expect(m.usedBytes).toBe(m.appBytes + m.wiredBytes + m.compressedBytes);
    expect(m.freeBytes).toBe(total - m.usedBytes);
    expect(m.usedBytes / total).toBeGreaterThan(0.5);
  });
  it("rejects garbage", () => expect(parseVmStat("nope", 1)).toBeUndefined());
});

describe("parsePmset", () => {
  it("parses a discharging battery", () => {
    const b = parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23134307)\t99%; discharging; 9:29 remaining present: true\n");
    expect(b).toEqual({ percent: 99, state: "discharging", source: "Battery", remainingMin: 569 });
  });
  it("parses charging on AC without an estimate", () => {
    const b = parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t42%; charging; (no estimate) present: true\n");
    expect(b).toEqual({ percent: 42, state: "charging", source: "AC" });
  });
  it("parses charged", () => {
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true")?.state).toBe("charged");
  });
  it("returns undefined on a desktop Mac", () => expect(parsePmset("Now drawing from 'AC Power'\n")).toBeUndefined());
});

const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                        452894     0 1635084689   452894     0 1635084689     0
lo0        16384 127           localhost         452894     - 1635084689   452894     - 1635084689     -
gif0*      1280  <Link#2>                             0     0          0        0     0          0     0
en0        1500  <Link#11>   a4:fc:14:00:00:01 9000000     0 8000000000  4000000     0  600000000     0
en0        1500  fe80::1%en0 fe80:b::1         9000000     - 8000000000  4000000     -  600000000     -
utun3      1380  <Link#20>                          100     0      50000      120     0      60000     0`;

describe("parseNetstat", () => {
  it("sums link rows and skips loopback and duplicate address rows", () => {
    expect(parseNetstat(NETSTAT)).toEqual({ rxBytes: 8000050000, txBytes: 600060000 });
  });
});

describe("parseDf", () => {
  it("reports used as total - available (APFS)", () => {
    const d = parseDf(`Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1   482766932  12455504 110534672    11%  458788 1105346720    0%   /`)!;
    expect(d.totalBytes).toBe(482766932 * 1024);
    expect(d.availableBytes).toBe(110534672 * 1024);
    expect(d.usedBytes).toBe((482766932 - 110534672) * 1024);
    expect(d.mount).toBe("/");
  });
  it("handles empty output", () => expect(parseDf("")).toBeUndefined());
});

describe("cpuDeltas", () => {
  it("computes busy fraction per core", () => {
    const a = [{ user: 100, nice: 0, sys: 50, idle: 850, irq: 0 }, { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 }];
    const b = [{ user: 150, nice: 0, sys: 100, idle: 900, irq: 0 }, { user: 0, nice: 0, sys: 0, idle: 1100, irq: 0 }];
    expect(cpuDeltas(a, b)).toEqual([2 / 3, 0]);
    expect(cpuDeltas([], b)).toEqual([0, 0]);
  });
});

it("formatters", () => {
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(25769803776)).toBe("24.0 GB");
  expect(formatUptime(3 * 86400 + 4 * 3600 + 60)).toBe("3d 4h");
  expect(formatUptime(3700)).toBe("1h 1m");
});

it("isSysmonQuery", () => {
  for (const q of ["cpu", "memory", "mem", "battery", "batt", "system", "system monitor", "ram"]) expect(isSysmonQuery(q)).toBe(true);
  for (const q of ["c", "chrome", "notes", "sy"]) expect(isSysmonQuery(q)).toBe(false);
});
