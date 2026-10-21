/** Launcher views for managing extensions: manage list, preferences, arguments, install from URL. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExecuteResult } from "@shared/ipc";
import type { FormFieldModel, FormValues } from "../../../extension-api/types";
import type { ExtensionSummary, PreferencesState, RaycastSupport } from "../../../main/features/extensions/contract";
import { prefKey, type PreferenceManifest } from "../../../main/features/extensions/manifest";
import type { NavAction, NavItem, ViewProps } from "../types";
import { NavList } from "../../components/NavList";
import { Icon } from "../../components/Icon";
import { glide } from "../../lib/glide";
import { applyResult, errorText, ext, SECURITY_NOTE, useExtEvent } from "./api";
import { FieldsForm } from "./FieldsForm";

/** Preference form fields; command-scoped ones are keyed "<command>/<name>" and labelled with the command. */
export function prefFields(prefs: PreferenceManifest[], commandTitle: (name: string) => string = (n) => n): FormFieldModel[] {
  return prefs.map((p) => ({
    id: prefKey(p),
    title: p.command ? `${p.title} (${commandTitle(p.command)})` : p.title,
    type: p.type === "textfield" ? "text" : p.type,
    required: p.required,
    default: p.default,
    info: p.description,
    placeholder: p.type === "checkbox" ? p.description : undefined,
    options: p.data,
  }));
}

export function sourceLabel(e: ExtensionSummary): string {
  const s = e.source;
  if (!s) return "Unknown source";
  if (s.kind === "folder") return `Folder: ${s.path}`;
  if (s.kind === "git") return `Git: ${s.url}`;
  if (s.kind === "raycast-folder") return `Raycast extension: ${s.path}`;
  return s.repo ? `Store (git): ${s.repo}` : "Store (bundled)";
}

// --- Manage -------------------------------------------------------------------------------

type Row = NavItem & ({ kind: "ext"; ext: ExtensionSummary } | { kind: "add"; title: string; icon: string; run(): void });

