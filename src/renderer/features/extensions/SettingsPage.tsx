/** Settings → Extensions: installed extensions, install sources, store index URL, security note. */
import { useCallback, useEffect, useState } from "react";
import type { ExtensionSettings, ExtensionSummary } from "../../../main/features/extensions/contract";
import { Group, Row, Toggle } from "../../components/form";
import { Icon } from "../../components/Icon";
import { errorText, ext, SECURITY_NOTE, useExtEvent } from "./api";
import { FieldsForm } from "./FieldsForm";
import { prefFields, sourceLabel } from "./ManageViews";

export function SettingsPage() {
  const [list, setList] = useState<ExtensionSummary[]>([]);
  const [settings, setSettings] = useState<ExtensionSettings>({ storeUrl: "" });
  const [storeUrl, setStoreUrl] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [openPrefs, setOpenPrefs] = useState<string | null>(null);
  const [prefValues, setPrefValues] = useState<Record<string, string | boolean>>({});

  const load = useCallback(() => {
    void ext<ExtensionSummary[]>("list").then(setList);
  }, []);
  useEffect(() => {
    load();
    void ext<ExtensionSettings>("getSettings").then((s) => {
      setSettings(s);
      setStoreUrl(s.storeUrl);
    });
  }, [load]);
  useExtEvent("changed", load);

  const run = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setStatus(null);
    try {
      await fn();
      setStatus({ text: done });
    } catch (err) {
      setStatus({ text: errorText(err), error: true });
    } finally {
      setBusy(null);
    }
  };

  const togglePrefs = async (name: string) => {
    if (openPrefs === name) return setOpenPrefs(null);
    const state = await ext<{ values: Record<string, string | boolean> } | null>("getPreferences", name);
    setPrefValues(state?.values ?? {});
    setOpenPrefs(name);
  };

  return (
    <div className="extensions-settings">
      <p className="extensions-note extensions-note--box">{SECURITY_NOTE}</p>
      {status && <p className={status.error ? "extensions-error" : "extensions-ok"}>{status.text}</p>}

      <Group title="Installed" footer={list.length ? undefined : "No extensions yet — install one from the store below or with “Store” in the launcher."}>
        {list.map((e) => (
          <div key={e.name}>
            <Row
              label={
                <span className="extensions-settings__name">
                  <Icon icon={e.icon} /> {e.title} <span className="extensions-muted">v{e.version}</span>
                </span>
              }
              hint={e.errors?.length ? <span className="extensions-error">{e.errors[0]}</span> : `${e.commands.map((c) => c.title).join(", ")} · ${sourceLabel(e)}`}
            >
              <div className="extensions-settings__btns">
                {e.preferences.length > 0 && (
                  <button type="button" className="btn" onClick={() => void togglePrefs(e.name)}>
                    {openPrefs === e.name ? "Close" : e.missingPreferences.length ? "Set Up…" : "Preferences…"}
                  </button>
                )}
                <button type="button" className="btn" disabled={!!busy} onClick={() => void run(e.name, () => ext("update", e.name), `Updated ${e.title}`)}>
                  {busy === e.name ? "Updating…" : "Update"}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm(`Uninstall ${e.title}? Its preferences are removed too.`)) void run(e.name, () => ext("uninstall", e.name), `Uninstalled ${e.title}`);
                  }}
                >
                  Uninstall
                </button>
                <Toggle checked={e.enabled} label={`Enable ${e.title}`} onChange={(v) => void run(e.name, () => ext("setEnabled", e.name, v), v ? `Enabled ${e.title}` : `Disabled ${e.title}`)} />
              </div>
            </Row>
            {openPrefs === e.name && (
              <div className="extensions-settings__prefs">
                <FieldsForm
                  fields={prefFields(e.preferences)}
                  initial={prefValues}
                  submitTitle="Save Preferences"
                  onCancel={() => setOpenPrefs(null)}
                  onSubmit={async (values) => {
                    await run(e.name, () => ext("setPreferences", e.name, values), "Preferences saved");
                    setOpenPrefs(null);
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </Group>

      <Group title="Install" footer="A folder is copied into Glide; a git URL is cloned with `git clone --depth 1` (needs git) and can be updated with git pull.">
        <Row label="From a folder" hint="A folder containing package.json with a “glide” block">
          <button
            type="button"
            className="btn"
            disabled={!!busy}
            onClick={async () => {
              const dir = await ext<string | null>("pickFolder");
              if (dir) await run("folder", () => ext("install", { kind: "folder", path: dir }), "Extension installed");
            }}
          >
            Choose Folder…
          </button>
        </Row>
        <Row label="From a git URL" htmlFor="ext-git-url">
          <div className="extensions-settings__inline">
            <input
              id="ext-git-url"
              className="input"
              placeholder="https://github.com/you/extension.git"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && gitUrl.trim()) void run("git", () => ext("install", { kind: "git", url: gitUrl.trim() }), "Extension installed").then(() => setGitUrl(""));
              }}
            />
            <button type="button" className="btn btn--primary" disabled={!!busy || !gitUrl.trim()} onClick={() => void run("git", () => ext("install", { kind: "git", url: gitUrl.trim() }), "Extension installed").then(() => setGitUrl(""))}>
              {busy === "git" ? "Cloning…" : "Install"}
            </button>
          </div>
        </Row>
      </Group>

      <Group title="Store" footer="Glide has no backend: the store lists the bundled examples plus, optionally, a registry index JSON (an array of {name, title, description, author, icon, repo, version, commands}). It is fetched only when you open the store.">
        <Row label="Store index URL" htmlFor="ext-store-url">
          <div className="extensions-settings__inline">
            <input id="ext-store-url" className="input" placeholder="https://example.com/glide-index.json (optional)" value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={storeUrl.trim() === settings.storeUrl}
              onClick={() => void run("url", async () => setSettings(await ext<ExtensionSettings>("setSettings", { storeUrl })), "Store index URL saved")}
            >
              Save
            </button>
          </div>
        </Row>
        <Row label="Browse the store" hint="Opens “Store” in the launcher">
          <button type="button" className="btn" onClick={() => void ext("openStore")}>
            Open Store
          </button>
        </Row>
      </Group>
    </div>
  );
}
