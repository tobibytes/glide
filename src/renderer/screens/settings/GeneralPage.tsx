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

export function GeneralPage({ data, anchor }: { data: UserData; anchor?: string }) {
  const s = data.settings;
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
        <Row label="Global hotkey" hint="Press a combination to open Glide from anywhere" htmlFor="hotkey-recorder">
          <HotkeyRecorder id="hotkey-recorder" value={s.hotkey} onChange={(accel) => void patch({ hotkey: accel ?? "Alt+Space" })} />
        </Row>
        <Row label="Appearance" htmlFor="theme">
          <select id="theme" className="select" value={s.theme} onChange={(e) => void patch({ theme: e.target.value as Settings["theme"] })}>
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
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