export function ManageView({ query, setPlaceholder, push, toast }: ViewProps) {
  const [list, setList] = useState<ExtensionSummary[] | null>(null);
  const confirmUninstall = useRef<{ name: string; at: number } | null>(null);

  const load = useCallback(() => {
    ext<ExtensionSummary[]>("list").then(setList, (err) => toast(errorText(err), "error"));
  }, [toast]);
  useEffect(() => {
    setPlaceholder("Search installed extensions…");
    load();
  }, [load, setPlaceholder]);
  useExtEvent("changed", load);

  const act = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      try {
        await fn();
        toast(done);
      } catch (err) {
        toast(errorText(err), "error");
      }
    },
    [toast],
  );

  const installFolder = useCallback(async () => {
    const dir = await ext<string | null>("pickFolder");
    if (dir) await act(() => ext("install", { kind: "folder", path: dir }), "Extension installed");
  }, [act]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const exts: Row[] = (list ?? [])
      .filter((e) => !q || `${e.title} ${e.name} ${e.description}`.toLowerCase().includes(q))
      .map((e) => ({ id: `ext:${e.name}`, section: "Installed", kind: "ext", ext: e }));
    const adds: Row[] = [
      { id: "add:store", section: "Add", kind: "add" as const, title: "Browse Store", icon: "🛍️", run: () => push({ id: "extensions.store", props: { title: "Store" } }) },
      { id: "add:folder", section: "Add", kind: "add" as const, title: "Install from Folder…", icon: "📂", run: () => void installFolder() },
      { id: "add:git", section: "Add", kind: "add" as const, title: "Install from Git URL…", icon: "🔗", run: () => push({ id: "extensions.installUrl", props: { title: "Install from Git URL" } }) },
      { id: "add:raycast", section: "Raycast", kind: "add" as const, title: "Import Raycast Extension Folder…", icon: "🔺", run: () => push({ id: "extensions.importRaycast", props: { title: "Import Raycast Extension" } }) },
      { id: "add:raycast-store", section: "Raycast", kind: "add" as const, title: "Install from Raycast Store…", icon: "🛒", run: () => push({ id: "extensions.importRaycast", props: { title: "Raycast Store", store: true } }) },
    ].filter((r) => !q || r.title.toLowerCase().includes(q));
    return [...exts, ...adds];
  }, [list, query, push, installFolder]);

  const toggle = useCallback((e: ExtensionSummary) => act(() => ext("setEnabled", e.name, !e.enabled), e.enabled ? `Disabled ${e.title}` : `Enabled ${e.title}`), [act]);

  const actions = useCallback(
    (r: Row): NavAction[] => {
      if (r.kind === "add") return [{ id: "go", title: r.title, shortcut: "⏎", run: r.run }];
      const e = r.ext;
      const list: NavAction[] = [{ id: "toggle", title: e.enabled ? "Disable Extension" : "Enable Extension", shortcut: "⏎", icon: e.enabled ? "⏸️" : "▶️", run: () => toggle(e) }];
      if (e.preferences.length) list.push({ id: "prefs", title: "Configure Preferences", shortcut: "⌘,", icon: "⚙️", run: () => push({ id: "extensions.preferences", props: { name: e.name, title: `${e.title} Preferences` } }) });
      list.push(
        { id: "update", title: e.isGit ? "Update (git pull)" : "Update (re-copy)", shortcut: "⌘U", icon: "🔄", run: () => act(() => ext("update", e.name), `Updated ${e.title}`) },
        { id: "reveal", title: "Show in Finder", shortcut: "⇧⌘F", icon: "📂", run: () => void ext("reveal", e.name) },
        { id: "settings", title: "Open Extensions Settings", icon: "⚙️", run: () => glide().openSettings("extensions") },
        {
          id: "uninstall",
          title: "Uninstall Extension",
          shortcut: "⌃X",
          icon: "🗑️",
          destructive: true,
          run: () => {
            const c = confirmUninstall.current;
            if (!c || c.name !== e.name || Date.now() - c.at > 4000) {
              confirmUninstall.current = { name: e.name, at: Date.now() };
              toast(`Press ⌃X again to uninstall ${e.title}`);
              return;
            }
            confirmUninstall.current = null;
            void act(() => ext("uninstall", e.name), `Uninstalled ${e.title}`);
          },
        },
      );
      return list;
    },
    [act, push, toast, toggle],
  );

  if (!list) return <div className="extensions-loading"><div className="glide-loading" aria-hidden="true" /></div>;
  return (
    <NavList<Row>
      items={rows}
      actionsTitle="Extension"
      emptyText="No extensions installed"
      onActivate={(r) => (r.kind === "add" ? r.run() : void toggle(r.ext))}
      actions={actions}
      detail={(r) =>
        r.kind === "add" ? (
          <div className="extensions-detailpane">
            <p>
              {r.id === "add:store"
                ? "Browse the extensions bundled with Glide and any registry configured in Settings."
                : r.id === "add:folder"
                  ? "Copy a local extension folder (with a package.json \"glide\" block) into Glide. Raycast-style folders are imported automatically."
                  : r.id === "add:raycast"
                    ? "Build a Raycast extension from a folder on this Mac (its package.json, src/*.tsx and node_modules) and add its commands to Glide."
                    : r.id === "add:raycast-store"
                      ? "Find an extension on raycast.com, download its source yourself, then import the folder."
                      : "Clone a repository with git and install it."}
            </p>
            <p className="extensions-note">{SECURITY_NOTE}</p>
          </div>
        ) : (
          <div className="extensions-detailpane">
            <h2>{r.ext.title}</h2>
            <p>{r.ext.description}</p>
            {r.ext.errors?.length ? <pre className="extensions-error">{r.ext.errors.join("\n")}</pre> : null}
            {r.ext.missingPreferences.length > 0 && <p className="extensions-warn">Needs setup: {r.ext.missingPreferences.join(", ")} (⌘,)</p>}
            {r.ext.runtime === "raycast" && <p className="extensions-muted">Raycast extension (runs through Glide&apos;s @raycast/api compatibility layer)</p>}
            {r.ext.warnings?.map((w) => (
              <p key={w} className="extensions-warn">
                {w}
              </p>
            ))}
            <h4>Commands</h4>
            <ul className="extensions-cmds">
              {r.ext.commands.map((c) => (
                <li key={c.name}>
                  <strong>{c.title}</strong> <span className="extensions-muted">{c.mode === "no-view" ? "· runs without a view" : ""}</span>
                </li>
              ))}
            </ul>
            <p className="extensions-muted">
              v{r.ext.version}
              {r.ext.author ? ` · ${r.ext.author}` : ""} · {sourceLabel(r.ext)}
            </p>
          </div>
        )
      }
      renderItem={(r, selected) => (
        <div className={`row ${selected ? "row--selected" : ""}`}>
          {r.kind === "add" ? <Icon icon={{ kind: "emoji", value: r.icon }} /> : <Icon icon={r.ext.icon} />}
          <div className="row__main">
            <span className="row__title">{r.kind === "add" ? r.title : r.ext.title}</span>
          </div>
          {r.kind === "ext" && (
            <div className="row__right">
              {r.ext.errors?.length ? <span className="tag">Invalid</span> : !r.ext.enabled ? <span className="tag">Disabled</span> : r.ext.missingPreferences.length ? <span className="tag tag--accent">Needs setup</span> : null}
            </div>
          )}
        </div>
      )}
    />
  );
}

