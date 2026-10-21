import type { UserData } from "@shared/types";
import { accelToDisplay } from "../../lib/keys";
import { Kbd } from "../../components/Kbd";
import { Group } from "../../components/form";
import { useEffect, useState } from "react";
import { VIM_CHEATSHEET } from "../../lib/vim";


const CHEATS: Array<[string, string]> = [
  ["Open / run", "⏎"],
  ["Secondary action", "⌘⏎"],
  ["Action panel", "⌘K"],
  ["Accept argument", "⇥"],
  ["Jump to item 1–9", "⌘1"],
  ["Next / previous section", "⌘↓"],
  ["Page down / up", "⌥↓"],
  ["Previous search", "↑"],
  ["Clear query / close", "⎋"],
  ["Back from a view", "⌫"],
  ["Ask AI about the query", "⇥"],
  ["Switch settings page", "⌘1"],
  ["Toggle favorite", "⇧⌘F"],
  ["Edit item", "⌘E"],
  ["Save workflow", "⌘S"],
  ["Run workflow", "⌘R"],
  ["Duplicate action", "⌘D"],
];

export function AboutPage({ data, anchor }: { data: UserData; anchor?: string }) {
  const [version, setVersion] = useState("…");
  useEffect(() => {
    window.glide
      .feature<{ version: string }>("app", "info")
      .then((i) => setVersion(i.version))
      .catch(() => setVersion("unknown"));
  }, []);
  useEffect(() => {
    if (anchor) document.getElementById(`about-${anchor}`)?.scrollIntoView({ block: "start" });
  }, [anchor]);
  return (
    <div className="page about">
      <div className="about__hero">
        <span className="icon icon--xl" style={{ background: "var(--accent-soft)", color: "var(--accent-text)", fontWeight: 700, fontSize: 28 }}>
          G
        </span>
        <div>
          <div className="about__name">Glide</div>
          <div className="muted">
            Version {version} · Press <Kbd keys={accelToDisplay(data.settings.hotkey)} /> to open
          </div>
        </div>
      </div>
      <p className="page__lead">
        A keyboard-first launcher for macOS with a Shortcuts-style workflow builder. Search apps, run system commands, open quicklinks, paste snippets, and chain actions into workflows that take input from the
        launcher.
      </p>
      <Group title="Keyboard">
        <div className="cheats" style={{ padding: "6px 14px" }}>
          {CHEATS.map(([label, keys]) => (
            <div key={label} className="cheat">
              <span>{label}</span>
              <Kbd keys={keys} />
            </div>
          ))}
        </div>
      </Group>
      <div id="about-vim" className="cheat-anchor">
        <Group title={data.settings.vimMode ? "Vim mode (on)" : "Vim mode (off — turn it on in General)"} footer="⌃J/⌃K, ⌃N/⌃P and ⌃D/⌃U work while typing too. Every list in Glide, including feature views, uses these keys.">
          <div className="cheats" style={{ padding: "6px 14px" }}>
            {VIM_CHEATSHEET.map(([label, keys]) => (
              <div key={label} className="cheat">
                <span>{label}</span>
                <Kbd keys={keys} />
              </div>
            ))}
          </div>
        </Group>
      </div>
      <Group title="Data">
        <div className="row row--center">
          <div className="row__label">
            <span>Workflows</span>
          </div>
          <div className="row__control muted">{data.workflows.length}</div>
        </div>
        <div className="row row--center">
          <div className="row__label">
            <span>Quicklinks</span>
          </div>
          <div className="row__control muted">{data.quicklinks.length}</div>
        </div>
        <div className="row row--center">
          <div className="row__label">
            <span>Snippets</span>
          </div>
          <div className="row__control muted">{data.snippets.length}</div>
        </div>
        <div className="row row--center">
          <div className="row__label">
            <span>Favorites</span>
          </div>
          <div className="row__control muted">{data.favorites.length}</div>
        </div>
      </Group>
    </div>
  );
}
