import { useCallback, useEffect, useState } from "react";
import { glide } from "../../lib/glide";
import type { ScriptsState } from "../../../main/features/scripts/types";

const call = <T,>(method: string, ...args: unknown[]) => glide().feature<T>("scripts", method, ...args);

const MODE_LABEL: Record<string, string> = { fullOutput: "Full output", compact: "Compact", silent: "Silent", inline: "Inline" };

export function ScriptsSettings() {
  const [state, setState] = useState<ScriptsState | null>(null);
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (method: string, ...args: unknown[]) => {
    try {
      const s = await call<ScriptsState>(method, ...args);
      if (s && typeof s === "object" && "scripts" in s) {
        setState(s);
        setDir(s.directory);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void run("state");
    return glide().onFeatureEvent((e) => {
      if (e.feature === "scripts" && e.event === "changed") setState(e.payload as ScriptsState);
    });
  }, [run]);

  if (!state) return <div className="empty">Loading…</div>;
  const valid = state.scripts.filter((s) => !s.errors.length);
  const broken = state.scripts.filter((s) => s.errors.length);

  return (
    <div className="page scripts-settings">
      <p className="page__lead">
        Script Commands are executable files with <code>@raycast.</code> or <code>@glide.</code> metadata comments (title, mode, icon, arguments…). Glide watches the folder and lists them in search.
      </p>
      {error && <div className="error-banner">{error}</div>}

      <section className="group">
        <h3 className="group__title">Folder</h3>
        <form
          className="scripts-settings__dir"
          onSubmit={(e) => {
            e.preventDefault();
            void run("setDirectory", dir);
          }}
        >
          <input className="input mono" aria-label="Script Commands folder" value={dir} onChange={(e) => setDir(e.target.value)} />
          <button type="submit" className="btn">
            Use
          </button>
          <button type="button" className="btn" onClick={() => void run("chooseDirectory")}>
            Choose…
          </button>
        </form>
        <div className="scripts-settings__btns">
          {state.exists ? (
            <button type="button" className="btn btn--sm" onClick={() => void run("openFolder")}>
              Open in Finder
            </button>
          ) : (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void run("createFolder")}>
              Create Folder with Examples
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={() => void call("createScript").then(() => run("state"))}>
            New Script…
          </button>
          <button type="button" className="btn btn--sm" onClick={() => void run("reload")}>
            Reload
          </button>
        </div>
        {!state.exists && <p className="group__footer">The folder does not exist yet. It is created (with two example scripts) the first time you use it.</p>}
      </section>

      {broken.length > 0 && (
        <section className="group">
          <h3 className="group__title">Problems ({broken.length})</h3>
          <div className="table">
            {broken.map((s) => (
              <div key={s.id} className="trow scripts-settings__bad">
                <span className="scripts-settings__icon">⚠️</span>
                <div className="trow__main">
                  <div className="trow__title">{s.title ?? s.file}</div>
                  <div className="trow__sub mono">{s.file}</div>
                  <ul className="scripts-settings__errors">
                    {s.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
                <div className="trow__actions">
                  <button type="button" className="btn btn--sm" onClick={() => void call("openScript", s.id)}>
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="group">
        <h3 className="group__title">Script Commands ({valid.length})</h3>
        <div className="table">
          {valid.length === 0 && <div className="empty">No script commands found.</div>}
          {valid.map((s) => (
            <div key={s.id} className="trow">
              <span className="scripts-settings__icon">{s.icon && !/[./]/.test(s.icon) ? s.icon : "📜"}</span>
              <div className="trow__main">
                <div className="trow__title">
                  {s.title}
                  {s.packageName && <span className="tag">{s.packageName}</span>}
                </div>
                <div className="trow__sub">{s.description ?? s.file}</div>
              </div>
              <div className="trow__meta">
                {MODE_LABEL[s.mode ?? ""] ?? s.mode}
                {s.arguments.length ? ` · ${s.arguments.length} arg${s.arguments.length > 1 ? "s" : ""}` : ""}
              </div>
              <div className="trow__actions">
                <button type="button" className="btn btn--sm" onClick={() => void call("openScript", s.id)}>
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
