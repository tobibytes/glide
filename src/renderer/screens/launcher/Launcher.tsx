import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { ViewProps } from "../../features/types";
import type { AskInputRequest, ExecuteModifiers, ExecuteResult, ItemAction, ShowResultPayload, ViewRequest } from "@shared/ipc";
import type { ScoredItem, SearchResponse, SectionId, Settings } from "@shared/types";
import { glide } from "../../lib/glide";
import { eventMatchesShortcut } from "../../lib/keys";
import { kindLabel } from "../../lib/icons";
import { findActionOfKind, INITIAL_VIM_STATE, modeAfter, toVimKey, VimContext, vimKey, type VimCommand, type VimInfo, type VimMode } from "../../lib/vim";
import { NavHostContext, type NavController, type NavFooter, type NavHost } from "../../lib/navHost";
import { FEATURE_UIS, resolveView } from "../../features/registry";
import { useResizeReporter } from "../../hooks/useResizeReporter";
import { useQueryHistory } from "../../hooks/useQueryHistory";
import { useTheme } from "../../hooks/useTheme";
import { halfPageOf, useListNav } from "../../hooks/useListNav";
import { Toast, useToast } from "../../components/Toast";
import { Icon } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { ActionPanel } from "../../components/ActionPanel";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ResultRow } from "./ResultRow";
import "../settings/coreViews"; // registers the quicklinks.* and snippets.* launcher views
import { ArgFields, argPlaceholder, initMultiArg, multiArgKey, multiArgValues, needsArgEntry, type MultiArg } from "./quicklinkArgs";
import { PromptCard, ResultCard } from "./Cards";
import { ViewHost, viewTitle, type LauncherApi, type ViewEntry } from "./ViewHost";
import { TabChooser } from "./TabChooser";
import { initialChoiceIndex, loadTabChoice, saveTabChoice, type TabChoice } from "./tabChoice";
import { isWeak, type Suggestion } from "@shared/did-you-mean";
import "./launcher-extra.css";

const POP_TO_ROOT_MS = 90_000;
const DELETE_CONFIRM_MS = 3000;
const QUICK_AI_VIEW = "ai.chat";
const AGENT_VIEW = "agent.run";
/** Section cap requested by "show more". */
const EXPANDED_LIMIT = 100;
/** Same key as hooks/useQueryHistory (read-only here, for the "↑ Recent" hint). */
const HISTORY_KEY = "glide:query-history";
const DYM_GROUP = "dym";

type HeaderRow = { kind: "header"; key: string; sectionId: SectionId; group: string; title: string; count: number; more: boolean; dym?: string };
type Row = HeaderRow | { kind: "item"; key: string; sectionId: SectionId; group: string; scored: ScoredItem; n: number };
type ItemRow = Extract<Row, { kind: "item" }>;

interface Expanded {
  query: string;
  sections: Partial<Record<SectionId, ScoredItem[]>>;
}

interface ArgMode {
  scored: ScoredItem;
  text: string;
  /** Quicklinks with several named arguments: Tab steps through them (./quicklinkArgs). */
  multi?: MultiArg;
}

function GlideGlyph() {
  return (
    <svg className="launcher__glyph" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M3 15.5C3 10.8 6.8 7 11.5 7h4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12.5 3.5 16 7l-3.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4" cy="17" r="2" fill="currentColor" />
    </svg>
  );
}

/** Per-section cap the engine applies (results get twice the user's limit). */
const capOf = (id: SectionId, limit: number) => (id === "results" ? limit * 2 : limit);

function buildRows(res: SearchResponse | null, expanded: Expanded | null, suggestion: Suggestion | null, limit: number): Row[] {
  if (!res) return [];
  const rows: Row[] = [];
  let n = 0;
  const ex = expanded && expanded.query === res.query ? expanded.sections : {};
  const pushSuggestion = () => {
    if (!suggestion) return;
    rows.push({ kind: "header", key: `h:${DYM_GROUP}`, sectionId: "results", group: DYM_GROUP, title: "Did you mean", count: suggestion.items.length, more: false, dym: suggestion.query });
    for (const it of suggestion.items) rows.push({ kind: "item", key: `${DYM_GROUP}:${it.item.id}`, sectionId: "results", group: DYM_GROUP, scored: it, n: ++n });
  };
  // Only offered when the real results are weak (loose fuzzy hits or none), so it leads.
  pushSuggestion();
  for (const s of res.sections) {
    const items = ex[s.id] ?? s.items;
    if (!items.length) continue;
    const more = !ex[s.id] && s.id !== "calculator" && s.id !== "fallbacks" && items.length >= capOf(s.id, limit);
    rows.push({ kind: "header", key: `h:${s.id}`, sectionId: s.id, group: s.id, title: s.title, count: items.length, more });
    for (const it of items) rows.push({ kind: "item", key: `${s.id}:${it.item.id}`, sectionId: s.id, group: s.id, scored: it, n: ++n });
  }
  return rows;
}

