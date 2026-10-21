// Deterministic fixture data for an isolated GLIDE_USER_DATA directory.
// Everything is written in the app's own on-disk formats before launch, so suites never
// depend on the user's apps, files, clipboard, calendar or network.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Seeded PRNG (LCG) so generated catalogues are identical on every run. */
export function rng(seed = 42) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const WORDS = [
  "Visual", "Studio", "Code", "Safari", "Terminal", "Finder", "Notes", "Music", "Photos", "Mail", "Calendar",
  "Slack", "Discord", "Figma", "Sketch", "Xcode", "Preview", "Numbers", "Pages", "Keynote", "Activity", "Monitor",
  "Disk", "Utility", "Script", "Editor", "Console", "Automator", "Shortcuts", "System", "Settings", "Lock", "Screen",
  "Empty", "Trash", "Sleep", "Restart", "Search", "Google", "GitHub", "Pull", "Request", "Deploy", "Build", "Clipboard",
  "Report", "Invoice", "Budget", "Roadmap", "Design", "Review", "Standup", "Retro", "Backlog", "Sprint", "Release",
];

/** `n` synthetic quicklinks (they become catalogue items via the core quicklink source). */
export function syntheticQuicklinks(n, seed = 7) {
  const rnd = rng(seed);
  const pick = () => WORDS[Math.floor(rnd() * WORDS.length)];
  return Array.from({ length: n }, (_, i) => {
    const words = 1 + Math.floor(rnd() * 3);
    const name = `${Array.from({ length: words }, pick).join(" ")} ${i}`;
    return {
      id: `fx-ql-${i}`,
      name,
      url: `https://example.invalid/${i}?q={query}`,
      icon: { kind: "emoji", value: "🔗" },
      keywords: rnd() < 0.5 ? [pick().toLowerCase(), pick().toLowerCase()] : undefined,
      alias: rnd() < 0.03 ? `${pick().slice(0, 2).toLowerCase()}${i}` : undefined,
    };
  });
}

/** Queries used by the perf suite (prefixes, acronyms, multi-word, misses). */
export function perfQueries(count = 200, seed = 99) {
  const rnd = rng(seed);
  const base = ["v", "vs", "vsc", "code", "saf", "term", "fin", "notes", "cal", "sl", "fig", "xc", "prev", "key", "act", "disk", "scr", "con", "auto", "sys", "set", "lock", "trash", "goo", "gh", "pr", "dep", "build", "clip", "visual studio", "google 42", "zzzz", "report 12", "budget", "road", "rel", "spr", "rev", "inv", "st"];
  const out = [];
  for (let i = 0; i < count; i++) {
    const b = base[i % base.length];
    out.push(rnd() < 0.25 ? `${b}${WORDS[Math.floor(rnd() * WORDS.length)].slice(0, 2).toLowerCase()}` : b);
  }
  return out;
}

function plist(name, bundleId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;
}

const FIXTURE_APPS = ["Fixture Notes", "Fixture Browser", "Fixture Terminal", "Fixture Mail", "Fixture Music", "Safari"];

const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

/**
 * Populate `dir` (a fresh GLIDE_USER_DATA) with deterministic data.
 * @param {string} dir
 * @param {{ now?: number, theme?: "dark"|"light"|"system", darkTheme?: string, lightTheme?: string,
 *   catalogueSize?: number, clipboard?: boolean, colors?: boolean, timers?: boolean,
 *   settings?: object, features?: Record<string, object> }} [opts]
 */
