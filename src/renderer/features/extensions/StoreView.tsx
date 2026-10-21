/** "extensions.store": browse the bundled index (+ the configured registry) and install with ⏎. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoreListing, StoreResponse } from "../../../main/features/extensions/contract";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import { glide } from "../../lib/glide";
import { ext, errorText, SECURITY_NOTE, useExtEvent } from "./api";

interface Row extends NavItem {
  entry: StoreListing;
}

const matches = (e: StoreListing, q: string) => {
  const hay = [e.title, e.name, e.description, e.author ?? "", ...e.commands.map((c) => c.title)].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

export function StoreView({ query, setPlaceholder, push, toast }: ViewProps) {
  const [resp, setResp] = useState<StoreResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      try {
        const r = await ext<StoreResponse>("store", refresh);
        setResp(r);
        if (r.remoteError) toast(`Store index: ${r.remoteError}`, "error");
      } catch (err) {
        toast(errorText(err), "error");
      }
    },
    [toast],
  );

  useEffect(() => {
    setPlaceholder("Search extensions…");
    void load(false);
  }, [load, setPlaceholder]);
  useExtEvent("changed", () => void load(false));

  const install = useCallback(
    async (e: StoreListing) => {
      if (busy) return;
      setBusy(e.name);
      toast(`${e.installed ? "Reinstalling" : "Installing"} ${e.title}…`);
      try {
        await ext("install", { kind: "store", name: e.name });
        toast(`Installed ${e.title}${e.commands[0] ? ` — search "${e.commands[0].title}"` : ""}`);
      } catch (err) {
        toast(errorText(err), "error");
      } finally {
        setBusy(null);
      }
    },
    [busy, toast],
  );

  const rows = useMemo<Row[]>(
    () => (resp?.entries ?? []).filter((e) => matches(e, query)).map((e) => ({ id: `${e.origin}:${e.name}`, section: e.origin === "bundled" ? "Bundled with Glide" : "Registry", entry: e })),
    [resp, query],
  );

  const actions = useCallback(
    (r: Row): NavAction[] => {
      const list: NavAction[] = [{ id: "install", title: r.entry.installed ? "Reinstall" : "Install", shortcut: "⏎", icon: "⬇️", run: () => install(r.entry) }];
      if (r.entry.repo) {
        const repo = r.entry.repo;
        if (/^https:\/\//.test(repo)) list.push({ id: "repo", title: "Open Repository", shortcut: "⌘O", icon: "🌐", run: () => ext("openUrl", repo.replace(/\.git$/, "")) });
      }
      list.push(
        { id: "refresh", title: "Refresh Store", shortcut: "⌘R", icon: "🔄", run: () => load(true) },
        { id: "url", title: "Install from Git URL…", icon: "🔗", run: () => push({ id: "extensions.installUrl", props: { title: "Install from Git URL" } }) },
        { id: "manage", title: "Manage Extensions", shortcut: "⌘M", icon: "🧩", run: () => push({ id: "extensions.manage" }) },
        { id: "settings", title: "Store Settings…", icon: "⚙️", run: () => glide().openSettings("extensions") },
      );
      return list;
    },
    [install, load, push],
  );

  if (!resp) return <div className="extensions-loading"><div className="glide-loading" aria-hidden="true" /></div>;
  return (
    <NavList<Row>
      items={rows}
      actionsTitle="Store"
      emptyText={query ? "No extensions match" : "The store is empty"}
      onActivate={(r) => void install(r.entry)}
      actions={actions}
      detail={(r) => (
        <div className="extensions-detailpane">
          <div className="extensions-store__head">
            <Icon icon={r.entry.icon} size="xl" />
            <div>
              <h2>{r.entry.title}</h2>
              <div className="extensions-muted">
                {r.entry.author ? `by ${r.entry.author}` : r.entry.name}
                {r.entry.version ? ` · v${r.entry.version}` : ""}
              </div>
            </div>
          </div>
          <p>{r.entry.description}</p>
          {r.entry.commands.length > 0 && (
            <>
              <h4>Commands</h4>
              <ul className="extensions-cmds">
                {r.entry.commands.map((c) => (
                  <li key={c.name}>
                    <strong>{c.title}</strong>
                    {c.description ? <span className="extensions-muted"> — {c.description}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="extensions-muted">{r.entry.origin === "bundled" ? "Installed by copying the bundled example." : `Installed with git clone from ${r.entry.repo}.`}</p>
          <p className="extensions-note">{SECURITY_NOTE}</p>
        </div>
      )}
      renderItem={(r, selected) => (
        <div className={`row ${selected ? "row--selected" : ""}`}>
          <Icon icon={r.entry.icon} />
          <div className="row__main">
            <span className="row__title">{r.entry.title}</span>
          </div>
          <div className="row__right">{busy === r.entry.name ? <span className="tag">Installing…</span> : r.entry.installed ? <span className="tag tag--accent">Installed</span> : null}</div>
        </div>
      )}
    />
  );
}
