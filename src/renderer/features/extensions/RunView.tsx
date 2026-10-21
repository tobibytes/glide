/** "extensions.run": renders a running command's current view model (List / Grid / Detail / Form). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionModel, FormFieldModel, FormValue, FormValues, ListItemModel, QuickLookModel, ViewModel } from "../../../extension-api/types";
import { iconFor } from "../../../extension-api/icons";
import type { ActionOutcome } from "../../../main/features/extensions/actions";
import type { RunViewState } from "../../../main/features/extensions/contract";
import type { AlertRequest, OAuthPrompt, SessionEvent, ToastActionModel } from "../../../main/features/extensions/sessions";
import type { NavItem, ViewProps } from "../types";
import { NavList, type NavListHandle } from "../../components/NavList";
import { ActionPanel } from "../../components/ActionPanel";
import { Icon } from "../../components/Icon";
import { NavHostContext, useNavController, useNavHost, type NavController, type NavHost } from "../../lib/navHost";
import { eventMatchesShortcut } from "../../lib/keys";
import { ext, errorText, useExtEvent } from "./api";
import { filterItems } from "./filter";
import { Markdown, Metadata } from "./MarkdownView";
import { FieldsForm, type FormAction } from "./FieldsForm";
import { GridBody } from "./GridBody";
import { Accessories, AlertOverlay, EmptyView, navActions, SearchAccessory, type ActionTarget, type Emit, type RunInfo, type Runner } from "./viewKit";
import { ExtToast, OAuthCard, PickDateOverlay, QuickLookOverlay, SubmenuPanel, type ExtToastState, type SubmenuFrame } from "./Overlays";
import type { FieldCommand } from "./FieldsForm";

/** Search text last forwarded per session/depth, so a remount (pop back) does not re-send it. */
const lastSearch = new Map<string, string>();
/** Sessions asked to pop to the root search: every remounted level pops itself. */
const poppingToRoot = new Set<string>();
const SEARCH_DEBOUNCE_MS = 140;

// --- List -------------------------------------------------------------------------------

interface Row extends NavItem {
  model: ListItemModel;
}

type ListView = Extract<ViewModel, { type: "list" }>;

function ListBody({ view, info, query, run, emit }: { view: ListView; info: RunInfo; query: string; run: Runner; emit: Emit }) {
  const filtering = view.filtering ?? !view.searchHandler;
  const items = useMemo(() => (filtering ? filterItems(view.items, query) : view.items), [view.items, filtering, query]);
  const rows = useMemo<Row[]>(() => items.map((m) => ({ id: m.id, section: m.section, model: m })), [items]);
  // Raycast lists show the detail pane only with isShowingDetail; Glide lists whenever an item has one.
  const hasDetail = useMemo(() => (view.showDetail !== undefined ? view.showDetail : view.items.some((i) => i.detail)), [view.showDetail, view.items]);
  const target = (m: ListItemModel): ActionTarget => ({ quickLook: m.quickLook, title: m.title });
  const actions = useCallback((r: Row) => navActions(r.model.actions, run, target(r.model)), [run]);
  const index = useRef(-1);
  const listRef = useRef<NavListHandle<Row>>(null);
  // Raycast `selectedItemId`: select it whenever the value changes (or once the item shows up).
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const want = view.selectedItemId;
    if (!want || applied.current === want) return;
    if (listRef.current?.select(want)) applied.current = want;
  }, [view.selectedItemId, rows]);
  const askedFor = useRef(-1);
  const lastSel = useRef<string | null>(null);

  const onSelectionChange = useCallback(
    (r: Row | null) => {
      const id = r?.id ?? null;
      index.current = r ? rows.findIndex((x) => x.id === r.id) : -1;
      if (id !== lastSel.current) {
        lastSel.current = id;
        if (view.selectionHandler) emit(view.selectionHandler, [id]);
      }
      const p = view.pagination;
      if (p?.hasMore && p.handler && index.current >= rows.length - 5 && askedFor.current !== rows.length) {
        askedFor.current = rows.length;
        emit(p.handler, []);
      }
    },
    [rows, view.selectionHandler, view.pagination, emit],
  );

  // Empty list: Raycast's List.EmptyView (with its own actions) or the list-level actions.
  const emptyActions = useMemo(() => navActions(view.emptyView?.actions ?? view.actions ?? [], run), [view.emptyView, view.actions, run]);
  if (!rows.length) return <EmptyBody actions={emptyActions} info={info}><EmptyView model={view.emptyView} fallback={view.emptyText ?? "No results"} assetsPath={info.assetsPath} loading={view.isLoading} /></EmptyBody>;

  return (
    <NavList<Row>
      ref={listRef}
      items={rows}
      actionsTitle={info.commandTitle}
      emptyText={view.isLoading ? "Loading…" : (view.emptyText ?? "No results")}
      onActivate={(r, mods) => run(mods.cmd ? (r.model.actions[1] ?? r.model.actions[0]) : r.model.actions[0], target(r.model))}
      onSelectionChange={onSelectionChange}
      actions={actions}
      detail={
        hasDetail
          ? (r) =>
              r.model.detail ? (
                <div className="extensions-detailpane">
                  {r.model.detail.isLoading && !r.model.detail.markdown ? <div className="extensions-muted">Loading…</div> : <Markdown source={r.model.detail.markdown} />}
                  <Metadata entries={r.model.detail.metadata ?? []} assetsPath={info.assetsPath} />
                </div>
              ) : null
          : undefined
      }
      renderItem={(r, selected) => (
        <div className={`row extensions-row ${selected ? "row--selected" : ""}`}>
          <Icon icon={iconFor(r.model.icon, info.assetsPath)} fallback="•" />
          <div className="row__main">
            <span className="row__title">{r.model.title}</span>
            {r.model.subtitle && !hasDetail && <span className="row__subtitle">{r.model.subtitle}</span>}
          </div>
          {!hasDetail && <Accessories list={r.model.accessories} assetsPath={info.assetsPath} />}
        </div>
      )}
    />
  );
}