// --- Preferences --------------------------------------------------------------------------

export function PreferencesView({ props, setPlaceholder, push, pop, close, toast }: ViewProps) {
  const name = String(props.name ?? "");
  const then = props.then as { command: string; argument: string | null } | undefined;
  const [state, setState] = useState<PreferencesState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPlaceholder("");
    ext<PreferencesState | null>("getPreferences", name).then((s) => (s ? setState(s) : toast("Extension not found", "error")), (err) => toast(errorText(err), "error"));
  }, [name, setPlaceholder, toast]);

  const submit = async (values: FormValues) => {
    setBusy(true);
    try {
      await ext("setPreferences", name, values);
      if (then) applyResult(await ext<ExecuteResult>("runCommand", name, then.command, then.argument ?? undefined), { push, pop, close, toast });
      else {
        toast("Preferences saved");
        pop();
      }
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <div className="extensions-loading"><div className="glide-loading" aria-hidden="true" /></div>;
  return (
    <FieldsForm
      fields={prefFields(state.preferences, (n) => state.commands?.find((c) => c.name === n)?.title ?? n)}
      initial={state.values}
      busy={busy}
      submitTitle={then ? "Save and Run" : "Save Preferences"}
      description={then ? `${state.title} needs a few settings before it can run.` : `Preferences for ${state.title}.`}
      onSubmit={submit}
      onCancel={pop}
    />
  );
}

// --- Arguments ----------------------------------------------------------------------------

export function ArgumentsView({ props, setPlaceholder, push, pop, close, toast }: ViewProps) {
  const name = String(props.name ?? "");
  const command = String(props.command ?? "");
  const initial = (props.values ?? {}) as FormValues;
  const [fields, setFields] = useState<FormFieldModel[] | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPlaceholder("");
    ext<ExtensionSummary[]>("list").then((list) => {
      const cmd = list.find((e) => e.name === name)?.commands.find((c) => c.name === command);
      if (!cmd) return toast("Command not found", "error");
      setTitle(cmd.title);
      setFields(
        cmd.arguments.map((a) => ({
          id: a.name,
          title: a.placeholder ?? a.name,
          placeholder: a.placeholder,
          type: a.type === "password" ? ("password" as const) : a.type === "dropdown" ? ("dropdown" as const) : ("text" as const),
          required: a.required,
          options: a.data ?? [],
        })),
      );
    }, (err) => toast(errorText(err), "error"));
  }, [name, command, setPlaceholder, toast]);

  if (!fields) return <div className="extensions-loading"><div className="glide-loading" aria-hidden="true" /></div>;
  return (
    <FieldsForm
      fields={fields}
      initial={initial}
      busy={busy}
      submitTitle={`Run ${title}`}
      onCancel={pop}
      onSubmit={async (values) => {
        setBusy(true);
        try {
          const args = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));
          applyResult(await ext<ExecuteResult>("runCommand", name, command, args), { push, pop, close, toast });
        } catch (err) {
          toast(errorText(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

// --- Install from URL -----------------------------------------------------------------------

export function InstallUrlView({ setPlaceholder, pop, toast }: ViewProps) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setPlaceholder(""), [setPlaceholder]);
  return (
    <FieldsForm
      fields={[{ id: "url", title: "Repository URL", type: "text", placeholder: "https://github.com/you/glide-extension.git", required: true, options: [] }]}
      busy={busy}
      submitTitle="Clone and Install"
      description={<span className="extensions-note">Runs `git clone --depth 1`. {SECURITY_NOTE}</span>}
      onCancel={pop}
      onSubmit={async (v) => {
        setBusy(true);
        try {
          const res = await ext<ExtensionSummary>("install", { kind: "git", url: String(v.url) });
          toast(`Installed ${res.title}`);
          pop();
        } catch (err) {
          toast(errorText(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

// --- Import a Raycast extension ---------------------------------------------------------------

type ImportRow = NavItem & { title: string; icon: string; run(): void };

export const RAYCAST_IMPORT_WARNING =
  "Importing runs that folder's code: Glide bundles its src/ files and their node_modules, and every command runs with your user's privileges (files, network, programs). Only import extensions whose source you trust. Glide never downloads packages — if dependencies are missing, run npm install in the folder yourself first.";

export function RaycastImportView({ props, setPlaceholder, pop, toast }: ViewProps) {
  const store = props.store === true;
  const [support, setSupport] = useState<RaycastSupport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPlaceholder("");
    ext<RaycastSupport>("raycastSupport").then(setSupport, () => setSupport({ canBuild: false, storeUrl: "https://www.raycast.com/store" }));
  }, [setPlaceholder]);

  const importFolder = useCallback(async () => {
    if (busy) return;
    const dir = await ext<string | null>("pickFolder", "Choose a Raycast extension folder", "Import");
    if (!dir) return;
    setBusy(true);
    setError(null);
    try {
      const res = await ext<ExtensionSummary>("install", { kind: "raycast-folder", path: dir });
      toast(`Imported ${res.title} (${res.commands.length} command${res.commands.length === 1 ? "" : "s"})`);
      pop();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, [busy, pop, toast]);

  const rows: ImportRow[] = [
    { id: "import", title: busy ? "Importing…" : "Choose Raycast Extension Folder…", icon: "📂", run: () => void importFolder() },
    { id: "store", title: "Open the Raycast Store in Your Browser", icon: "🌐", run: () => void ext("openRaycastStore") },
  ];
  if (store) rows.reverse();

  return (
    <NavList<ImportRow>
      items={rows}
      actionsTitle="Raycast"
      onActivate={(r) => r.run()}
      actions={(r) => [{ id: r.id, title: r.title, shortcut: "⏎", run: r.run }]}
      detail={() => (
        <div className="extensions-detailpane">
          <h2>{store ? "Raycast Store" : "Import a Raycast extension"}</h2>
          {store ? (
            <p>
              Glide does not download extensions automatically. Open the store, pick an extension, get its source yourself, run <code>npm install</code> in it, then choose{" "}
              <strong>Choose Raycast Extension Folder…</strong>.
            </p>
          ) : (
            <p>Pick a folder containing a Raycast extension&apos;s package.json. Glide bundles each command&apos;s src/&lt;command&gt;.tsx and maps @raycast/api and @raycast/utils to its own implementation.</p>
          )}
          <p className="extensions-warn">{RAYCAST_IMPORT_WARNING}</p>
          {support && !support.canBuild && (
            <p className="extensions-warn">This build of Glide cannot compile TypeScript/JSX (esbuild is not bundled). Folders with a pre-built dist/ (from `ray build`) still import.</p>
          )}
          {error && <pre className="extensions-error">{error}</pre>}
        </div>
      )}
      renderItem={(r, selected) => (
        <div className={`row ${selected ? "row--selected" : ""}`}>
          <Icon icon={{ kind: "emoji", value: r.icon }} />
          <div className="row__main">
            <span className="row__title">{r.title}</span>
          </div>
        </div>
      )}
    />
  );
}
