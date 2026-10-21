import { useEffect, useMemo, useRef } from "react";
import type { UserData } from "@shared/types";
import { navigateTo, type Route, type SettingsPage } from "../../lib/route";
import { useTheme } from "../../hooks/useTheme";
import { settingsPages } from "../../features/registry";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { GeneralPage } from "./GeneralPage";
import { WorkflowsPage } from "./WorkflowsPage";
import { WorkflowEditor } from "./WorkflowEditor";
import { QuicklinksPage } from "./QuicklinksPage";
import { SnippetsPage } from "./SnippetsPage";
import { AliasesPage } from "./AliasesPage";
import { AboutPage } from "./AboutPage";

type SettingsRoute = Extract<Route, { mode: "settings" }>;

const NAV: Array<{ page: SettingsPage; label: string; icon: string }> = [
  { page: "general", label: "General", icon: "⚙︎" },
  { page: "workflows", label: "Workflows", icon: "⧉" },
  { page: "quicklinks", label: "Quicklinks", icon: "⛓" },
  { page: "snippets", label: "Snippets", icon: "✂" },
  { page: "aliases", label: "Aliases & Hotkeys", icon: "⌘" },
  { page: "about", label: "About", icon: "ⓘ" },
];

const TITLES: Record<Exclude<SettingsPage, "feature">, string> = {
  general: "General",
  workflows: "Workflows",
  quicklinks: "Quicklinks",
  snippets: "Snippets",
  aliases: "Aliases & Hotkeys",
  hotkeys: "Aliases & Hotkeys",
  about: "About Glide",
};

interface NavEntry {
  key: string;
  label: string;
  icon: string;
  go(): void;
}

export function Settings({ route, data, reload }: { route: SettingsRoute; data: UserData | null; reload: () => Promise<void> }) {
  useTheme(data?.settings.theme);
  const features = useMemo(() => settingsPages(), []);
  const feature = route.page === "feature" ? features.find((f) => f.id === route.id) : undefined;
  // A feature id with no settings page falls back to General.
  const page: SettingsPage = route.page === "feature" && !feature ? "general" : route.page;
  const activeKey = page === "feature" ? `feature:${feature?.id}` : page === "hotkeys" ? "aliases" : page;
  const isEditor = page === "workflows" && !!route.id;
  const title = feature ? feature.title : TITLES[page as Exclude<SettingsPage, "feature">];

  const entries = useMemo<NavEntry[]>(
    () => [
      ...NAV.map((n) => ({ key: n.page, label: n.label, icon: n.icon, go: () => navigateTo(n.page) })),
      ...features.map((f) => ({ key: `feature:${f.id}`, label: f.title, icon: f.icon, go: () => navigateTo("feature", f.id) })),
    ],
    [features],
  );
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.title = `Glide — ${title}`;
  }, [title]);

  // ⌘1…⌘9 switch sidebar pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || !/^[1-9]$/.test(e.key)) return;
      const entry = entries[Number(e.key) - 1];
      if (!entry) return;
      e.preventDefault();
      entry.go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entries]);

  // j/k (and arrows) move through the sidebar when it has focus; the page follows the selection.
  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const down = e.key === "j" || e.key === "ArrowDown";
    const up = e.key === "k" || e.key === "ArrowUp";
    const top = e.key === "g" || e.key === "Home";
    const bottom = e.key === "G" || e.key === "End";
    if (!down && !up && !top && !bottom) return;
    e.preventDefault();
    const cur = entries.findIndex((n) => n.key === activeKey);
    const next = top ? 0 : bottom ? entries.length - 1 : Math.min(entries.length - 1, Math.max(0, cur + (down ? 1 : -1)));
    entries[next].go();
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>(`[data-key="${entries[next].key}"]`)?.focus());
  };

  let body: React.ReactNode;
  if (!data) body = <div className="empty">Loading…</div>;
  else if (feature) {
    const Page = feature.component;
    body = (
      <ErrorBoundary key={feature.id} fallback={(err) => <div className="error-banner">This page crashed: {err.message}</div>}>
        <Page />
      </ErrorBoundary>
    );
  } else if (page === "general") body = <GeneralPage data={data} anchor={route.anchor} />;
  else if (page === "workflows" && route.id) body = <WorkflowEditor key={route.id} data={data} workflowId={route.id} reload={reload} />;
  else if (page === "workflows") body = <WorkflowsPage data={data} />;
  else if (page === "quicklinks") body = <QuicklinksPage data={data} editId={route.id} />;
  else if (page === "snippets") body = <SnippetsPage data={data} editId={route.id} />;
  else if (page === "aliases" || page === "hotkeys") body = <AliasesPage data={data} preselect={route.id} focus={page === "hotkeys" ? "hotkey" : "alias"} />;
  else body = <AboutPage data={data} anchor={route.anchor} />;

  const navButton = (n: NavEntry, i: number) => (
    <button
      key={n.key}
      type="button"
      data-key={n.key}
      className={`navitem ${activeKey === n.key ? "navitem--on" : ""}`}
      aria-current={activeKey === n.key ? "page" : undefined}
      title={i < 9 ? `⌘${i + 1}` : undefined}
      onClick={n.go}
    >
      <span className="navitem__icon" aria-hidden="true">
        {n.icon}
      </span>
      <span className="navitem__label">{n.label}</span>
      {i < 9 && <span className="navitem__kbd">⌘{i + 1}</span>}
    </button>
  );

  return (
    <div className="settings">
      <nav className="sidebar" aria-label="Settings sections" ref={navRef} onKeyDown={onNavKey}>
        <div className="sidebar__top drag" />
        <div className="sidebar__brand">
          <span className="icon icon--symbol">G</span>
          Glide
        </div>
        {entries.slice(0, NAV.length).map((n, i) => navButton(n, i))}
        {features.length > 0 && (
          <div className="sidebar__group" role="presentation">
            Features
          </div>
        )}
        {entries.slice(NAV.length).map((n, i) => navButton(n, i + NAV.length))}
      </nav>
      <main className="content">
        <div className="content__top drag">{isEditor ? "" : title}</div>
        <div className={`content__body ${isEditor ? "content__body--wide" : ""}`}>{body}</div>
      </main>
    </div>
  );
}