/** Keyboard handling for an empty List/Grid that still has actions (⏎ runs the first, ⌘K lists them). */
function EmptyBody({ actions, info, children }: { actions: ReturnType<typeof navActions>; info: RunInfo; children: React.ReactNode }) {
  const host = useNavHost();
  const [panel, setPanel] = useState(false);
  useEffect(() => {
    host?.setFooter({ primary: actions[0]?.title ?? null, hasActions: actions.length > 0 });
  }, [host, actions]);
  useEffect(() => () => host?.setFooter(null), [host]);
  useNavController({
    nav: () => undefined,
    activate: () => actions[0]?.run(),
    secondary: () => (actions[1] ?? actions[0])?.run(),
    toggleActions: () => setPanel((p) => !p && actions.length > 0),
    findAction: async () => null,
    shortcut: (e) => {
      const hit = actions.find((a) => a.shortcut && a.shortcut !== "⏎" && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) void hit.run();
      return !!hit;
    },
  });
  return (
    <div className="extensions-empty">
      {children}
      {panel && (
        <ActionPanel
          title={info.commandTitle}
          actions={actions}
          onRun={(a) => {
            setPanel(false);
            host?.focusSearch();
            void a.run();
          }}
          onClose={() => {
            setPanel(false);
            host?.focusSearch();
          }}
        />
      )}
    </div>
  );
}

// --- Detail ------------------------------------------------------------------------------

