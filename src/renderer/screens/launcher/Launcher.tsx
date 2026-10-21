import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { ViewProps } from "../../features/types";
import type { AskInputRequest, ExecuteModifiers, ExecuteResult, ItemAction, ShowResultPayload, ViewRequest } from "@shared/ipc";
import type { ScoredItem, SearchResponse, SectionId, Settings } from "@shared/types";
import { glide } from "../../lib/glide";
import { eventMatchesShortcut } from "../../lib/keys";
import { kindLabel } from "../../lib/icons";
import { findActionOfKind, INITIAL_VIM_STATE, toVimKey, VimContext, vimKey, type VimCommand, type VimInfo, type VimMode } from "../../lib/vim";
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
import { PromptCard, ResultCard } from "./Cards";
import { ViewHost, viewTitle, type LauncherApi, type ViewEntry } from "./ViewHost";

const POP_TO_ROOT_MS = 90_000;
const DELETE_CONFIRM_MS = 3000;
const QUICK_AI_VIEW = "ai.chat";

type Row = { kind: "header"; key: string; sectionId: SectionId; title: string } | { kind: "item"; key: string; sectionId: SectionId; scored: ScoredItem; n: number };
type ItemRow = Extract<Row, { kind: "item" }>;

interface ArgMode {
  scored: ScoredItem;
  text: string;
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

function buildRows(res: SearchResponse | null): Row[] {
  if (!res) return [];
  const rows: Row[] = [];
  let n = 0;
  for (const s of res.sections) {
    if (!s.items.length) continue;
    rows.push({ kind: "header", key: `h:${s.id}`, sectionId: s.id, title: s.title });
    for (const it of s.items) rows.push({ kind: "item", key: `${s.id}:${it.item.id}`, sectionId: s.id, scored: it, n: ++n });
  }
  return rows;
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
  const mode: VimMode = vimMode ? rawMode : "insert";
  const normal = mode === "normal";
  const top = stack.length ? stack[stack.length - 1] : null;

  useResizeReporter(panelRef);

  const queryRef = useRef(query);
  queryRef.current = query;

  // --- rows & selection (selection is derived during render: never a frame without a selected row) ---
  const rows = useMemo<Row[]>(
    () => (argMode ? [{ kind: "header", key: "h:arg", sectionId: "results", title: "Argument" }, { kind: "item", key: "arg", sectionId: "results", scored: argMode.scored, n: 1 }] : buildRows(response)),
    [response, argMode],
  );
  const itemRows = useMemo(() => rows.filter((r): r is ItemRow => r.kind === "item"), [rows]);
  const rowKeys = useMemo(() => itemRows.map((r) => r.key), [itemRows]);
  const rowSections = useMemo(() => itemRows.map((r) => r.sectionId as string), [itemRows]);
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
        if (!opts.preserveSelection) selectKey(null);
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
      setViewFooter(null);
      requestAnimationFrame(focusInput);
      return true;
    },
    [focusInput, showToast],
  );

  const popView = useCallback(() => {
    setStack((s) => s.slice(0, -1));
    setViewFooter(null);
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
    const offShow = glide().onShow(() => {
      actionCache.current.clear();
      const stale = Date.now() - lastActivity.current > POP_TO_ROOT_MS;
      setPanelOpen(false);
      setResultCard(null);
      setRawMode("insert");
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
    const offData = glide().onDataChanged(() => {
      actionCache.current.clear();
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
  const activeScored = argMode ? { ...argMode.scored, argument: argMode.text || undefined } : selected;

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
    activate: (mods) => executeSelected(mods),
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

  const quickAiAvailable = !top && !argMode && !!query.trim() && !!selected && !selected.item.acceptsArgument && !!resolveView(QUICK_AI_VIEW);

  /** Root-only keys that run before the shared vim mapping. Returns true when handled. */
  const rootKey = (e: React.KeyboardEvent): boolean => {
    const { key } = e;
    if (key === "Escape" && argMode) {
      setArgMode(null);
      return true;
    }
    if (key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (argMode) return true;
      if (selected?.item.acceptsArgument) {
        setArgMode({ scored: selected, text: selected.argument ?? "" });
        if (normal) setMode("insert");
        requestAnimationFrame(() => inputRef.current?.select());
      } else if (quickAiAvailable) {
        pushView({ id: QUICK_AI_VIEW, props: { prompt: query } }, { titleHint: "Quick AI" });
      } else executeSelected();
      return true;
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
  const placeholder = top ? top.placeholder : argMode ? (argMode.scored.item.kind === "quicklink" ? "Query…" : "Input…") : "Search apps, workflows, commands…";
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
            <span className="argpill" title={argMode.scored.item.title}>
              <Icon icon={argMode.scored.item.icon} size="md" />
              {argMode.scored.item.title}
            </span>
          ) : (
            !showCards &&
            !normal && (
              <span className="launcher__hint">
                {quickAiAvailable ? (
                  <>
                    Ask AI <Kbd keys="⇥" />
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
                  <div key={r.key} className="section" role="presentation">
                    <span>{r.title}</span>
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
