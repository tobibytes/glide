/**
 * Dev-only stand-in for the preload bridge so the renderer runs in a plain
 * browser (`pnpm vite`). Naive filtering, in-memory data, no side effects.
 */
import type { ActionSpec, ItemIcon, MatchRange, Quicklink, ResultSection, RunLogEntry, RunResult, ScoredItem, SearchItem, Settings, Snippet, UserData, Workflow, WorkflowAction } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/types";
import type { AskInputRequest, ExecuteResult, GlideApi, ItemAction, ShowResultPayload } from "@shared/ipc";

const emoji = (value: string): ItemIcon => ({ kind: "emoji", value });

const APP_DEFS: Array<[string, string, string]> = [
  ["Safari", "🧭", "/Applications/Safari.app"],
  ["Mail", "✉️", "/System/Applications/Mail.app"],
  ["Calendar", "📅", "/System/Applications/Calendar.app"],
  ["Notes", "📝", "/System/Applications/Notes.app"],
  ["Terminal", "💻", "/System/Applications/Utilities/Terminal.app"],
  ["Visual Studio Code", "🧑‍💻", "/Applications/Visual Studio Code.app"],
  ["Finder", "🗂️", "/System/Library/CoreServices/Finder.app"],
  ["System Settings", "⚙️", "/System/Applications/System Settings.app"],
  ["Music", "🎵", "/System/Applications/Music.app"],
  ["Photos", "📷", "/System/Applications/Photos.app"],
];
const APPS: SearchItem[] = APP_DEFS.map(([title, icon, path]) => ({ id: `app:${path}`, kind: "app" as const, title, subtitle: "Application", icon: emoji(icon), path, source: "apps" }));

const SYSTEM_DEFS: Array<[string, string, string, string[]]> = [
  ["lockScreen", "Lock Screen", "🔒", ["lock"]],
  ["sleep", "Sleep", "😴", ["suspend"]],
  ["emptyTrash", "Empty Trash", "🗑️", ["bin"]],
  ["toggleDarkMode", "Toggle Dark Mode", "🌗", ["theme", "appearance"]],
  ["showDesktop", "Show Desktop", "🖥️", []],
  ["copyIp", "Copy IP Address", "🌐", ["network"]],
];
const SYSTEM: SearchItem[] = SYSTEM_DEFS.map(([command, title, icon, keywords]) => ({ id: `system:${command}`, kind: "system" as const, title, subtitle: "System Command", icon: emoji(icon), command, keywords, source: "system" }));

const SETTING_DEFS: Array<[string, string, string, string]> = [
  ["general", "Glide Settings", "settings/general", "⚙️"],
  ["createWorkflow", "Create Workflow", "settings/workflows/new", "🧩"],
  ["createQuicklink", "Create Quicklink", "settings/quicklinks/new", "🔗"],
  ["createSnippet", "Create Snippet", "settings/snippets/new", "✂️"],
];
const SETTING_ITEMS: SearchItem[] = SETTING_DEFS.map(([id, title, route, icon]) => ({ id: `setting:${id}`, kind: "setting" as const, title, subtitle: "Glide", icon: emoji(icon), command: route, source: "system" }));

const now = Date.now();
const WORKFLOWS: Workflow[] = [
  {
    id: "wf-morning-setup",
    name: "Morning Setup",
    description: "Open Calendar and Notes, then say hello",
    icon: emoji("☀️"),
    keywords: ["start", "day"],
    hotkey: "Cmd+Shift+M",
    actions: [
      { id: "a1", type: "openApp", params: { app: "/System/Applications/Calendar.app" } },
      { id: "a2", type: "openApp", params: { app: "/System/Applications/Notes.app" } },
      { id: "a3", type: "notify", params: { title: "Good morning", body: "Calendar and Notes are ready. Today is {{date}}." } },
    ],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "wf-search-clipboard",
    name: "Search Clipboard on Google",
    description: "Google whatever is on the clipboard",
    icon: emoji("🔎"),
    alias: "scg",
    actions: [
      { id: "a1", type: "getClipboard", params: {} },
      {
        id: "a2",
        type: "condition",
        params: { left: "{{clipboard}}", operator: "isNotEmpty", right: "" },
        then: [{ id: "a3", type: "openUrl", params: { url: "https://www.google.com/search?q={{clipboard}}" } }],
        else: [{ id: "a4", type: "notify", params: { title: "Clipboard is empty", body: "" } }],
      },
    ],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "wf-quick-note",
    name: "Quick Note",
    description: "Append a line to ~/Desktop/notes.txt",
    icon: emoji("📝"),
    acceptsInput: true,
    actions: [
      { id: "a1", type: "askInput", params: { prompt: "What's on your mind?", placeholder: "Note text" } },
      { id: "a2", type: "runShell", params: { command: 'printf "%s  %s\\n" "{{date}} {{time}}" "{{input}}" >> ~/Desktop/notes.txt', shell: "/bin/zsh" } },
      { id: "a3", type: "showResult", params: { text: "Saved: {{input}}", title: "Note saved" } },
    ],
    createdAt: now,
    updatedAt: now,
  },
];

