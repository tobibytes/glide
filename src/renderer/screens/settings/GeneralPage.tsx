import { useEffect, useState } from "react";
import type { Settings, UserData } from "@shared/types";
import { glide } from "../../lib/glide";
import { Group, Row, Stepper, Toggle } from "../../components/form";
import { HotkeyRecorder } from "../../components/HotkeyRecorder";
import { navigateTo } from "../../lib/route";

const SOURCES: Array<{ id: string; label: string }> = [
  { id: "apps", label: "Applications" },
  { id: "system", label: "System commands" },
  { id: "workflows", label: "Workflows" },
  { id: "quicklinks", label: "Quicklinks" },
  { id: "snippets", label: "Snippets" },
  { id: "files", label: "Files" },
  { id: "calculator", label: "Calculator" },
];

interface HotkeyStatus {
  backend: "pending" | "native" | "electron";
  hotkeys: Array<{ id: string; accelerator: string; state: "pending" | "active" | "failed"; reason?: string; warning?: string }>;
}

/** Problem with the launcher hotkey (e.g. "in use by another app"), from main's hotkey manager. */
function useLauncherHotkeyProblem(hotkey: string): { text: string; severity: "error" | "warning" } | null {
  const [problem, setProblem] = useState<{ text: string; severity: "error" | "warning" } | null>(null);
  useEffect(() => {
    let live = true;
    void glide()
      .feature<HotkeyStatus>("glide", "hotkeyStatus")
      .then((st) => {
        if (!live) return;
        const h = st.hotkeys.find((x) => x.id.startsWith("core:") && x.accelerator === hotkey);
        if (h?.state === "failed") setProblem({ text: h.reason === "in use by another app" ? "In use by another app — choose a different shortcut." : `Not registered: ${h.reason ?? "unknown error"}`, severity: "error" });
        else if (h?.warning) setProblem({ text: `${h.warning}`, severity: "warning" });
        else setProblem(null);
      })
      .catch(() => live && setProblem(null));
    return () => {
      live = false;
    };
  }, [hotkey]);
  return problem;
}

export function GeneralPage({ data, anchor }: { data: UserData; anchor?: string }) {
  const s = data.settings;
  const hotkeyProblem = useLauncherHotkeyProblem(s.hotkey);
  const [newDir, setNewDir] = useState("");
  const [error, setError] = useState<string | null>(null);

  const patch = async (p: Partial<Settings>) => {
    try {
      await glide().setSettings(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (anchor === "hotkey") document.getElementById("hotkey-recorder")?.focus();
  }, [anchor]);

  const toggleSource = (id: string, enabled: boolean) => {
    const set = new Set(s.disabledSources);
    if (enabled) set.delete(id);
    else set.add(id);
    void patch({ disabledSources: Array.from(set) });
  };

  return (
    <div className="page">
      {error && <div className="error-banner">{error}</div>}
      <Group title="Launcher">
        <Row
          label="Global hotkey"
          hint={
            hotkeyProblem ? (
              <span role="status" style={{ color: hotkeyProblem.severity === "error" ? "var(--danger)" : "var(--warning)" }}>
                {hotkeyProblem.text}
              </span>
            ) : (
              "Press a combination, or tap a modifier alone (Right ⌥) or twice (Double ⌘)"
            )
          }
          htmlFor="hotkey-recorder"
        >
          <HotkeyRecorder id="hotkey-recorder" allowModifierOnly value={s.hotkey} onChange={(accel) => void patch({ hotkey: accel ?? "Alt+Space" })} />
        </Row>
        <Row label="Appearance" htmlFor="theme">
          <select id="theme" className="select" value={s.theme} onChange={(e) => void patch({ theme: e.target.value as Settings["theme"] })}>
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Row>
        <Row label="Keep open after running a command" hint="Glide stays open after a command runs. Commands that open an app, file or link still close it.">
          <Toggle label="Keep open after running" checked={s.keepOpenAfterRun} onChange={(v) => void patch({ keepOpenAfterRun: v })} />
        </Row>
        <Row label="Hide when it loses focus" hint="Clicking outside the launcher closes it">
          <Toggle label="Hide on blur" checked={s.hideOnBlur} onChange={(v) => void patch({ hideOnBlur: v })} />
        </Row>
        <Row label="Launch at login" hint="Start Glide when you log in to your Mac">
          <Toggle label="Launch at login" checked={s.launchAtLogin} onChange={(v) => void patch({ launchAtLogin: v })} />
        </Row>
      </Group>

      <Group title="Keyboard">
        <Row
          label="Vim mode"
          hint={
            <>
              Esc enters NORMAL mode: j/k move, gg/G jump, l opens, h goes back, i types.{" "}
              <button type="button" className="linkbtn" onClick={() => navigateTo("about", undefined, "vim")}>
                Cheat sheet
              </button>
            </>
          }
        >
          <Toggle label="Vim mode" checked={s.vimMode} onChange={(v) => void patch({ vimMode: v })} />
        </Row>
      </Group>

      <Group title="Search">
        <Row label="Search files" hint="Include Spotlight file results">
          <Toggle label="File search" checked={s.fileSearch} onChange={(v) => void patch({ fileSearch: v })} />
        </Row>
        <Row label="Calculator" hint="Evaluate expressions inline">
          <Toggle label="Calculator" checked={s.calculator} onChange={(v) => void patch({ calculator: v })} />
        </Row>
        <Row label="Results per section">
          <Stepper value={s.sectionLimit} min={1} max={30} onChange={(v) => void patch({ sectionLimit: v })} />
        </Row>
        <Row label="Usage half-life" hint="How fast usage history fades">
          <div className="slider">
            <input type="range" min={1} max={30} step={1} value={s.frecencyHalfLifeDays} aria-label="Usage half-life in days" onChange={(e) => void patch({ frecencyHalfLifeDays: Number(e.target.value) })} />
            <span className="slider__value">{s.frecencyHalfLifeDays} {s.frecencyHalfLifeDays === 1 ? "day" : "days"}</span>
          </div>
        </Row>
      </Group>

      <Group title="Sources" footer="Unchecked sources are hidden from search results.">
        <Row label="Enabled sources" align="start">
          <div className="checks">
            {SOURCES.map((src) => (
              <label key={src.id} className="check">
                <input type="checkbox" checked={!s.disabledSources.includes(src.id)} onChange={(e) => toggleSource(src.id, e.target.checked)} />
                {src.label}
              </label>
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Applications" footer="Folders scanned for .app bundles. Changes take effect on the next rescan.">
        <Row label="Directories" align="start">
          <div className="list-edit">
            {s.appDirectories.map((dir) => (
              <div key={dir} className="list-edit__item">
                <span title={dir}>{dir}</span>
                <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove ${dir}`} onClick={() => void patch({ appDirectories: s.appDirectories.filter((d) => d !== dir) })}>
                  Remove
                </button>
              </div>
            ))}
            <form
              className="list-edit__add"
              onSubmit={(e) => {
                e.preventDefault();
                const v = newDir.trim();
                if (!v || s.appDirectories.includes(v)) return;
                void patch({ appDirectories: [...s.appDirectories, v] });
                setNewDir("");
              }}
            >
              <input className="input mono" placeholder="/path/to/folder" value={newDir} onChange={(e) => setNewDir(e.target.value)} aria-label="New application directory" />
              <button type="submit" className="btn btn--sm" disabled={!newDir.trim()}>
                Add
              </button>
            </form>
          </div>
        </Row>
      </Group>
    </div>
  );
}