export function seedDataDir(dir, opts = {}) {
  const now = opts.now ?? Date.now();
  const appsDir = path.join(dir, "fixture", "Applications");
  const filesDir = path.join(dir, "fixture", "files");
  for (const name of FIXTURE_APPS) {
    write(path.join(appsDir, `${name}.app`, "Contents", "Info.plist"), plist(name, `dev.glide.fixture.${name.replace(/\W/g, "").toLowerCase()}`));
  }
  // Fake HOME (see launchGlide). Its path must not contain words the suites search for.
  mkdirSync(path.join(dir, "home", "Library"), { recursive: true });
  for (const f of ["Quarterly Report.pdf", "notes.md", "budget.csv", "design/mockup.png", "src/index.ts"]) write(path.join(filesDir, f), `fixture ${f}\n`);

  const features = {
    // Index only the fixture folder; never crawl the user's home in a test.
    fileindex: { scopes: [filesDir], showInRootSearch: false, allowProtectedFolders: false },
    app: { autoCheck: false, updateFeed: "" },
    convert: { currencyNetwork: false },
    appearance: { darkTheme: opts.darkTheme ?? "glide-dark", lightTheme: opts.lightTheme ?? "glide-light" },
    timers: { showInMenuBar: false, sound: "none" },
    ...(opts.features ?? {}),
  };
  const quicklinks = [
    { id: "ql-google", name: "Google", url: "https://www.google.com/search?q={query}", icon: { kind: "emoji", value: "🌐" }, alias: "g" },
    { id: "ql-github", name: "GitHub", url: "https://github.com/search?q={query}", icon: { kind: "emoji", value: "🐙" } },
    ...(opts.catalogueSize ? syntheticQuicklinks(opts.catalogueSize) : []),
  ];
  const t0 = now - 3 * DAY;
  write(path.join(dir, "data.json"), {
    settings: {
      theme: opts.theme ?? "dark",
      appDirectories: [appsDir],
      fileSearch: false,
      hideOnBlur: false,
      ...(opts.settings ?? {}),
      features,
    },
    workflows: [
      {
        id: "wf-morning-setup", name: "Morning Setup", description: "Open Calendar and Notes, then say hello",
        icon: { kind: "emoji", value: "☀️" }, keywords: ["start", "day"],
        actions: [
          { id: "a1", type: "openApp", params: { app: "Calendar" } },
          { id: "a2", type: "notify", params: { title: "Good morning", body: "Today is {{date}}." } },
        ],
        createdAt: t0, updatedAt: t0,
      },
      {
        id: "wf-fixture-greet", name: "Fixture Greeting", description: "Set a variable from input", icon: { kind: "emoji", value: "👋" },
        acceptsInput: true, actions: [{ id: "a1", type: "setVariable", params: { name: "greeting", value: "Hello {{input}}" } }],
        createdAt: t0, updatedAt: t0,
      },
    ],
    quicklinks,
    snippets: [
      { id: "sn-email-sig", name: "Email signature", text: "Best regards,\n\n— sent from Glide", keyword: "sig" },
      { id: "sn-shrug", name: "Shrug", text: "¯\\_(ツ)_/¯", keyword: "shrug" },
    ],
    favorites: [],
    aliases: {},
    hotkeys: {},
  });
  write(path.join(dir, "usage.json"), []);

  const fdir = (id) => path.join(dir, "features", id);
  if (opts.clipboard !== false) {
    const clip = (i, type, text, ago, extra = {}) => ({
      id: `fx-clip-${i}`, type, key: `${type[0]}:${text}`, text, source: { name: "Fixture Notes", bundleId: "dev.glide.fixture.fixturenotes" },
      createdAt: now - ago, lastCopiedAt: now - ago, count: 1, pinned: false, ...extra,
    });
    write(path.join(fdir("clipboard"), "history.json"), {
      version: 1,
      entries: [
        clip(1, "text", "The quick brown fox jumps over the lazy dog", 2 * DAY, { pinned: true }),
        clip(2, "link", "https://example.com/docs/getting-started", 3 * DAY),
        clip(3, "color", "#3b82f6", 4 * DAY),
        clip(4, "text", "const answer = 42;\nconsole.log(answer);", 5 * DAY),
        clip(5, "text", "Meeting notes: ship the quality harness", 6 * DAY, { count: 3 }),
      ],
    });
  }
  if (opts.colors !== false) {
    const color = (hex, r, g, b, ago) => ({ hex, rgba: { r, g, b, a: 1 }, at: now - ago, source: "search" });
    write(path.join(fdir("color"), "history.json"), [
      color("#F5A524", 245, 165, 36, 2 * DAY),
      color("#3B82F6", 59, 130, 246, 3 * DAY),
      color("#10B981", 16, 185, 129, 4 * DAY),
      color("#EF4444", 239, 68, 68, 5 * DAY),
    ]);
  }
  if (opts.timers !== false) {
    // Paused timers/stopwatches render a fixed remaining/elapsed time.
    write(path.join(fdir("timers"), "timers.json"), {
      timers: [
        { id: "fx-timer-1", name: "Tea", durationMs: 3 * MIN, startedAt: now - 2 * MIN, pausedAt: now - MIN, pausedMs: 0 },
        { id: "fx-timer-2", name: "Pomodoro", durationMs: 25 * MIN, startedAt: now - 10 * MIN, pausedAt: now - 5 * MIN, pausedMs: 0 },
      ],
      stopwatches: [{ id: "fx-sw-1", name: "Focus", startedAt: now - 30 * MIN, pausedAt: now - 20 * MIN, pausedMs: 0, laps: [5 * MIN] }],
    });
  }
  return { appsDir, filesDir, now };
}