function DetailBody({ view, info, run }: { view: Extract<ViewModel, { type: "detail" }>; info: RunInfo; run: Runner }) {
  const host = useNavHost();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState(false);
  const actions = useMemo(() => navActions(view.actions, run), [view.actions, run]);

  useEffect(() => {
    host?.setFooter({ primary: view.actions[0]?.title ?? null, hasActions: view.actions.length > 0 });
  }, [host, view.actions]);
  useEffect(() => () => host?.setFooter(null), [host]);

  const scroll = (dy: number) => scrollRef.current?.scrollBy({ top: dy });
  useNavController({
    nav: (c) => {
      const page = (scrollRef.current?.clientHeight ?? 300) / 2;
      if (c.type === "move") scroll(c.delta * 48);
      else if (c.type === "halfPage") scroll(c.dir * c.count * page);
      else if (c.type === "goto") scrollRef.current?.scrollTo({ top: c.index === "last" ? 1e9 : 0 });
      else scroll(c.dir * page * 2);
    },
    activate: () => run(view.actions[0]),
    secondary: () => run(view.actions[1] ?? view.actions[0]),
    toggleActions: () => setPanel((p) => !p && view.actions.length > 0),
    findAction: async (kind) => {
      const a = view.actions.find((x) => (kind === "copy" ? x.kind === "copy" : kind === "paste" ? x.kind === "paste" : kind === "delete" ? x.destructive : false));
      return a ? { title: a.title, run: () => run(a) } : null;
    },
    shortcut: (e) => {
      const hit = actions.find((a) => a.shortcut && a.shortcut !== "⏎" && a.shortcut !== "⌘⏎" && eventMatchesShortcut(e, a.shortcut));
      if (hit) void hit.run();
      return !!hit;
    },
  });

  return (
    <div className="extensions-detail">
      <div className="extensions-detail__body" ref={scrollRef} tabIndex={-1}>
        {view.isLoading && !view.markdown ? <div className="extensions-muted">Loading…</div> : <Markdown source={view.markdown} />}
      </div>
      {view.metadata.length > 0 && (
        <aside className="extensions-detail__meta">
          <Metadata entries={view.metadata} assetsPath={info.assetsPath} />
        </aside>
      )}
      {panel && (
        <ActionPanel
          title={info.commandTitle}
          actions={actions}
          onRun={(a) => {
            setPanel(false);
            host?.focusSearch();
            void a.run();
          }}
          onClose={() => {
            setPanel(false);
            host?.focusSearch();
          }}
        />
      )}
    </div>
  );
}

// --- the view ---------------------------------------------------------------------------

