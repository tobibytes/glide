import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileIndexService } from "../service";
import { DEFAULT_FILEINDEX_SETTINGS, type FileIndexSettings } from "../settings";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "glide-fileindex-test-"));
const home = path.join(root, "home");
const dataDir = path.join(root, "data");
const write = (rel: string, text = "x") => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

write("Docs/Quarterly Report.pdf");
write("Docs/meeting-notes.md");
write("proj/.gitignore", "*.log\nbuild-out/\n");
write("proj/debug.log");
write("proj/src/mainWindow.ts");
write("proj/node_modules/leftpad/index.js");
write("proj/build-out/bundle.js");
write("proj/.glideignore", "secret-*\n");
write("proj/secret-plans.txt");
write(".hidden/hiddenfile.txt");
write("Library/Caches/cachefile.txt");
write("Library/Preferences/prefsfile.plist");
write("Library/Mobile Documents/com~apple~CloudDocs/icloudfile.txt");
write("Tools/My.app/Contents/Info.plist");
write("Desktop/deskfile.txt");
write("scratch.tmp");

let settings: FileIndexSettings = { ...DEFAULT_FILEINDEX_SETTINGS, scopes: ["~"], allowProtectedFolders: false };
const make = () => new FileIndexService({ dataDir, home, getSettings: () => settings, watch: false, workerPath: null, compactAfterIdleMs: 3_600_000 });
const names = (svc: FileIndexService, q: string) => (svc.search(q) ?? []).map((h) => h.name);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("FileIndexService (fixture folder)", () => {
  const svc = make();

  it("crawls the scope honouring exclusions and ignore files", async () => {
    await svc.start();
    await svc.whenIdle();
    expect(svc.status().state).toBe("ready");
    expect(names(svc, "quarterly")).toEqual(["Quarterly Report.pdf"]);
    expect(names(svc, "mainwin")).toEqual(["mainWindow.ts"]);
    expect(names(svc, "debug")).toEqual([]); // .gitignore *.log
    expect(names(svc, "bundle")).toEqual([]); // .gitignore build-out/
    expect(names(svc, "leftpad")).toEqual([]); // node_modules
    expect(names(svc, "secret")).toEqual([]); // .glideignore
    expect(names(svc, "hiddenfile")).toEqual([]); // hidden
    expect(names(svc, "cachefile")).toEqual([]); // ~/Library
    expect(names(svc, "prefsfile")).toEqual([]);
    expect(names(svc, "icloudfile")).toEqual([]); // protected (not allowed yet)
    expect(names(svc, "deskfile")).toEqual([]); // protected
    expect(names(svc, "scratch")).toEqual([]); // user exclusion *.tmp
    expect(names(svc, "my")).toContain("My.app");
    expect(names(svc, "info")).toEqual([]); // bundle interior
    expect(fs.existsSync(path.join(dataDir, "index.bin"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, "index.meta.json"), "utf8"));
    expect(meta.version).toBe("glide-fileindex-1");
    expect(meta.generation).toBe(1);
  });

  it("applies incremental changes and journals them", async () => {
    const added = write("Docs/Budget 2025.xlsx");
    write("NewFolder/inner/deepfile.txt");
    fs.rmSync(path.join(home, "Docs/meeting-notes.md"));
    await svc.processPaths([added, path.join(home, "NewFolder"), path.join(home, "Docs/meeting-notes.md"), write("proj/other.log")]);
    expect(names(svc, "budget")).toEqual(["Budget 2025.xlsx"]);
    expect(names(svc, "deepfile")).toEqual(["deepfile.txt"]);
    expect(names(svc, "meeting")).toEqual([]);
    expect(names(svc, "other")).toEqual([]); // still gitignored
    expect(fs.readFileSync(path.join(dataDir, "index.journal"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(4);
  });

  it("boosts files opened from Glide", () => {
    write("Docs/plan-a.txt");
    write("Docs/plan-b.txt");
    return svc.processPaths([path.join(home, "Docs/plan-a.txt"), path.join(home, "Docs/plan-b.txt")]).then(() => {
      svc.recordOpen(path.join(home, "Docs/plan-b.txt"));
      expect(names(svc, "plan")[0]).toBe("plan-b.txt");
    });
  });

  it("reloads index + journal from disk, then compacts", async () => {
    await svc.stop();
    const again = make();
    await again.start();
    expect(again.status().state).toBe("ready");
    expect(again.status().journalOps).toBeGreaterThan(0);
    expect(names(again, "budget")).toEqual(["Budget 2025.xlsx"]);
    expect(names(again, "deepfile")).toEqual(["deepfile.txt"]);
    expect(names(again, "meeting")).toEqual([]);
    await again.compactNow();
    expect(fs.existsSync(path.join(dataDir, "index.journal"))).toBe(false);
    expect(again.status().journalOps).toBe(0);
    expect(names(again, "deepfile")).toEqual(["deepfile.txt"]);
    await again.stop();
    const third = make();
    await third.start();
    expect(names(third, "budget")).toEqual(["Budget 2025.xlsx"]);
    expect(names(third, "meeting")).toEqual([]);
    expect(names(third, "plan")[0]).toBe("plan-b.txt"); // opened.json persisted
    await third.stop();
  });

  it("re-crawls when crawl settings change (protected folders opt-in)", async () => {
    settings = { ...settings, allowProtectedFolders: true };
    const svc2 = make();
    await svc2.start();
    await svc2.whenIdle();
    expect(names(svc2, "deskfile")).toEqual(["deskfile.txt"]);
    expect(names(svc2, "icloudfile")).toEqual(["icloudfile.txt"]);
    expect(svc2.status().generation).toBe(2);
    await svc2.stop();
  });
});

describe("FSEvents watcher", () => {
  it("picks up a created and a deleted file within the debounce window", async () => {
    const svc = new FileIndexService({ dataDir, home, getSettings: () => settings, watch: true, workerPath: null, compactAfterIdleMs: 3_600_000 });
    await svc.start();
    await svc.whenIdle();
    expect(svc.status().watching).toBe(true);
    const p = write("Docs/watched-file.txt");
    // FSEvents latency grows a lot when the whole suite runs in parallel; allow generous time.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !names(svc, "watched").length) await new Promise((r) => setTimeout(r, 100));
    expect(names(svc, "watched")).toEqual(["watched-file.txt"]);
    fs.rmSync(p);
    const deadline2 = Date.now() + 15_000;
    while (Date.now() < deadline2 && names(svc, "watched").length) await new Promise((r) => setTimeout(r, 100));
    expect(names(svc, "watched")).toEqual([]);
    await svc.stop();
  }, 40_000);
});