const QUICKLINKS: Quicklink[] = [
  { id: "ql-google", name: "Google", url: "https://www.google.com/search?q={query}", icon: emoji("🌐"), alias: "g" },
  { id: "ql-github", name: "GitHub", url: "https://github.com/search?q={query}", icon: emoji("🐙") },
  { id: "ql-youtube", name: "YouTube", url: "https://www.youtube.com/results?search_query={query}", icon: emoji("▶️") },
];

const SNIPPETS: Snippet[] = [
  { id: "sn-email-sig", name: "Email signature", text: "Best regards,\n\n— sent from Glide", keyword: "sig" },
  { id: "sn-shrug", name: "Shrug", text: "¯\\_(ツ)_/¯", keyword: "shrug" },
];

const CONDITION_OPERATORS = ["equals", "contains", "startsWith", "matches regex", "isEmpty", "isNotEmpty", ">", "<"];
const SOUNDS = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];
const ACTION_SPECS: ActionSpec[] = [
  { type: "openApp", title: "Open Application", description: "Launch or activate an application", icon: emoji("🚀"), category: "apps", params: [{ key: "app", label: "Application", kind: "app", placeholder: "Safari", required: true }] },
  { type: "openUrl", title: "Open URL", description: "Open a link in the default browser", icon: emoji("🌐"), category: "web", params: [{ key: "url", label: "URL", kind: "url", placeholder: "https://example.com/?q={{input}}", required: true }] },
  {
    type: "runShell",
    title: "Run Shell Script",
    description: "Run a command in your login shell; stdout becomes {{result}}",
    icon: emoji("💻"),
    category: "scripting",
    params: [
      { key: "command", label: "Command", kind: "multiline", placeholder: "echo {{input}}", required: true },
      { key: "shell", label: "Shell", kind: "select", options: ["/bin/zsh", "/bin/bash", "/bin/sh"], default: "/bin/zsh" },
      { key: "continueOnError", label: "Continue on error", kind: "select", options: ["false", "true"], default: "false" },
    ],
    outputVar: "stdout",
  },
  {
    type: "runAppleScript",
    title: "Run AppleScript",
    description: "Run an AppleScript; its return value becomes {{result}}",
    icon: emoji("📜"),
    category: "scripting",
    params: [
      { key: "script", label: "Script", kind: "multiline", placeholder: 'display dialog "{{input}}"', required: true },
      { key: "continueOnError", label: "Continue on error", kind: "select", options: ["false", "true"], default: "false" },
    ],
    outputVar: "scriptResult",
  },
  { type: "typeText", title: "Type Text", description: "Paste text into the frontmost app", icon: emoji("⌨️"), category: "text", params: [{ key: "text", label: "Text", kind: "multiline", placeholder: "Hello {{input}}", required: true }] },
  { type: "setClipboard", title: "Set Clipboard", description: "Copy text to the clipboard", icon: emoji("📋"), category: "clipboard", params: [{ key: "text", label: "Text", kind: "multiline", placeholder: "{{result}}", required: true }] },
  { type: "getClipboard", title: "Get Clipboard", description: "Read the clipboard into {{clipboard}}", icon: emoji("📥"), category: "clipboard", params: [], outputVar: "clipboard" },
  {
    type: "notify",
    title: "Show Notification",
    description: "Post a macOS notification",
    icon: emoji("🔔"),
    category: "system",
    params: [
      { key: "title", label: "Title", kind: "text", placeholder: "Done", required: true },
      { key: "body", label: "Body", kind: "multiline", placeholder: "{{result}}" },
    ],
  },
  { type: "wait", title: "Wait", description: "Pause before the next action", icon: emoji("⏳"), category: "control", params: [{ key: "seconds", label: "Seconds", kind: "number", placeholder: "1", default: "1", required: true }] },
  {
    type: "askInput",
    title: "Ask for Input",
    description: "Prompt in the launcher; the answer becomes {{input}}",
    icon: emoji("❓"),
    category: "control",
    params: [
      { key: "prompt", label: "Prompt", kind: "text", placeholder: "What would you like to do?", required: true },
      { key: "placeholder", label: "Placeholder", kind: "text", placeholder: "Type here…" },
    ],
    outputVar: "input",
  },
  {
    type: "setVariable",
    title: "Set Variable",
    description: "Store a value as {{name}}",
    icon: emoji("🏷️"),
    category: "control",
    params: [
      { key: "name", label: "Name", kind: "text", placeholder: "greeting", required: true },
      { key: "value", label: "Value", kind: "multiline", placeholder: "Hello {{input}}" },
    ],
  },
  {
    type: "condition",
    title: "If",
    description: "Run the Then or Else branch depending on a comparison",
    icon: emoji("🔀"),
    category: "control",
    params: [
      { key: "left", label: "Value", kind: "text", placeholder: "{{input}}", required: true },
      { key: "operator", label: "Operator", kind: "select", options: CONDITION_OPERATORS, default: "equals", required: true },
      { key: "right", label: "Compare to", kind: "text", placeholder: "yes" },
    ],
  },
  {
    type: "httpRequest",
    title: "HTTP Request",
    description: "Fetch a URL; the response body becomes {{response}}",
    icon: emoji("📡"),
    category: "web",
    params: [
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET", required: true },
      { key: "url", label: "URL", kind: "url", placeholder: "https://api.example.com/items", required: true },
      { key: "headers", label: "Headers", kind: "multiline", placeholder: "Content-Type: application/json" },
      { key: "body", label: "Body", kind: "multiline", placeholder: '{"text": "{{input}}"}' },
      { key: "continueOnError", label: "Continue on error", kind: "select", options: ["false", "true"], default: "false" },
    ],
    outputVar: "response",
  },
  {
    type: "runWorkflow",
    title: "Run Workflow",
    description: "Run another workflow and use its result",
    icon: emoji("🧩"),
    category: "control",
    params: [
      { key: "workflowId", label: "Workflow", kind: "text", placeholder: "workflow id", required: true },
      { key: "input", label: "Input", kind: "text", placeholder: "{{result}}" },
    ],
    outputVar: "workflowResult",
  },
  {
    type: "showResult",
    title: "Show Result",
    description: "Display text in the launcher window",
    icon: emoji("🪟"),
    category: "text",
    params: [
      { key: "text", label: "Text", kind: "multiline", placeholder: "{{result}}", required: true },
      { key: "title", label: "Title", kind: "text", placeholder: "Result" },
    ],
  },
  { type: "openFile", title: "Open File", description: "Open a file or folder with its default app", icon: emoji("📂"), category: "apps", params: [{ key: "path", label: "Path", kind: "file", placeholder: "~/Documents/todo.md", required: true }] },
  { type: "playSound", title: "Play Sound", description: "Play a macOS system sound", icon: emoji("🔊"), category: "system", params: [{ key: "name", label: "Sound", kind: "select", options: SOUNDS, default: "Glass", required: true }] },
];