export function RunView({ props, query, setQuery, setPlaceholder, push, pop, close, toast }: ViewProps) {
  const sessionId = String(props.sessionId ?? "");
  const depth = typeof props.depth === "number" ? props.depth : 0;
  const key = `${sessionId}:${depth}`;
  const [state, setState] = useState<RunViewState | null>(null);
  const [view, setView] = useState<ViewModel | null>(null);
  const [gone, setGone] = useState(false);
  const [alert, setAlert] = useState<AlertRequest | null>(null);
  const [submenus, setSubmenus] = useState<SubmenuFrame[]>([]);
  const [pickDate, setPickDate] = useState<ActionModel | null>(null);
  const [quickLook, setQuickLook] = useState<QuickLookModel | null>(null);
  const [oauth, setOauth] = useState<OAuthPrompt | null>(null);
  const [extToast, setExtToast] = useState<ExtToastState | null>(null);
  const [fieldCmd, setFieldCmd] = useState<FieldCommand | null>(null);

  // The body's controller (NavList, Detail, Form…), so a closed submenu can reopen its parent ⌘K panel.
  const realHost = useNavHost();
  const controller = useRef<NavController | null>(null);
  const proxyHost = useMemo<NavHost | null>(
    () =>
      realHost && {
        register: (c) => {
          controller.current = c;
          const off = realHost.register(c);
          return () => {
            if (controller.current === c) controller.current = null;
            off();
          };
        },
        setFooter: (f) => realHost.setFooter(f),
        focusSearch: () => realHost.focusSearch(),
      },
    [realHost],
  );

  useEffect(() => {
    if (poppingToRoot.has(sessionId)) {
      if (depth === 0) poppingToRoot.delete(sessionId);
      pop();
      return;
    }
    let alive = true;
    void ext<RunViewState | null>("getView", sessionId, depth).then((s) => {
      if (!alive) return;
      if (!s) return setGone(true);
      setState(s);
      if (s.view) setView((v) => v ?? s.view);
    });
    void ext("mountView", sessionId, depth);
    return () => {
      alive = false;
      void ext("unmountView", sessionId, depth);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, depth]);

  useExtEvent<SessionEvent>("session", (e) => {
    if (e.sessionId !== sessionId) return;
    if ((e.kind === "render" || e.kind === "push") && e.depth === depth && e.view) setView(e.view);
    else if (e.kind === "push" && e.depth === depth + 1) push({ id: "extensions.run", props: { sessionId, depth: depth + 1, title: e.view && "title" in e.view ? e.view.title : undefined } });
    else if (e.kind === "pop" && e.depth === depth) pop();
    else if (e.kind === "toast" && e.toast?.id) setExtToast({ id: e.toast.id, style: e.toast.style, title: e.toast.title, message: e.toast.message, actions: e.toast.actions ?? [] });
    else if (e.kind === "toast" && e.toast) toast(e.toast.message ? `${e.toast.title} — ${e.toast.message}` : e.toast.title, e.toast.style === "failure" ? "error" : "info");
    else if (e.kind === "toastHide") setExtToast((t) => (t && t.id === e.toastId ? null : t));
    else if (e.kind === "field" && e.field) setFieldCmd((c) => ({ seq: (c?.seq ?? 0) + 1, ...e.field! }));
    else if (e.kind === "oauth" && e.oauth) setOauth(e.oauth);
    else if (e.kind === "oauthDone") setOauth((o) => (o && o.id === e.oauthId ? null : o));
    else if (e.kind === "ended") setGone(true);
    else if (e.kind === "alert" && e.alert) setAlert(e.alert);
    else if (e.kind === "clearSearch") setQuery("");
    else if (e.kind === "popToRoot") {
      if (depth > 0) poppingToRoot.add(sessionId);
      pop();
    }
  });

  // A command that ends without rendering anything just closes its view.
  useEffect(() => {
    if (gone && !view) pop();
  }, [gone, view, pop]);

  useEffect(() => {
    const placeholder = view?.type === "list" || view?.type === "grid" ? (view.searchPlaceholder ?? "Search…") : view ? "" : "Loading…";
    setPlaceholder(placeholder);
  }, [view, setPlaceholder]);

  // Controlled search text (Raycast `searchText`).
  const controlledText = view && (view.type === "list" || view.type === "grid") ? view.searchText : undefined;
  useEffect(() => {
    if (controlledText !== undefined) {
      lastSearch.set(key, controlledText);
      setQuery(controlledText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledText]);

  // Forward search text to commands that subscribed to onSearchTextChange.
  const searching = !!view && (view.type === "list" || view.type === "grid") && !!view.searchHandler;
  useEffect(() => {
    if (!searching) return;
    if ((lastSearch.get(key) ?? "") === query) return;
    const t = setTimeout(() => {
      lastSearch.set(key, query);
      void ext("search", sessionId, depth, query);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, searching, key, sessionId, depth]);
  useEffect(() => () => void (depth === 0 && gone && lastSearch.delete(key)), [depth, gone, key]);

  const emitRef = useRef<Emit>(() => undefined);
  const run = useCallback<Runner>(
    (a, target) => {
      if (!a) return;
      if (a.kind === "submenu") {
        if (a.callback) emitRef.current(a.callback, []);
        setSubmenus((s) => [...s, { action: a, target }]);
        return;
      }
      // Leaving a submenu panel: give the keyboard back to the launcher's search field.
      setSubmenus((cur) => {
        if (cur.length) queueMicrotask(() => realHost?.focusSearch());
        return [];
      });
      if (a.kind === "pickDate") return setPickDate(a);
      if (a.kind === "quickLook") {
        if (target?.quickLook) setQuickLook(target.quickLook);
        else toast("Nothing to preview", "error");
        return;
      }
      if (a.kind === "createSnippet" || a.kind === "createQuicklink") {
        push({ id: "extensions.createEntry", props: { kind: a.kind === "createSnippet" ? "snippet" : "quicklink", values: (a.kind === "createSnippet" ? a.snippet : a.quicklink) ?? {}, title: a.title } });
        return;
      }
      void ext<ActionOutcome>("action", sessionId, depth, a.id)
        .then((res) => {
          if (!res.ok) toast(res.error ?? "Action failed", "error");
          else if (res.hide) close();
        })
        .catch((err) => toast(errorText(err), "error"));
    },
    [sessionId, depth, toast, close, push, realHost],
  );

  const emit = useCallback<Emit>(
    (handler, args) => {
      if (handler) void ext("event", sessionId, depth, handler, args).catch(() => undefined);
    },
    [sessionId, depth],
  );
  emitRef.current = emit;
  const onToastAction = useCallback((a: ToastActionModel) => emit(a.handler, []), [emit]);
  const expireToast = useCallback(() => setExtToast(null), []);
  const closeSubmenu = useCallback(() => {
    setSubmenus((s) => {
      const next = s.slice(0, -1);
      // Back from the first level: reopen the panel it came from.
      if (!next.length) queueMicrotask(() => controller.current?.toggleActions());
      return next;
    });
  }, []);

  const submit = useCallback(
    async (values: FormValues, actionId?: string) => {
      const ok = await ext<boolean>("submit", sessionId, depth, values, actionId ?? null).catch(() => false);
      if (!ok) toast("This form is no longer active", "error");
    },
    [sessionId, depth, toast],
  );

  const formActions = useMemo<FormAction[] | undefined>(() => {
    if (view?.type !== "form" || !view.actions?.length) return undefined;
    return navActions(view.actions, run).map((na, i) => {
      const a = view.actions![i] as ActionModel;
      return { ...na, run: (values: FormValues) => (a.kind === "submit" ? submit(values, a.id) : run(a)) };
    });
  }, [view, run, submit]);
  const onFieldChange = useCallback((f: FormFieldModel, v: FormValue) => emit(f.changeHandler, [v]), [emit]);
  const onFieldBlur = useCallback((f: FormFieldModel, v: FormValue) => emit(f.blurHandler, [v]), [emit]);

  if (!view || !state) {
    return <div className="extensions-loading">{gone ? "This command has stopped." : <div className="glide-loading" aria-hidden="true" />}</div>;
  }
  const info: RunInfo = { commandTitle: state.info.commandTitle, assetsPath: state.info.assetsPath };
  const dropdown = (view.type === "list" || view.type === "grid") && view.dropdown ? view.dropdown : null;
  return (
    <NavHostContext.Provider value={proxyHost}>
    <div className={`extensions-run ${dropdown ? "extensions-run--bar" : ""}`}>
      {view.isLoading && <div className="glide-loading" aria-hidden="true" />}
      {dropdown && <SearchAccessory model={dropdown} emit={emit} />}
      {view.type === "list" && <ListBody view={view} info={info} query={query} run={run} emit={emit} />}
      {view.type === "grid" && <GridBody view={view} info={info} query={query} run={run} emit={emit} />}
      {view.type === "detail" && <DetailBody view={view} info={info} run={run} />}
      {view.type === "form" && (
        <FieldsForm
          fields={view.fields}
          submitTitle={view.submitTitle}
          description={view.description}
          busy={view.isLoading}
          onSubmit={(v) => submit(v)}
          onCancel={pop}
          actions={formActions}
          onFieldChange={onFieldChange}
          onFieldBlur={onFieldBlur}
          command={fieldCmd}
        />
      )}
      {view.type === "menubar" && <div className="extensions-muted extensions-loading">This is a menu-bar command: it runs in the menu bar.</div>}
      {submenus.length > 0 && <SubmenuPanel stack={submenus} run={run} onBack={closeSubmenu} />}
      {pickDate && (
        <PickDateOverlay
          action={pickDate}
          onPick={(iso) => {
            setPickDate(null);
            emit(pickDate.handler, [iso]);
            realHost?.focusSearch();
          }}
          onCancel={() => {
            setPickDate(null);
            realHost?.focusSearch();
          }}
        />
      )}
      {quickLook && (
        <QuickLookOverlay
          path={quickLook.path}
          name={quickLook.name}
          onClose={() => {
            setQuickLook(null);
            realHost?.focusSearch();
          }}
        />
      )}
      {oauth && (
        <OAuthCard
          prompt={oauth}
          onDone={() => {
            setOauth(null);
            realHost?.focusSearch();
          }}
        />
      )}
      {extToast && <ExtToast toast={extToast} onAction={onToastAction} onExpire={expireToast} />}
      {alert && (
        <AlertOverlay
          alert={alert}
          onAnswer={(ok) => {
            setAlert(null);
            void ext("alertResult", alert.id, ok);
          }}
        />
      )}
      {gone && <div className="extensions-ended">The extension process has stopped; actions are unavailable.</div>}
    </div>
    </NavHostContext.Provider>
  );
}