function historyCount(): number {
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

declare global {
  interface Window {
    __glideLauncher?: { openView(view: ViewRequest): boolean; views(): string[] };
  }
}

const isEditable = (el: HTMLElement) => el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
const sameFooter = (a: NavFooter | null, b: NavFooter | null) => a === b || (!!a && !!b && a.primary === b.primary && a.hasActions === b.hasActions);

export function Launcher({ theme, vimMode = true }: { theme: Settings["theme"] | undefined; vimMode?: boolean }) {
  useTheme(theme);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const viewSeq = useRef(0);
  const lastActivity = useRef(Date.now());
  const actionCache = useRef(new Map<string, ItemAction[]>());
  const vimState = useRef(INITIAL_VIM_STATE);
  const deleteArm = useRef<{ title: string; at: number } | null>(null);
  const viewCtl = useRef<NavController | null>(null);
  const history = useQueryHistory();
  const { toast, show: showToastRaw } = useToast();
  const showToastRef = useRef(showToastRaw);
  showToastRef.current = showToastRaw;
  const showToast = useCallback((text: string, kind: "info" | "error" = "info") => showToastRef.current(text, kind), []);

  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [argMode, setArgMode] = useState<ArgMode | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelActions, setPanelActions] = useState<ItemAction[]>([]);
  const [prompt, setPrompt] = useState<AskInputRequest | null>(null);
  const [resultCard, setResultCard] = useState<ShowResultPayload | null>(null);
  const [primaryTitle, setPrimaryTitle] = useState<string>("Open");
  const [stack, setStack] = useState<ViewEntry[]>([]);
  const [viewFooter, setViewFooter] = useState<NavFooter | null>(null);
  const [rawMode, setRawMode] = useState<VimMode>("insert");
  const [tabChooser, setTabChooser] = useState<{ options: TabChoice[]; index: number } | null>(null);
  const [sectionLimit, setSectionLimit] = useState(8);
  const [expanded, setExpanded] = useState<Expanded | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion & { for: string } | null>(null);
  const mode: VimMode = vimMode ? rawMode : "insert";
  const normal = mode === "normal";
  const top = stack.length ? stack[stack.length - 1] : null;

  useResizeReporter(panelRef);

  const queryRef = useRef(query);
  queryRef.current = query;

  // --- rows & selection (selection is derived during render: never a frame without a selected row) ---
  const rows = useMemo<Row[]>(
    () =>
      argMode
        ? [
            { kind: "header", key: "h:arg", sectionId: "results", group: "arg", title: "Argument", count: 1, more: false },
            { kind: "item", key: "arg", sectionId: "results", group: "arg", scored: argMode.scored, n: 1 },
          ]
        : buildRows(response, expanded, suggestion && response && suggestion.for === response.query ? suggestion : null, sectionLimit),
    [response, argMode, expanded, suggestion, sectionLimit],
  );
  const itemRows = useMemo(() => rows.filter((r): r is ItemRow => r.kind === "item"), [rows]);
  const rowKeys = useMemo(() => itemRows.map((r) => r.key), [itemRows]);
  const rowSections = useMemo(() => itemRows.map((r) => r.group), [itemRows]);
  const halfPage = useCallback(() => halfPageOf(listRef.current), []);
  const rootNav = useListNav(rowKeys, { sections: rowSections, halfPage });
  const selectedRow = rootNav.index >= 0 ? itemRows[rootNav.index] : null;
  const selected = selectedRow?.scored ?? null;
  const selectKey = rootNav.select;

  // --- search ---------------------------------------------------------------
  const runSearch = useCallback(
    async (q: string, opts: { preserveSelection?: boolean } = {}) => {
      const s = ++seq.current;
      setLoading(true);
      try {
        const res = await glide().search(q);
        if (s !== seq.current) return; // a newer keystroke won
        setResponse(res);
        if (!opts.preserveSelection) {
          selectKey(null);
          setExpanded(null);
        }
        // "Did you mean": only for queries with no real results (one cheap engine pass in main).
        if (q.trim().length >= 3 && isWeak(res)) {
          void glide()
            .feature<Suggestion | null>("glide", "didYouMean", q)
            .then((sug) => {
              if (s === seq.current) setSuggestion(sug && sug.items.length ? { ...sug, for: res.query } : null);
            })
            .catch(() => undefined);
        } else setSuggestion(null);
      } catch (err) {
        if (s === seq.current) showToast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        if (s === seq.current) setLoading(false);
      }
    },
    [selectKey, showToast],
  );

  useEffect(() => {
    if (!rootNav.selectedKey) return;
    document.getElementById(`row-${rootNav.selectedKey}`)?.scrollIntoView({ block: "nearest" });
  }, [rootNav.selectedKey]);

  // Fetch actions for the selected item (cached) so shortcuts and the footer label work without opening the panel.
  const actionsFor = useCallback(async (scored: ScoredItem): Promise<ItemAction[]> => {
    const cached = actionCache.current.get(scored.item.id);
    if (cached) return cached;
    const list = await glide().actionsFor(scored.item);
    actionCache.current.set(scored.item.id, list);
    return list;
  }, []);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    void actionsFor(selected)
      .then((list) => {
        if (alive) setPrimaryTitle(list[0]?.title ?? "Open");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selected, actionsFor]);

  // --- window lifecycle -------------------------------------------------------
  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  const hideWindow = useCallback(() => {
    lastActivity.current = Date.now();
    setPanelOpen(false);
    glide().hide();
  }, []);

  // --- view stack -------------------------------------------------------------
  const pushView = useCallback(
    (req: ViewRequest, opts: { titleHint?: string; replace?: boolean } = {}) => {
      if (!resolveView(req.id)) {
        showToast("This feature isn't available yet", "error");
        return false;
      }
      const entry: ViewEntry = { key: ++viewSeq.current, id: req.id, props: req.props ?? {}, query: "", placeholder: "Search…", title: viewTitle(req, opts.titleHint) };
      setStack((s) => (opts.replace ? [entry] : [...s, entry]));
      setArgMode(null);
      setPanelOpen(false);
      setTabChooser(null);
      setViewFooter(null);
      // A new view starts in INSERT so its search field is typeable.
      vimState.current = INITIAL_VIM_STATE;
      setRawMode((m) => modeAfter(m, { type: "push" }));
      requestAnimationFrame(focusInput);
      return true;
    },
    [focusInput, showToast],
  );

  const popView = useCallback(() => {
    setStack((s) => s.slice(0, -1));
    setViewFooter(null);
    // Popping (⌫ on empty, h, ⎋) must never leave the field read-only in NORMAL mode.
    vimState.current = INITIAL_VIM_STATE;
    setRawMode((m) => modeAfter(m, { type: "pop" }));
    requestAnimationFrame(focusInput);
  }, [focusInput]);

  const updateEntry = useCallback((key: number, patch: Partial<Pick<ViewEntry, "query" | "placeholder">>) => {
    setStack((s) => {
      const i = s.findIndex((e) => e.key === key);
      if (i < 0) return s;
      const cur = s[i];
      if ((patch.query === undefined || patch.query === cur.query) && (patch.placeholder === undefined || patch.placeholder === cur.placeholder)) return s;
      const next = s.slice();
      next[i] = { ...cur, ...patch };
      return next;
    });
  }, []);

  const api = useMemo<LauncherApi>(() => ({ updateEntry, push: (v) => void pushView(v), pop: popView, close: hideWindow, toast: showToast }), [updateEntry, pushView, popView, hideWindow, showToast]);

  const navHost = useMemo<NavHost>(
    () => ({
      register: (c) => {
        viewCtl.current = c;
        return () => {
          if (viewCtl.current === c) viewCtl.current = null;
        };
      },
      setFooter: (f) => setViewFooter((prev) => (sameFooter(prev, f) ? prev : f)),
      focusSearch: () => inputRef.current?.focus(),
    }),
    [],
  );

  useEffect(() => {
    void runSearch("");
    focusInput();
    const loadInfo = () =>
      void glide()
        .feature<{ sectionLimit: number }>("glide", "info")
        .then((info) => setSectionLimit(info.sectionLimit > 0 ? info.sectionLimit : 8))
        .catch(() => undefined);
    loadInfo();
    const offShow = glide().onShow(() => {
      actionCache.current.clear();
      setTabChooser(null);
      const stale = Date.now() - lastActivity.current > POP_TO_ROOT_MS;
      setPanelOpen(false);
      setResultCard(null);
      setRawMode((m) => modeAfter(m, { type: "show" }));
      vimState.current = INITIAL_VIM_STATE;
      if (stale) {
        setQuery("");
        setArgMode(null);
        setStack([]);
        history.reset();
        void runSearch("");
      } else {
        void runSearch(queryRef.current, { preserveSelection: true });
      }
      lastActivity.current = Date.now();
      requestAnimationFrame(focusInput);
    });
    const offData = glide().onDataChanged((data) => {
      actionCache.current.clear();
      if (data?.settings?.sectionLimit > 0) setSectionLimit(data.settings.sectionLimit);
      void runSearch(queryRef.current, { preserveSelection: true });
    });
    const offAsk = glide().onAskInput((req) => {
      setResultCard(null);
      setPanelOpen(false);
      setPrompt(req);
    });
    const offResult = glide().onShowResult((payload) => {
      setPrompt(null);
      setPanelOpen(false);
      setResultCard(payload);
    });
    const offView = glide().onOpenView((view) => {
      lastActivity.current = Date.now();
      pushView(view, { replace: true });
    });
    const onBlur = () => {
      lastActivity.current = Date.now();
    };
    window.addEventListener("blur", onBlur);
    return () => {
      offShow();
      offData();
      offAsk();
      offResult();
      offView();
      window.removeEventListener("blur", onBlur);
    };
  }, [runSearch, history, focusInput, pushView]);

  // Test/diagnostic hook (scripts/e2e.mjs): push a view exactly as main's onOpenView would.
  useEffect(() => {
    window.__glideLauncher = {
      openView: (view: ViewRequest) => pushView(view),
      views: () => Object.entries(FEATURE_UIS).flatMap(([id, ui]) => Object.keys(ui.views ?? {}).map((v) => `${id}.${v}`)),
    };
    return () => {
      delete window.__glideLauncher;
    };
  }, [pushView]);

  // --- execution --------------------------------------------------------------
  const handleResult = useCallback(
    (res: ExecuteResult, titleHint?: string) => {
      if (res.navigate) {
        glide().openSettings(res.navigate);
        setPanelOpen(false);
        setArgMode(null);
        lastActivity.current = Date.now();
        glide().hide();
        return;
      }
      if (res.error) showToast(res.error, "error");
      else if (res.message) showToast(res.message);
      else if (res.ok && !res.hide && !res.view && titleHint) showToast(`✓ ${titleHint}`);
      if (res.view) {
        pushView(res.view, { titleHint });
        return;
      }
      if (res.hide) {
        setArgMode(null);
        hideWindow();
      } else {
        actionCache.current.clear();
        void runSearch(queryRef.current, { preserveSelection: true });
      }
    },
    [hideWindow, runSearch, showToast, pushView],
  );

  const execute = useCallback(
    async (scored: ScoredItem, modifiers?: ExecuteModifiers) => {
      history.push(queryRef.current);
      try {
        handleResult(await glide().execute(scored, modifiers), scored.item.title);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [handleResult, history, showToast],
  );

  const runAction = useCallback(
    async (scored: ScoredItem, action: ItemAction) => {
      setPanelOpen(false);
      focusInput();
      try {
        handleResult(await glide().runAction(scored, action.id), scored.item.title);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [handleResult, showToast, focusInput],
  );

  const activeItem = argMode?.scored ?? selected;
  const activeScored = argMode ? { ...argMode.scored, argument: argMode.text || undefined, ...(argMode.multi ? { arguments: multiArgValues(argMode.multi, argMode.text) } : {}) } : selected;

  const enterArgMode = (scored: ScoredItem) => {
    const init = initMultiArg(scored);
    setArgMode(init ? { scored, text: init.text, multi: init.multi } : { scored, text: scored.argument ?? "" });
    if (normal) setMode("insert");
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const executeSelected = (modifiers?: ExecuteModifiers) => {
    if (activeScored) void execute(activeScored, modifiers);
  };

  const openPanel = async () => {
    if (!activeItem) return;
    setPanelActions(await actionsFor(activeItem));
    setPanelOpen(true);
  };

  /** Root-list controller: the same interface a view's NavList registers. */
  const rootCtl: NavController = {
    nav: (c) => rootNav.apply(c),
    activate: (mods) => (!argMode && needsArgEntry(selected) && selected ? enterArgMode(selected) : executeSelected(mods)),
    secondary: () => executeSelected({ cmd: true }),
    toggleActions: () => (panelOpen ? setPanelOpen(false) : void openPanel()),
    findAction: async (kind) => {
      if (!activeScored) return null;
      const a = findActionOfKind(await actionsFor(activeScored), kind);
      return a ? { title: a.title, run: () => runAction(activeScored, a) } : null;
    },
    shortcut: (e) => {
      if (!activeScored) return false;
      const match = (list: ItemAction[]) => list.find((a) => a.shortcut && a.shortcut !== "⏎" && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut));
      const cached = actionCache.current.get(activeScored.item.id);
      if (cached) {
        const hit = match(cached);
        if (hit) void runAction(activeScored, hit);
        return !!hit;
      }
      void actionsFor(activeScored).then((list) => {
        const hit = match(list);
        if (hit) void runAction(activeScored, hit);
      });
      return false;
    },
  };
  const controller = (): NavController | null => (top ? viewCtl.current : rootCtl);

  // --- input ------------------------------------------------------------------
  const currentQuery = top ? top.query : argMode ? argMode.text : query;

  const setCurrentQuery = (value: string) => {
    lastActivity.current = Date.now();
    if (top) return updateEntry(top.key, { query: value });
    history.reset();
    setTabChooser(null);
    if (argMode) return setArgMode({ ...argMode, text: value });
    setQuery(value);
    void runSearch(value);
  };

  const setMode = useCallback((m: VimMode) => {
    vimState.current = INITIAL_VIM_STATE;
    setRawMode(m);
    if (m === "insert") requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const runVimCommand = async (c: VimCommand) => {
    const ctl = controller();
    switch (c.type) {
      case "move":
      case "goto":
      case "halfPage":
      case "section":
        return ctl?.nav(c);
      case "activate":
        return ctl?.activate(c.mods);
      case "secondary":
        return ctl?.secondary();
      case "actions":
        return ctl?.toggleActions();
      case "delete":
      case "copy":
      case "paste": {
        const a = ctl ? await ctl.findAction(c.type) : null;
        if (!a) return showToast(`No ${c.type} action for this item`);
        if (c.type !== "delete") return void a.run();
        const armed = deleteArm.current;
        if (armed && armed.title === a.title && Date.now() - armed.at < DELETE_CONFIRM_MS) {
          deleteArm.current = null;
          return void a.run();
        }
        deleteArm.current = { title: a.title, at: Date.now() };
        return showToast(`Press x again to ${a.title.toLowerCase()}`);
      }
      case "pop":
        return popView();
      case "clearQuery":
        return setCurrentQuery("");
      case "hide":
        return hideWindow();
      case "normal":
        return setMode("normal");
      case "insert":
        if (c.clear) setCurrentQuery("");
        setMode("insert");
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (el) el.setSelectionRange(el.value.length, el.value.length);
        });
        return;
    }
  };

  // --- Tab chooser: where a free-text query goes (Quick AI / Glide Agent / first fallback) ---
  const firstFallback = (): ScoredItem | null => {
    const sec = response?.sections.find((x) => x.id === "fallbacks");
    return sec?.items.find((i) => i.item.feature !== "agent" && i.item.feature !== "ai") ?? null;
  };
  const tabOptions = (): TabChoice[] => {
    const out: TabChoice[] = [];
    if (resolveView(QUICK_AI_VIEW)) out.push({ id: "ai", title: "Ask AI", subtitle: "Quick AI answer" });
    if (resolveView(AGENT_VIEW)) out.push({ id: "agent", title: "Ask Glide Agent", subtitle: "Let the agent do it" });
    const fb = firstFallback();
    if (fb) out.push({ id: "fallback", title: fb.item.title, subtitle: fb.item.subtitle });
    return out;
  };
  const chooserAvailable = !top && !argMode && !!query.trim() && !selected?.item.acceptsArgument && tabOptions().length > 0;

  const runTabChoice = (choice: TabChoice) => {
    saveTabChoice(choice.id);
    setTabChooser(null);
    const q = query;
    if (choice.id === "ai") pushView({ id: QUICK_AI_VIEW, props: { prompt: q } }, { titleHint: "Quick AI" });
    else if (choice.id === "agent") pushView({ id: AGENT_VIEW, props: { prompt: q } }, { titleHint: "Glide Agent" });
    else {
      const fb = firstFallback();
      if (fb) void execute({ ...fb, argument: q.trim() });
    }
  };

  const openTabChooser = () => {
    const options = tabOptions();
    if (!options.length) return;
    if (options.length === 1) return runTabChoice(options[0]);
    if (normal) setMode("insert");
    setPanelOpen(false);
    setTabChooser({ options, index: initialChoiceIndex(options, loadTabChoice()) });
  };

  /** Keys while the Tab chooser is open. Returns true when handled. */
  const chooserKey = (e: React.KeyboardEvent): boolean => {
    if (!tabChooser) return false;
    const { options, index } = tabChooser;
    const move = (d: number) => setTabChooser({ options, index: (index + d + options.length) % options.length });
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === "Escape") setTabChooser(null);
    else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey) || (ctrl && (e.key === "j" || e.key === "n"))) move(1);
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) || (ctrl && (e.key === "k" || e.key === "p"))) move(-1);
    else if (e.key === "Enter") runTabChoice(options[index]);
    else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && Number(e.key) <= options.length) runTabChoice(options[Number(e.key) - 1]);
    else {
      // Anything else (typing, ⌘K …) closes the chooser and behaves normally.
      setTabChooser(null);
      return false;
    }
    return true;
  };

  // --- "show more" per section ---------------------------------------------------
  const expandSection = async (id: SectionId) => {
    const q = query;
    try {
      const res = await glide().feature<SearchResponse>("glide", "search", q, { sectionLimit: EXPANDED_LIMIT });
      const items = res.sections.find((x) => x.id === id)?.items;
      if (!items || queryRef.current !== q) return;
      setExpanded((prev) => ({ query: res.query, sections: { ...(prev && prev.query === res.query ? prev.sections : {}), [id]: items } }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  };
  const headerOf = (group: string) => rows.find((r): r is HeaderRow => r.kind === "header" && r.group === group);

  /** Root-only keys that run before the shared vim mapping. Returns true when handled. */
  const rootKey = (e: React.KeyboardEvent): boolean => {
    const { key } = e;
    if (key === "Escape" && argMode) {
      setArgMode(null);
      return true;
    }
    const multiStep = argMode?.multi ? multiArgKey(argMode.multi, e, argMode.text) : null;
    if (argMode && multiStep) {
      setArgMode({ ...argMode, multi: multiStep.multi, text: multiStep.text });
      requestAnimationFrame(() => inputRef.current?.select());
      return true;
    }
    if (key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (argMode) return true;
      if (selected?.item.acceptsArgument) {
        enterArgMode(selected);
      } else if (chooserAvailable) {
        openTabChooser();
      } else executeSelected();
      return true;
    }
    // ⌘↓ on the last row of a capped section (or ⇧⌘↓ anywhere in it) shows the rest of that section.
    if (key === "ArrowDown" && e.metaKey && !e.altKey && !e.ctrlKey && selectedRow && !argMode) {
      const header = headerOf(selectedRow.group);
      const lastOfGroup = itemRows[rootNav.index + 1]?.group !== selectedRow.group;
      if (header?.more && (e.shiftKey || lastOfGroup)) {
        void expandSection(header.sectionId);
        return true;
      }
    }
    if (key === "Backspace" && argMode && !argMode.text) {
      setArgMode(null);
      return true;
    }
    if (key === "ArrowUp" && !normal && !e.metaKey && !e.altKey && !e.ctrlKey && !argMode && (rootNav.index <= 0 || !query)) {
      const term = history.restoreNext();
      if (term !== null) {
        setQuery(term);
        void runSearch(term);
        requestAnimationFrame(() => inputRef.current?.select());
        return true;
      }
    }
    if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(key)) {
      const row = itemRows[Number(key) - 1];
      if (row) {
        selectKey(row.key);
        void execute(row.scored);
      }
      return true;
    }
    return false;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    lastActivity.current = Date.now();
    // A view that handled the key itself (e.g. a capture-phase window listener) wins.
    if (prompt || resultCard || e.nativeEvent.isComposing || e.nativeEvent.defaultPrevented) return;
    if (!top && chooserKey(e)) {
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement;
    // A view's own text field (chat composer, form) keeps its keys.
    if (target !== inputRef.current && isEditable(target)) return;

    if (!top && rootKey(e)) {
      e.preventDefault();
      return;
    }
    const r = vimKey(vimState.current, toVimKey(e), { enabled: vimMode, mode, queryEmpty: !currentQuery, viewPushed: !!top, now: Date.now() });
    vimState.current = r.state;
    if (r.consumed) e.preventDefault();
    if (r.command) {
      void runVimCommand(r.command);
      return;
    }
    // Any other action shortcut (⌘E, ⇧⌘F, ⌘D, ⇧⌘C, ⌃X …) runs that action directly.
    if ((e.metaKey || e.ctrlKey) && e.key.length === 1) {
      const handled = controller()?.shortcut?.(e);
      if (handled === true) e.preventDefault();
    }
  };

  // --- render -----------------------------------------------------------------
  const showCards = !!prompt || !!resultCard;
  const showList = !top && !showCards && rows.length > 0;
  // A view component can opt out of the launcher footer (it draws its own) with a static `hideLauncherFooter = true`.
  const TopView = top ? (resolveView(top.id) as (ComponentType<ViewProps> & { hideLauncherFooter?: boolean }) | undefined) : undefined;
  const showFooter = !showCards && (top ? !TopView?.hideLauncherFooter : rows.length > 0 || panelOpen);
  const vimInfo = useMemo<VimInfo>(() => ({ enabled: vimMode, mode, setMode }), [vimMode, mode, setMode]);
  const placeholder = top ? top.placeholder : argMode ? (argMode.multi ? argPlaceholder(argMode.multi) : argMode.scored.item.kind === "quicklink" ? "Query…" : "Input…") : "Search apps, workflows, commands…";
  const footPrimary = top ? viewFooter?.primary : activeItem ? primaryTitle : null;
  const footHasActions = top ? !!viewFooter?.hasActions : !!activeItem;

  return (
    <VimContext.Provider value={vimInfo}>
      <div
        ref={panelRef}
        className={`launcher ${panelOpen ? "launcher--panel" : ""} ${normal ? "launcher--normal" : ""} ${top ? "launcher--view" : ""}`}
        role="combobox"
        aria-expanded={showList}
        aria-haspopup="listbox"
        aria-controls="glide-results"
        data-vim-mode={vimMode ? mode : undefined}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          // Keep focus in the search field unless a focusable control was clicked.
          const t = e.target as HTMLElement;
          if (!t.closest("input, textarea, button, select, [tabindex], [contenteditable], pre")) e.preventDefault();
        }}
      >
        {loading && !top && <div className="glide-loading" aria-hidden="true" />}
        <div className="launcher__head">
          {top ? (
            <button type="button" className="launcher__back" aria-label="Back" title="Back (⎋)" onClick={popView}>
              <span aria-hidden="true">‹</span>
            </button>
          ) : (
            <GlideGlyph />
          )}
          {top && (
            <span className="crumb" title={stack.map((s) => s.title).join(" › ")}>
              {stack.length > 1 && <span className="crumb__parent">{stack[stack.length - 2].title} ›</span>}
              <span className="crumb__title">{top.title}</span>
            </span>
          )}
          <input
            ref={inputRef}
            className={`launcher__input ${normal ? "launcher__input--normal" : ""}`}
            value={currentQuery}
            placeholder={placeholder}
            onChange={(e) => setCurrentQuery(e.target.value)}
            onMouseDown={() => normal && setMode("insert")}
            readOnly={normal}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Search"
            aria-autocomplete="list"
            aria-activedescendant={!top && rootNav.selectedKey ? `row-${rootNav.selectedKey}` : undefined}
            disabled={showCards}
          />
          {normal && (
            <span className="vim-pill" title="Vim NORMAL mode — i or / to type">
              NORMAL
            </span>
          )}
          {argMode ? (
            <>
              {argMode.multi && <ArgFields multi={argMode.multi} text={argMode.text} />}
              <span className="argpill" title={argMode.scored.item.title}>
                <Icon icon={argMode.scored.item.icon} size="md" />
                {argMode.scored.item.title}
              </span>
            </>
          ) : (
            !showCards &&
            !normal && (
              <span className="launcher__hint">
                {chooserAvailable ? (
                  <>
                    {(() => {
                      const opts = tabOptions();
                      const o = opts[initialChoiceIndex(opts, loadTabChoice())];
                      return opts.length > 1 ? "Ask…" : (o?.title ?? "Ask");
                    })()}{" "}
                    <Kbd keys="⇥" />
                  </>
                ) : !top && !argMode && !query && historyCount() > 0 ? (
                  <>
                    <Kbd keys="↑" /> recent · <Kbd keys="⌘K" /> actions
                  </>
                ) : (
                  <>
                    <Kbd keys="⌘K" /> actions
                  </>
                )}
              </span>
            )
          )}
        </div>

        {tabChooser && !top && <TabChooser options={tabChooser.options} index={tabChooser.index} query={query.trim()} onPick={(i) => runTabChoice(tabChooser.options[i])} />}

        {prompt && (
          <>
            <div className="launcher__divider" />
            <PromptCard
              request={prompt}
              onAnswer={(value) => {
                glide().answerInput(prompt.requestId, value);
                setPrompt(null);
                focusInput();
              }}
            />
          </>
        )}

        {resultCard && (
          <>
            <div className="launcher__divider" />
            <ResultCard
              payload={resultCard}
              onDone={() => {
                setResultCard(null);
                focusInput();
              }}
              onCopy={() => {
                void navigator.clipboard.writeText(resultCard.text).then(() => showToast("Copied"));
              }}
            />
          </>
        )}

        {top && !showCards && (
          <>
            <div className="launcher__divider" />
            <div className="launcher__view" data-view={top.id}>
              <NavHostContext.Provider value={navHost}>
                <ErrorBoundary key={top.key} onError={(err) => showToast(`${top.title} crashed: ${err.message}`, "error")}>
                  <ViewHost entry={top} api={api} />
                </ErrorBoundary>
              </NavHostContext.Provider>
            </div>
          </>
        )}

        {showList && (
          <>
            <div className="launcher__divider" />
            <div id="glide-results" ref={listRef} className="launcher__list" role="listbox" aria-label="Results">
              {rows.map((r) =>
                r.kind === "header" ? (
                  <div key={r.key} className={`section ${r.dym ? "section--dym" : ""}`} role="presentation" data-section={r.group}>
                    <span>
                      {r.dym ? (
                        <>
                          Did you mean <em>“{r.dym}”</em>?
                        </>
                      ) : (
                        r.title
                      )}
                    </span>
                    <span className="section__meta">
                      {r.more && (
                        <button type="button" className="section__more" tabIndex={-1} onClick={() => void expandSection(r.sectionId)} title="Show more (⌘↓ at the end of the section)">
                          Show more <Kbd keys="⌘↓" />
                        </button>
                      )}
                      <span className="section__count">{r.count}</span>
                    </span>
                  </div>
                ) : (
                  <ResultRow key={r.key} rowId={`row-${r.key}`} scored={r.scored} selected={r.key === rootNav.selectedKey} onHover={() => r.key !== rootNav.selectedKey && selectKey(r.key)} onClick={() => void execute(r.scored)} />
                ),
              )}
            </div>
          </>
        )}

        {showFooter && (
          <div className="launcher__foot">
            <div className="launcher__foot-left">
              {vimMode && <span className={`vim-mode ${normal ? "vim-mode--normal" : ""}`}>{normal ? "-- NORMAL --" : "-- INSERT --"}</span>}
              {top ? (
                <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" }}>{top.title}</span>
              ) : activeItem ? (
                <>
                  <Icon icon={activeItem.item.icon} size="md" />
                  <span className="faint foot-kind">{kindLabel(activeItem.item)}</span>
                  <span>·</span>
                  <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" }}>{activeItem.item.title}</span>
                </>
              ) : (
                <span className="faint">Glide</span>
              )}
            </div>
            <div className="launcher__foot-right">
              {!top && !argMode && query.trim() && (
                <>
                  <span className="launcher__count" data-count={itemRows.length}>
                    {itemRows.length} {itemRows.length === 1 ? "result" : "results"}
                  </span>
                  <span className="footsep" />
                </>
              )}
              {footPrimary && (
                <>
                  <button type="button" className="footbtn" onClick={() => controller()?.activate({ cmd: false, shift: false, alt: false })}>
                    {footPrimary} <Kbd keys="⏎" />
                  </button>
                  <span className="footsep" />
                </>
              )}
              <button type="button" className={`footbtn ${panelOpen ? "footbtn--on" : ""}`} onClick={() => controller()?.toggleActions()} disabled={!footHasActions}>
                Actions <Kbd keys="⌘K" />
              </button>
            </div>
          </div>
        )}

        {panelOpen && !top && activeItem && activeScored && (
          <ActionPanel
            title={activeItem.item.title}
            actions={panelActions}
            onRun={(a) => void runAction(activeScored, a)}
            onClose={() => {
              setPanelOpen(false);
              focusInput();
            }}
          />
        )}

        <Toast toast={toast} />
      </div>
    </VimContext.Provider>
  );
}