// ---------------------------------------------------------------------------

type Listener<T> = (payload: T) => void;
function emitter<T>() {
  const subs = new Set<Listener<T>>();
  return {
    on: (cb: Listener<T>) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    emit: (payload: T) => subs.forEach((cb) => cb(payload)),
  };
}

/** Tiny recursive-descent arithmetic evaluator (no eval: the renderer CSP forbids it). */
function evalArithmetic(src: string): number | null {
  let i = 0;
  const peek = () => src[i] ?? "";
  const skip = () => {
    while (peek() === " ") i++;
  };
  const number = (): number | null => {
    skip();
    if (peek() === "(") {
      i++;
      const v = expr();
      skip();
      if (peek() !== ")") return null;
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      const v = number();
      return v === null ? null : -v;
    }
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const power = (): number | null => {
    const base = number();
    if (base === null) return null;
    skip();
    if (peek() === "^") {
      i++;
      const e = power();
      return e === null ? null : base ** e;
    }
    return base;
  };
  const term = (): number | null => {
    let v = power();
    if (v === null) return null;
    for (;;) {
      skip();
      const op = peek();
      if (op !== "*" && op !== "/" && op !== "%") return v;
      i++;
      const r = power();
      if (r === null) return null;
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
  };
  const expr = (): number | null => {
    let v = term();
    if (v === null) return null;
    for (;;) {
      skip();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      i++;
      const r = term();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
  };
  const out = expr();
  skip();
  return i === src.length ? out : null;
}

export function createMockGlide(): GlideApi {
  const data: UserData = {
    settings: { ...DEFAULT_SETTINGS },
    workflows: WORKFLOWS.map((w) => ({ ...w })),
    quicklinks: QUICKLINKS.map((q) => ({ ...q })),
    snippets: SNIPPETS.map((s) => ({ ...s })),
    favorites: ["app:/Applications/Safari.app", "workflow:wf-quick-note", "system:lockScreen"],
    aliases: { "app:/System/Applications/Utilities/Terminal.app": "term" },
    hotkeys: { "app:/Applications/Safari.app": "Cmd+Shift+S" },
  };
  const usage = new Map<string, number>([["app:/Applications/Safari.app", 12], ["app:/System/Applications/Notes.app", 5], ["workflow:wf-morning-setup", 3]]);
  const showEv = emitter<void>();
  const dataEv = emitter<UserData>();
  const navEv = emitter<string>();
  const askEv = emitter<AskInputRequest>();
  const resultEv = emitter<ShowResultPayload>();
  const pendingAsk = new Map<string, (v: string | null) => void>();

  const display = (accel: string) =>
    accel
      .split("+")
      .map((p) => ({ cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", space: "Space" })[p.toLowerCase()] ?? p.toUpperCase())
      .join("");

  const catalogue = (): SearchItem[] => {
    const items: SearchItem[] = [
      ...APPS,
      ...SYSTEM,
      ...SETTING_ITEMS,
      ...data.workflows.map<SearchItem>((w) => ({ id: `workflow:${w.id}`, kind: "workflow", title: w.name, subtitle: w.description, icon: w.icon, keywords: w.keywords, workflowId: w.id, alias: w.alias, acceptsArgument: w.acceptsInput, hotkey: w.hotkey ? display(w.hotkey) : undefined, source: "workflows" })),
      ...data.quicklinks.map<SearchItem>((q) => ({ id: `quicklink:${q.id}`, kind: "quicklink", title: q.name, subtitle: q.url, icon: q.icon ?? emoji("🔗"), keywords: q.keywords, url: q.url, alias: q.alias, acceptsArgument: q.url.includes("{query}"), source: "quicklinks" })),
      ...data.snippets.map<SearchItem>((s) => ({ id: `snippet:${s.id}`, kind: "snippet", title: s.name, subtitle: s.text.split("\n")[0], icon: emoji("✂️"), keywords: s.keyword ? [s.keyword] : [], text: s.text, alias: s.alias, source: "snippets" })),
    ];
    return items
      .filter((i) => !data.settings.disabledSources.includes(i.source ?? ""))
      .map((i) => ({ ...i, alias: data.aliases[i.id] ?? i.alias, hotkey: data.hotkeys[i.id] ? display(data.hotkeys[i.id]) : i.hotkey, favorite: data.favorites.includes(i.id) || undefined }));
  };

  const score = (item: SearchItem, q: string): ScoredItem | null => {
    const title = item.title.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const first = words[0] ?? "";
    const frecency = usage.get(item.id) ?? 0;
    const base = { item, frecency, argument: undefined as string | undefined };
    const argOf = (consumedWords: number) => (item.acceptsArgument ? words.slice(consumedWords).join(" ") || undefined : undefined);
    if (item.alias && item.alias.toLowerCase() === first) return { ...base, score: 1000 + frecency, matchScore: 1000, matchKind: "alias", ranges: [], argument: argOf(1) };
    if (title === q) return { ...base, score: 500 + frecency, matchScore: 500, matchKind: "exact", ranges: [{ start: 0, end: q.length }] };
    if (title.startsWith(q)) return { ...base, score: 300 + frecency, matchScore: 300, matchKind: "prefix", ranges: [{ start: 0, end: q.length }] };
    // Title prefix followed by argument text.
    if (item.acceptsArgument && q.startsWith(title + " ")) return { ...base, score: 450 + frecency, matchScore: 450, matchKind: "exact", ranges: [{ start: 0, end: title.length }], argument: q.slice(title.length + 1) || undefined };
    const idx = title.indexOf(first);
    if (first && idx >= 0) return { ...base, score: 150 + frecency, matchScore: 150, matchKind: "word-prefix", ranges: [{ start: idx, end: idx + first.length }], argument: argOf(1) };
    if (item.keywords?.some((k) => k.toLowerCase().startsWith(first))) return { ...base, score: 80 + frecency, matchScore: 80, matchKind: "keyword", ranges: [] };
    // fuzzy: subsequence
    const ranges: MatchRange[] = [];
    let ti = 0;
    for (const ch of first) {
      const at = title.indexOf(ch, ti);
      if (at < 0) return null;
      ranges.push({ start: at, end: at + 1 });
      ti = at + 1;
    }
    if (!first) return null;
    return { ...base, score: 20 + frecency, matchScore: 20, matchKind: "fuzzy", ranges, argument: argOf(1) };
  };

  const tryCalc = (q: string): ScoredItem | null => {
    if (!data.settings.calculator || !/^[\d\s+\-*/().%^]+$/.test(q) || !/\d/.test(q) || !/[+\-*/^%]/.test(q)) return null;
    const v = evalArithmetic(q);
    if (v === null || !Number.isFinite(v)) return null;
    const text = String(Math.round(v * 1e10) / 1e10);
    return { item: { id: "calc:" + q, kind: "calculator", title: `= ${text}`, subtitle: "Press Enter to copy", icon: emoji("🧮"), text }, score: 1000, matchScore: 1000, matchKind: "exact", frecency: 0, ranges: [] };
  };

  const api: GlideApi = {
    platform: "darwin",
    feature: () => Promise.reject(new Error("features are unavailable in the browser mock")),
    onFeatureEvent: () => () => undefined,
    onOpenView: () => () => undefined,
    async search(query) {
      const t0 = performance.now();
      const q = query.trim().toLowerCase();
      const items = catalogue();
      const limit = data.settings.sectionLimit;
      const sections: ResultSection[] = [];
      if (!q) {
        const favs = items.filter((i) => data.favorites.includes(i.id)).map<ScoredItem>((item) => ({ item, score: 0, matchScore: 0, matchKind: "none", frecency: usage.get(item.id) ?? 0, ranges: [] }));
        if (favs.length) sections.push({ id: "favorites", title: "Favorites", items: favs.slice(0, limit) });
        const sugg = items
          .filter((i) => usage.has(i.id) && !data.favorites.includes(i.id))
          .map<ScoredItem>((item) => ({ item, score: usage.get(item.id) ?? 0, matchScore: 0, matchKind: "none", frecency: usage.get(item.id) ?? 0, ranges: [] }))
          .sort((a, b) => b.score - a.score);
        if (sugg.length) sections.push({ id: "suggestions", title: "Suggestions", items: sugg.slice(0, limit) });
      } else {
        const calc = tryCalc(q);
        if (calc) sections.push({ id: "calculator", title: "Calculator", items: [calc] });
        const scored = items.map((i) => score(i, q)).filter((s): s is ScoredItem => !!s).sort((a, b) => b.score - a.score);
        const results = scored.filter((s) => s.item.kind !== "app" && s.item.kind !== "workflow");
        const apps = scored.filter((s) => s.item.kind === "app");
        const wfs = scored.filter((s) => s.item.kind === "workflow");
        if (results.length) sections.push({ id: "results", title: "Results", items: results.slice(0, limit) });
        if (wfs.length) sections.push({ id: "workflows", title: "Workflows", items: wfs.slice(0, limit) });
        if (apps.length) sections.push({ id: "apps", title: "Applications", items: apps.slice(0, limit) });
        if (data.settings.fileSearch && q.length > 3 && !calc) {
          sections.push({ id: "files", title: "Files", items: [{ item: { id: "file:/Users/me/Documents/" + q + ".md", kind: "file", title: `${q}.md`, subtitle: "~/Documents", icon: emoji("📄"), path: `/Users/me/Documents/${q}.md` }, score: 25, matchScore: 25, matchKind: "fuzzy", frecency: 0, ranges: [{ start: 0, end: q.length }] }] });
        }
        if (!scored.length && !calc) {
          sections.push({
            id: "fallbacks",
            title: "Use “" + query.trim() + "” with…",
            items: [
              { item: { id: "fallback:google", kind: "fallback", title: `Search Google for “${query.trim()}”`, icon: emoji("🌐"), url: "https://www.google.com/search?q={query}" }, score: 1, matchScore: 0, matchKind: "none", frecency: 0, ranges: [], argument: query.trim() },
              { item: { id: "fallback:ddg", kind: "fallback", title: `Search DuckDuckGo for “${query.trim()}”`, icon: emoji("🦆"), url: "https://duckduckgo.com/?q={query}" }, score: 1, matchScore: 0, matchKind: "none", frecency: 0, ranges: [], argument: query.trim() },
            ],
          });
        }
      }
      await new Promise((r) => setTimeout(r, 8));
      return { query, sections, total: items.length, tookMs: performance.now() - t0 };
    },
    async execute(item, modifiers) {
      usage.set(item.item.id, (usage.get(item.item.id) ?? 0) + 1);
      const it = item.item;
      if (modifiers?.cmd) return { ok: true, hide: true, message: `Secondary action on ${it.title}` };
      switch (it.kind) {
        case "calculator":
          return { ok: true, hide: true, message: `Copied ${it.text}` };
        case "setting":
          return { ok: true, navigate: it.command };
        case "workflow": {
          const run = await api.runWorkflow(it.workflowId ?? "", item.argument);
          return run.ok ? { ok: true, hide: true, message: `Ran ${it.title}`, run } : { ok: false, error: run.log.find((l) => l.error)?.error ?? "Workflow failed", run };
        }
        case "quicklink":
        case "fallback":
          return { ok: true, hide: true, message: `Open ${(it.url ?? "").replace("{query}", encodeURIComponent(item.argument ?? ""))}` };
        case "snippet":
          return { ok: true, hide: true, message: "Pasted" };
        default:
          return { ok: true, hide: true, message: `Opened ${it.title}` };
      }
    },
    async actionsFor(item) {
      const fav = data.favorites.includes(item.id);
      const A = (id: string, title: string, shortcut?: string, extra: Partial<ItemAction> = {}): ItemAction => ({ id, title, shortcut, ...extra });
      const specific: Record<string, ItemAction[]> = {
        app: [A("open", "Open", "⏎"), A("reveal", "Show in Finder", "⌘⏎"), A("copyPath", "Copy Path", "⇧⌘C")],
        file: [A("open", "Open", "⏎"), A("reveal", "Show in Finder", "⌘⏎"), A("copyPath", "Copy Path", "⇧⌘C")],
        quicklink: [A("open", "Open", "⏎"), A("copyUrl", "Copy URL", "⌘⏎"), A("edit", "Edit Quicklink", "⌘E"), A("delete", "Delete Quicklink", "⌃X", { destructive: true })],
        snippet: [A("paste", "Paste", "⏎"), A("copy", "Copy to Clipboard", "⌘⏎"), A("edit", "Edit Snippet", "⌘E"), A("delete", "Delete Snippet", "⌃X", { destructive: true })],
        system: [A("run", "Run", "⏎")],
        workflow: [A("run", "Run Workflow", "⏎"), A("edit", "Edit Workflow", "⌘E"), A("duplicate", "Duplicate", "⌘D"), A("delete", "Delete Workflow", "⌃X", { destructive: true })],
        calculator: [A("copy", "Copy Result", "⏎")],
        setting: [A("open", "Open", "⏎")],
        fallback: [A("open", "Open", "⏎")],
      };
      const out = [...(specific[item.kind] ?? [])];
      if (item.kind !== "calculator" && item.kind !== "fallback") {
        out.push(A("favorite", fav ? "Remove from Favorites" : "Add to Favorites", "⇧⌘F", { icon: fav ? "💔" : "⭐" }), A("alias", "Set Alias…", undefined, { icon: "🏷️" }), A("hotkey", "Set Hotkey…", undefined, { icon: "⌨️" }));
      }
      return out;
    },
    async runAction(item, actionId): Promise<ExecuteResult> {
      const it = item.item;
      switch (actionId) {
        case "favorite":
          await api.toggleFavorite(it.id);
          return { ok: true, message: it.favorite ? "Removed from Favorites" : "Added to Favorites" };
        case "alias":
          return { ok: true, navigate: `settings/aliases/${encodeURIComponent(it.id)}` };
        case "hotkey":
          return { ok: true, navigate: `settings/hotkeys/${encodeURIComponent(it.id)}` };
        case "edit":
          if (it.kind === "workflow") return { ok: true, navigate: `settings/workflows/${it.workflowId}` };
          if (it.kind === "quicklink") return { ok: true, navigate: `settings/quicklinks/${it.id.replace(/^quicklink:/, "")}` };
          if (it.kind === "snippet") return { ok: true, navigate: `settings/snippets/${it.id.replace(/^snippet:/, "")}` };
          return { ok: false, error: "Nothing to edit" };
        case "delete":
          return { ok: false, error: "Delete is disabled in the browser mock" };
        default:
          return api.execute(item, actionId === "reveal" || actionId === "copyUrl" || actionId === "copy" ? { cmd: true } : undefined);
      }
    },
    async getData() {
      return structuredClone(data);
    },
    async setSettings(patch: Partial<Settings>) {
      Object.assign(data.settings, patch);
      dataEv.emit(structuredClone(data));
      return { ...data.settings };
    },
    async saveWorkflow(wf) {
      const saved: Workflow = { ...wf, id: wf.id || `wf-${Date.now().toString(36)}`, updatedAt: Date.now() };
      const i = data.workflows.findIndex((w) => w.id === saved.id);
      if (i >= 0) data.workflows[i] = saved;
      else data.workflows.push(saved);
      dataEv.emit(structuredClone(data));
      return structuredClone(saved);
    },
    async deleteWorkflow(id) {
      data.workflows = data.workflows.filter((w) => w.id !== id);
      dataEv.emit(structuredClone(data));
    },
    async runWorkflow(id, input): Promise<RunResult> {
      const wf = data.workflows.find((w) => w.id === id);
      if (!wf) throw new Error("Workflow not found");
      const vars: Record<string, string> = { input: input ?? "", clipboard: "mock clipboard", date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString(), result: "" };
      const log: RunLogEntry[] = [];
      let ok = true;
      const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
      const run = async (actions: WorkflowAction[]): Promise<void> => {
        for (const a of actions) {
          const startedAt = Date.now();
          if (a.disabled || !ok) {
            log.push({ actionId: a.id, type: a.type, status: "skipped", startedAt, endedAt: startedAt });
            continue;
          }
          await new Promise((r) => setTimeout(r, 120));
          let output: string | undefined;
          let error: string | undefined;
          switch (a.type) {
            case "askInput": {
              const requestId = `ask-${Date.now()}`;
              const answer = await new Promise<string | null>((resolve) => {
                pendingAsk.set(requestId, resolve);
                showEv.emit();
                askEv.emit({ requestId, prompt: sub(a.params.prompt ?? ""), placeholder: a.params.placeholder });
              });
              if (answer === null) error = "Cancelled";
              else vars.input = output = answer;
              break;
            }
            case "setVariable":
              vars[a.params.name ?? ""] = output = sub(a.params.value ?? "");
              break;
            case "getClipboard":
              output = vars.clipboard;
              break;
            case "runShell":
              output = `(mock) ${sub(a.params.command ?? "")}`;
              vars.stdout = output;
              break;
            case "showResult":
              resultEv.emit({ title: sub(a.params.title ?? ""), text: sub(a.params.text ?? "") });
              output = sub(a.params.text ?? "");
              break;
            case "condition": {
              const left = sub(a.params.left ?? "");
              const right = sub(a.params.right ?? "");
              const op = a.params.operator ?? "equals";
              const truthy = op === "isNotEmpty" ? left !== "" : op === "isEmpty" ? left === "" : op === "contains" ? left.includes(right) : left === right;
              output = truthy ? "then" : "else";
              log.push({ actionId: a.id, type: a.type, status: "ok", startedAt, endedAt: Date.now(), output });
              await run(truthy ? (a.then ?? []) : (a.else ?? []));
              continue;
            }
            case "httpRequest":
              error = "Network calls are disabled in the browser mock";
              break;
            default:
              output = `(mock) ${a.type} ${Object.values(a.params).map(sub).join(" ")}`.trim();
          }
          if (error) {
            ok = a.params.continueOnError === "true";
          } else if (output !== undefined) vars.result = output;
          log.push({ actionId: a.id, type: a.type, status: error ? "error" : "ok", startedAt, endedAt: Date.now(), output, error });
        }
      };
      await run(wf.actions);
      usage.set(`workflow:${id}`, (usage.get(`workflow:${id}`) ?? 0) + 1);
      return { workflowId: id, ok, log, variables: vars, result: vars.result };
    },
    async actionSpecs() {
      return ACTION_SPECS;
    },
    async saveQuicklink(q) {
      const saved = { ...q, id: q.id || `ql-${Date.now().toString(36)}` };
      const i = data.quicklinks.findIndex((x) => x.id === saved.id);
      if (i >= 0) data.quicklinks[i] = saved;
      else data.quicklinks.push(saved);
      dataEv.emit(structuredClone(data));
      return saved;
    },
    async deleteQuicklink(id) {
      data.quicklinks = data.quicklinks.filter((q) => q.id !== id);
      dataEv.emit(structuredClone(data));
    },
    async saveSnippet(s) {
      const saved = { ...s, id: s.id || `sn-${Date.now().toString(36)}` };
      const i = data.snippets.findIndex((x) => x.id === saved.id);
      if (i >= 0) data.snippets[i] = saved;
      else data.snippets.push(saved);
      dataEv.emit(structuredClone(data));
      return saved;
    },
    async deleteSnippet(id) {
      data.snippets = data.snippets.filter((s) => s.id !== id);
      dataEv.emit(structuredClone(data));
    },
    async toggleFavorite(itemId) {
      data.favorites = data.favorites.includes(itemId) ? data.favorites.filter((f) => f !== itemId) : [...data.favorites, itemId];
      dataEv.emit(structuredClone(data));
      return [...data.favorites];
    },
    async setAlias(itemId, alias) {
      if (alias) data.aliases[itemId] = alias;
      else delete data.aliases[itemId];
      dataEv.emit(structuredClone(data));
      return { ...data.aliases };
    },
    async setHotkey(itemId, accel) {
      if (accel) data.hotkeys[itemId] = accel;
      else delete data.hotkeys[itemId];
      dataEv.emit(structuredClone(data));
      return { ...data.hotkeys };
    },
    async listApps() {
      return APPS;
    },
    hide() {
      console.info("[mock] hide window");
      // Simulate the window being shown again shortly after, so the launcher stays usable in the browser.
      setTimeout(() => showEv.emit(), 600);
    },
    resize(height) {
      document.documentElement.style.setProperty("--mock-window-height", `${height}px`);
    },
    openSettings(page) {
      const route = page ? `settings/${page.replace(/^\/?settings\/?/, "")}` : "settings";
      window.open(`${location.pathname}#/${route}`, "_blank");
    },
    onShow: (cb) => showEv.on(() => cb()),
    onDataChanged: (cb) => dataEv.on(cb),
    onNavigate: (cb) => navEv.on(cb),
    onAskInput: (cb) => askEv.on(cb),
    answerInput(requestId, value) {
      pendingAsk.get(requestId)?.(value);
      pendingAsk.delete(requestId);
    },
    onShowResult: (cb) => resultEv.on(cb),
  };
  return api;
}
