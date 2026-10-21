/** Test-only fakes: an in-memory "Mac + Glide" behind AgentCapabilities, and a scripted client. */
import type { AgentClient, ContentBlock, TurnRequest, TurnResult } from "./client";
import type { AgentCapabilities, WindowSnapshot } from "./tools";
import type { AppearanceInfo } from "./tools-extra";

export interface FakeWorld {
  calls: string[];
  clipboard: string;
  notes: Map<string, string>;
  snippets: Map<string, { name: string; text: string; keyword?: string }>;
  quicklinks: Map<string, { name: string; url: string }>;
  automations: Map<string, { name: string; trigger: string; target: string }>;
  layouts: Map<string, { name: string }>;
  timers: Set<string>;
  windows: WindowSnapshot["windows"];
  appearance: AppearanceInfo;
  reminders: Map<string, string>;
  killed: number[];
  features: Set<string>;
}

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;

export function fakeCaps(over: Partial<AgentCapabilities> = {}): AgentCapabilities & { calls: string[]; world: FakeWorld } {
  const world: FakeWorld = {
    calls: [],
    clipboard: "secret clipboard text",
    notes: new Map(),
    snippets: new Map(),
    quicklinks: new Map(),
    automations: new Map([["auto1", { name: "Morning", trigger: "At 09:00", target: "Run Standup" }]]),
    layouts: new Map([["lay1", { name: "Coding" }]]),
    timers: new Set(),
    windows: [
      { pid: 10, bundleId: "com.apple.Safari", appName: "Safari", title: "Apple", order: 0, frame: { x: 0, y: 0, width: 800, height: 600 } },
      { pid: 11, bundleId: "com.apple.Notes", appName: "Notes", title: "Notes", order: 0, frame: { x: 100, y: 100, width: 500, height: 400 } },
    ],
    appearance: {
      mode: "system",
      darkTheme: "glide-dark",
      lightTheme: "glide-light",
      presets: [
        { id: "glide-dark", name: "Glide Dark", scheme: "dark" },
        { id: "nord", name: "Nord", scheme: "dark" },
      ],
    },
    reminders: new Map(),
    killed: [],
    features: new Set(["automations", "layouts", "transforms", "browser", "clipboard", "processes", "sysmon", "appearance", "notes", "timers"]),
  };
  const log = (s: string) => world.calls.push(s);
  const caps: AgentCapabilities = {
    now: () => new Date("2026-10-21T09:00:00").getTime(),
    search: async (q) => (log(`search:${q}`), [{ id: "timers:start", title: "Start Timer", kind: "Timer" }]),
    findItem: async (id) => (id === "app:/Applications/Safari.app" ? { id, title: "Safari", kind: "app" } : id === "syscmds:sleep" ? { id, title: "Sleep", kind: "command" } : undefined),
    executeItem: async (id) => (log(`exec:${id}`), { ok: true }),
    listWorkflows: () => [{ id: "wf1", name: "Standup" }],
    runWorkflow: async (id) => (log(`wf:${id}`), { ok: true, result: "ran" }),
    async windowAction(action, app) {
      log(`win:${action}:${app ?? ""}`);
      const w = world.windows.find((x) => x.appName === app) ?? world.windows[0]!;
      w.frame = action === "left-half" ? { x: 0, y: 0, width: 720, height: 900 } : { x: 720, y: 0, width: 720, height: 900 };
      return { ok: true };
    },
    windowSnapshot: async () => ({ windows: world.windows.map((w) => ({ ...w, frame: { ...w.frame } })) }),
    async restoreWindows(snap) {
      log("restore-windows");
      for (const s of snap.windows) {
        const w = world.windows.find((x) => x.pid === s.pid && x.title === s.title);
        if (w) w.frame = { ...s.frame };
      }
      return { ok: true, message: "Windows restored" };
    },
    openUrl: async (u) => (log(`url:${u}`), { ok: true }),
    openApp: async (n) => (log(`app:${n}`), { ok: true }),
    openFile: async (p) => (log(`file:${p}`), { ok: true }),
    clipboardText: async () => world.clipboard,
    copyText: async (t) => (log(`copy:${t}`), (world.clipboard = t), { ok: true }),
    selectedText: async () => ({ text: "selected secret" }),
    async startTimer(ms, name) {
      log(`timer:${ms}:${name}`);
      world.timers.add(nid("t"));
      return { ok: true, message: "Timer started" };
    },
    timerIds: async () => [...world.timers],
    stopTimer: async (id) => (log(`stop-timer:${id}`), world.timers.delete(id), { ok: true }),
    async createNote(t) {
      log(`note:${t}`);
      const id = nid("n");
      world.notes.set(id, t);
      return { ok: true, id };
    },
    deleteNote: async (id) => (log(`delete-note:${id}`), { ok: world.notes.delete(id) }),
    searchNotes: async () => [{ id: "n1", title: "Standup notes" }],
    openNote: async (id) => (log(`open-note:${id}`), { ok: true }),
    convert: async () => [{ title: "3.11 mi" }],
    calendarEvents: async () => ({ ok: true, events: [] }),

    hasFeature: (id) => world.features.has(id),
    listAutomations: async () => [...world.automations].map(([id, a]) => ({ id, name: a.name, enabled: true, trigger: a.trigger, target: a.target })),
    async createAutomation(spec) {
      log(`create-automation:${spec.name}:${spec.trigger.kind}`);
      const id = nid("a");
      world.automations.set(id, { name: spec.name, trigger: spec.trigger.kind, target: JSON.stringify(spec.target) });
      return { ok: true, id };
    },
    deleteAutomation: async (id) => (log(`delete-automation:${id}`), { ok: world.automations.delete(id) }),
    runAutomation: async (id) => (log(`run-automation:${id}`), { ok: world.automations.has(id), message: "Ran", error: "missing" }),
    listLayouts: async () => [...world.layouts].map(([id, l]) => ({ id, name: l.name, summary: "2 windows" })),
    restoreLayout: async (id) => (log(`restore-layout:${id}`), (world.windows[0]!.frame = { x: 5, y: 5, width: 5, height: 5 }), { ok: true }),
    async saveLayout(name) {
      log(`save-layout:${name}`);
      const id = nid("l");
      world.layouts.set(id, { name });
      return { ok: true, id, summary: "2 windows" };
    },
    deleteLayout: async (id) => (log(`delete-layout:${id}`), { ok: world.layouts.delete(id) }),
    listTransforms: () => [
      { id: "upper", title: "UPPERCASE", category: "Case" },
      { id: "reverse", title: "Reverse", category: "Lines" },
    ],
    applyTransform: (id, input) => (id === "upper" ? { ok: true, output: input.toUpperCase() } : id === "reverse" ? { ok: true, output: [...input].reverse().join("") } : { ok: false, error: "nope" }),
    searchBookmarks: async (q) => ({ ok: true, items: q ? [{ title: "Glide Docs", url: "https://glide.example/docs", browser: "Safari" }] : [] }),
    listProcesses: async () => [
      { pid: 500, name: "Chrome Helper", cpu: 80, rssKb: 400_000, user: "me", command: "/Applications/Chrome.app/x" },
      { pid: 88, name: "WindowServer", cpu: 12, rssKb: 200_000, user: "_windowserver", command: "/System/Library/WindowServer" },
    ],
    async checkProcess(pid) {
      if (pid === 500) return { exists: true, name: "Chrome Helper", command: "/Applications/Chrome.app/x", protected: false };
      if (pid === 88) return { exists: true, name: "WindowServer", command: "/System/Library/WindowServer", protected: true, reason: "WindowServer runs your login session" };
      return { exists: false, name: "", command: "", protected: false };
    },
    killProcess: async (pid, force) => (log(`kill:${pid}:${force}`), world.killed.push(pid), { ok: true, message: `Quit ${pid}` }),
    systemStatus: async () => "CPU 12% · Memory 8.0 GB of 16.0 GB used",
    async createReminder(r) {
      log(`reminder:${r.title}:${r.due ?? ""}`);
      const id = nid("r");
      world.reminders.set(id, r.title);
      return { ok: true, id };
    },
    deleteReminder: async (id) => (log(`delete-reminder:${id}`), { ok: world.reminders.delete(id) }),
    clipboardHistory: async () => [{ type: "text", title: "password123", preview: "password123", copiedAt: 1 }],
    async createSnippet(s) {
      log(`snippet:${s.name}`);
      const id = nid("sn");
      world.snippets.set(id, s);
      return { ok: true, id };
    },
    deleteSnippet: async (id) => (log(`delete-snippet:${id}`), { ok: world.snippets.delete(id) }),
    async createQuicklink(q) {
      log(`quicklink:${q.name}`);
      const id = nid("ql");
      world.quicklinks.set(id, q);
      return { ok: true, id };
    },
    deleteQuicklink: async (id) => (log(`delete-quicklink:${id}`), { ok: world.quicklinks.delete(id) }),
    runShortcut: async (name) => (log(`shortcut:${name}`), { ok: true, output: "shortcut output" }),
    appearance: async () => JSON.parse(JSON.stringify(world.appearance)) as AppearanceInfo,
    async setAppearance(p) {
      log(`theme:${p.mode ?? ""}:${p.preset ?? ""}`);
      if (p.preset) world.appearance.darkTheme = p.preset;
      if (p.mode) world.appearance.mode = p.mode;
      return { ok: true };
    },
    async restoreAppearance(prev) {
      log("restore-theme");
      world.appearance = JSON.parse(JSON.stringify(prev)) as AppearanceInfo;
      return { ok: true };
    },
    ...over,
  };
  return Object.assign(caps, { calls: world.calls, world });
}

export type Turn = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }>; stop?: string; thinking?: boolean };

/** Scripted client that records every request it receives; turn i answers request i. */
export function scripted(turns: Array<Turn | Error>): AgentClient & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  return {
    requests,
    async turn(req, onText): Promise<TurnResult> {
      requests.push(JSON.parse(JSON.stringify(req, (k, v) => (k === "tools" ? (v as Array<{ name: string }>).map((t) => t.name) : v))) as TurnRequest);
      const t = turns[requests.length - 1] ?? { text: "done" };
      if (t instanceof Error) throw t;
      const content: ContentBlock[] = [];
      if (t.thinking) content.push({ type: "thinking", thinking: "", signature: "sig-1" } as ContentBlock);
      if (t.text) {
        onText(t.text);
        content.push({ type: "text", text: t.text, citations: null });
      }
      (t.tools ?? []).forEach((c, i) => content.push({ type: "tool_use", id: `tu_${requests.length}_${i}`, name: c.name, input: c.input }));
      return { content, stopReason: t.stop ?? (t.tools?.length ? "tool_use" : "end_turn"), model: "claude-opus-5-5" };
    },
  };
}
