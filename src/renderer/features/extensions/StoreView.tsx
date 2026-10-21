/**
 * "extensions.store": browse the store index (bundled examples + the remote index), filter by
 * category, and install / update / uninstall after an in-launcher confirmation. The remote index is
 * fetched only when this view opens (cached) or on Refresh (⌘R).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { StoreInstallResult, StoreItem, StoreState } from "../../../main/features/extensions/store-contract";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import { glide } from "../../lib/glide";
import { applyResult, errorText, ext, useExtEvent } from "./api";
import { StoreConfirm, type StoreConfirmRequest } from "./StoreConfirm";
import "./StoreView.css";

interface Row extends NavItem {
  item: StoreItem;
}

type Op = "install" | "update" | "uninstall";

const ALL = "All Categories";

const fmtSize = (n?: number) => (!n ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function matches(e: StoreItem, q: string): boolean {
  const hay = [e.title, e.name, e.description, e.author, ...e.categories, ...e.commands.map((c) => c.title)].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

const sectionOf = (e: StoreItem) => (e.updateAvailable ? "Updates Available" : e.installed ? "Installed" : "Available");
const SECTION_ORDER = ["Updates Available", "Installed", "Available"];

const THIRD_PARTY =
  "Extensions are third-party code. They run with your user's privileges in a separate process and can read your files and use the network. Only continue if you trust the author.";

function confirmFor(op: Op, e: StoreItem): StoreConfirmRequest {
  if (op === "uninstall")
    return { title: `Uninstall ${e.title}?`, message: "Its files, preferences and commands are removed from Glide.", confirmTitle: "Uninstall", destructive: true };
  const where = e.via === "bundled" ? "Copies the extension bundled with Glide (no download)." : `Downloads ${fmtSize(e.size)} and verifies its SHA-256 checksum before installing.`;
  return {
    title: op === "update" ? `Update ${e.title} to v${e.version}?` : `Install ${e.title} by ${e.author}?`,
    message: THIRD_PARTY,
    detail: `${where} ${e.commands.length} command${e.commands.length === 1 ? "" : "s"}: ${e.commands.map((c) => c.title).join(", ")}.`,
    confirmTitle: op === "update" ? "Update" : "Install",
  };
}

/** Screenshots are fetched by main (store-listed URLs only) and shown as data: URLs. */
function Screenshot({ id, url }: { id: string; url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setSrc(null);
    setFailed(false);
    ext<string>("storeScreenshot", id, url).then(
      (s) => live && setSrc(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [id, url]);
  if (failed) return <div className="extensions-store-shot extensions-store-shot--missing">Screenshot unavailable</div>;
  return src ? <img className="extensions-store-shot" src={src} alt="Screenshot" /> : <div className="extensions-store-shot extensions-store-shot--loading" />;
}

function Detail({ e }: { e: StoreItem }) {
  const newer = e.installedVersion ? e.changelog.filter((c) => !e.installedVersion || c.version !== e.installedVersion) : e.changelog;
  return (
    <div className="extensions-detailpane extensions-store-detail">
      <div className="extensions-store__head">
        <Icon icon={e.icon} size="xl" />
        <div>
          <h2>{e.title}</h2>
          <div className="extensions-muted">
            by {e.author} · v{e.version}
            {e.kind === "raycast" ? " · Raycast extension" : ""}
          </div>
        </div>
      </div>
      {e.installed && (
        <div className={`extensions-store-status ${e.updateAvailable ? "extensions-store-status--update" : ""}`} data-status>
          {e.updateAvailable ? `Installed v${e.installedVersion} — v${e.version} available — ⏎ to update` : `Installed v${e.installedVersion ?? "?"}${e.installedFromStore ? "" : " (from a folder or git, not the store)"}`}
        </div>
      )}
      {e.unavailable && <div className="extensions-store-status extensions-store-status--bad">{e.unavailable}</div>}
      <p>{e.description}</p>
      {e.categories.length > 0 && (
        <div className="extensions-store-tags">
          {e.categories.map((c) => (
            <span key={c} className="tag">
              {c}
            </span>
          ))}
        </div>
      )}
      <h4>Commands</h4>
      <ul className="extensions-cmds">
        {e.commands.map((c) => (
          <li key={c.name}>
            <strong>{c.title}</strong>
            {c.description ? <span className="extensions-muted"> — {c.description}</span> : null}
          </li>
        ))}
      </ul>
      {e.screenshots.length > 0 && (
        <>
          <h4>Screenshots</h4>
          <div className="extensions-store-shots">
            {e.screenshots.map((u) => (
              <Screenshot key={u} id={e.id} url={u} />
            ))}
          </div>
        </>
      )}
      {newer.length > 0 && (
        <>
          <h4>{e.updateAvailable ? "What's New" : "Changelog"}</h4>
          <ul className="extensions-store-changelog">
            {newer.slice(0, 5).map((c) => (
              <li key={c.version}>
                <strong>v{c.version}</strong>
                {c.date ? <span className="extensions-muted"> · {c.date}</span> : null}
                <div>{c.notes}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="extensions-muted extensions-store-source">
        {e.via === "bundled" ? "Bundled with Glide — installs without network." : e.via === "download" ? `Download ${fmtSize(e.size)}, verified by SHA-256.` : ""}
        {e.license ? ` License: ${e.license}.` : ""}
      </p>
    </div>
  );
}

export function StoreView(view: ViewProps) {
  const { query, setPlaceholder, push, toast } = view;
  const [state, setState] = useState<StoreState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState(ALL);
  const [confirm, setConfirm] = useState<{ op: Op; item: StoreItem } | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      try {
        const s = await ext<StoreState>("storeList", refresh);
        setState(s);
        if (refresh) toast(s.error ? `Store index: ${s.error}` : `Store refreshed — ${s.items.length} extensions`, s.error ? "error" : "info");
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    setPlaceholder("Search extensions…");
    void load(false);
  }, [load, setPlaceholder]);
  useExtEvent("changed", () => void load(false));

  const categories = useMemo(() => [ALL, ...(state?.categories ?? [])], [state]);
  const cycle = useCallback(
    (dir: 1 | -1) => setCategory((c) => categories[(categories.indexOf(c) + dir + categories.length) % categories.length] ?? ALL),
    [categories],
  );

  const perform = useCallback(
    async (op: Op, e: StoreItem) => {
      setBusy(e.id);
      try {
        if (op === "uninstall") {
          await ext("storeUninstall", e.id);
          toast(`Uninstalled ${e.title}`);
        } else {
          const r = await ext<StoreInstallResult>(op === "update" ? "storeUpdate" : "storeInstall", e.id, true);
          toast(`${op === "update" ? "Updated" : "Installed"} ${r.title} v${r.version}${r.firstCommand ? ` — search "${r.firstCommand}"` : ""}`);
        }
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        setBusy(null);
        void load(false);
      }
    },
    [load, toast],
  );

  const ask = useCallback(
    (op: Op, e: StoreItem) => {
      if (busy) return toast(`Busy — wait for the current ${busy} operation`, "error");
      if (op !== "uninstall" && e.unavailable) return toast(`${e.title}: ${e.unavailable}`, "error");
      setConfirm({ op, item: e });
    },
    [busy, toast],
  );

  const runFirst = useCallback(
    async (e: StoreItem) => {
      const cmd = e.commands[0];
      if (!cmd) return;
      try {
        applyResult(await ext<ExecuteResult>("runCommand", e.name, cmd.name), view, false);
      } catch (err) {
        toast(errorText(err), "error");
      }
    },
    [toast, view],
  );

  const rows = useMemo<Row[]>(() => {
    const list = (state?.items ?? []).filter((e) => (category === ALL || e.categories.includes(category)) && matches(e, query));
    return list
      .map((e) => ({ id: e.id, section: sectionOf(e), item: e }))
      .sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.item.title.localeCompare(b.item.title));
  }, [state, category, query]);

  const actions = useCallback(
    (r: Row): NavAction[] => {
      const e = r.item;
      const list: NavAction[] = [];
      if (e.updateAvailable) list.push({ id: "update", title: `Update to v${e.version}`, shortcut: "⏎", icon: "⬆️", run: () => ask("update", e) });
      if (e.installed && e.commands[0]) list.push({ id: "run", title: `Run “${e.commands[0].title}”`, shortcut: e.updateAvailable ? "⌘⏎" : "⏎", icon: "▶️", run: () => runFirst(e) });
      if (!e.installed) list.push({ id: "install", title: "Install Extension", shortcut: "⏎", icon: "⬇️", run: () => ask("install", e) });
      if (e.installed && !e.updateAvailable && e.via) list.push({ id: "reinstall", title: "Reinstall", icon: "🔁", run: () => ask("install", e) });
      if (e.installed) list.push({ id: "uninstall", title: "Uninstall", shortcut: "⌃X", icon: "🗑️", destructive: true, run: () => ask("uninstall", e) });
      if (e.homepage && /^https:\/\//.test(e.homepage)) {
        const url = e.homepage;
        list.push({ id: "homepage", title: "Open Homepage", shortcut: "⌘O", icon: "🌐", run: () => ext("openUrl", url) });
      }
      list.push(
        { id: "refresh", title: "Refresh Store", shortcut: "⌘R", icon: "🔄", run: () => load(true) },
        { id: "next-cat", title: "Next Category", shortcut: "⌘]", icon: "🏷️", run: () => cycle(1) },
        { id: "prev-cat", title: "Previous Category", shortcut: "⌘[", icon: "🏷️", run: () => cycle(-1) },
        ...categories.map((c) => ({ id: `cat:${c}`, title: c === ALL ? "Show All Categories" : `Category: ${c}`, icon: c === category ? "✅" : "▫️", run: () => setCategory(c) })),
        { id: "manage", title: "Manage Extensions", shortcut: "⌘M", icon: "🧩", run: () => push({ id: "extensions.manage", props: { title: "Manage Extensions" } }) },
        { id: "settings", title: "Store Settings…", shortcut: "⌘,", icon: "⚙️", run: () => glide().openSettings("extensions") },
      );
      return list;
    },
    [ask, runFirst, load, cycle, categories, category, push],
  );

  const onActivate = useCallback(
    (r: Row) => {
      const e = r.item;
      if (e.updateAvailable) ask("update", e);
      else if (e.installed) void runFirst(e);
      else ask("install", e);
    },
    [ask, runFirst],
  );

  if (!state) return <div className="extensions-loading"><div className="glide-loading" aria-hidden="true" /></div>;
  return (
    <div className="extensions-store">
      <div className="extensions-store-bar" aria-label="Categories">
        {categories.map((c) => (
          <button type="button" key={c} tabIndex={-1} className={`extensions-store-chip ${c === category ? "extensions-store-chip--on" : ""}`} onClick={() => setCategory(c)}>
            {c}
          </button>
        ))}
        <span className="extensions-store-bar__hint">
          <kbd className="kbd">⌘[</kbd> <kbd className="kbd">⌘]</kbd> category · <kbd className="kbd">⌘R</kbd> refresh
        </span>
      </div>
      {state.error && (
        <div className="extensions-store-banner" role="status">
          {state.fromCache ? "Showing the cached index — " : "Only bundled extensions are shown — "}
          {state.error}
        </div>
      )}
      <NavList<Row>
        items={rows}
        className="extensions-store-list"
        actionsTitle="Store"
        emptyText={loading ? "Loading…" : query || category !== ALL ? "No extensions match" : "The store is empty"}
        onActivate={onActivate}
        actions={actions}
        detail={(r) => <Detail e={r.item} />}
        renderItem={(r, selected) => (
          <div className={`row ${selected ? "row--selected" : ""}`} data-store-id={r.item.id}>
            <Icon icon={r.item.icon} />
            <div className="row__main">
              <span className="row__title">{r.item.title}</span>
            </div>
            <div className="row__right">
              {busy === r.item.id ? (
                <span className="tag">Working…</span>
              ) : r.item.updateAvailable ? (
                <span className="tag tag--accent" data-badge="update">
                  Update
                </span>
              ) : r.item.installed ? (
                <span className="tag tag--accent" data-badge="installed">
                  Installed
                </span>
              ) : r.item.unavailable ? (
                <span className="tag">Unavailable</span>
              ) : null}
              {r.item.kind === "raycast" && <span className="tag">Raycast</span>}
            </div>
          </div>
        )}
      />
      {confirm && (
        <StoreConfirm
          req={confirmFor(confirm.op, confirm.item)}
          onAnswer={(ok) => {
            const c = confirm;
            setConfirm(null);
            if (ok) void perform(c.op, c.item);
          }}
        />
      )}
    </div>
  );
}
