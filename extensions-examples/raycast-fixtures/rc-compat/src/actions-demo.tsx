import fs from "node:fs";
import path from "node:path";
import { Action, ActionPanel, environment, getFrontmostApplication, getPreferenceValues, getSelectedFinderItems, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";

export default function Command() {
  const { label } = getPreferenceValues<{ label: string }>();
  const [picked, setPicked] = useState("none");
  const [deep, setDeep] = useState(0);
  const [undone, setUndone] = useState(false);
  const [front, setFront] = useState("…");
  const [finder, setFinder] = useState("…");
  const notes = path.join(environment.supportPath, "notes.txt");
  useEffect(() => {
    fs.mkdirSync(environment.supportPath, { recursive: true });
    fs.writeFileSync(notes, "Quick Look preview text\nsecond line\n");
    getFrontmostApplication().then((a) => setFront(`ok:${a.name ? "named" : "unnamed"}`), (e) => setFront(`err:${e.message}`));
    getSelectedFinderItems().then((items) => setFinder(`ok:${items.length}`), (e) => setFinder(`err:${e.message}`));
  }, []);
  const actions = (
    <ActionPanel>
      <Action title="Primary" onAction={() => undefined} />
      <ActionPanel.Submenu title="Share">
        <Action.CopyToClipboard title="Copy Label" content={label} />
        <ActionPanel.Submenu title="Nested">
          <Action title="Deep Action" onAction={() => setDeep((d) => d + 1)} />
        </ActionPanel.Submenu>
      </ActionPanel.Submenu>
      <Action.ToggleQuickLook />
      <Action.PickDate title="Pick a Date" type={Action.PickDate.Type.Date} onChange={(d) => setPicked(d ? d.toISOString().slice(0, 10) : "cleared")} />
      <Action
        title="Toast With Undo"
        shortcut={{ modifiers: ["cmd", "shift"], key: "u" }}
        onAction={() =>
          showToast({
            style: Toast.Style.Success,
            title: "Archived",
            primaryAction: {
              title: "Undo",
              onAction: (toast) => {
                setUndone(true);
                void toast.hide();
              },
            },
          })
        }
      />
      <Action.CreateSnippet snippet={{ name: "Sig", text: "Best, Glide", keyword: ";sig" }} />
      <Action.CreateQuicklink quicklink={{ name: "Search Docs", link: "https://example.com/?q={query}" }} />
    </ActionPanel>
  );
  return (
    <List selectedItemId="second">
      <List.Item id="first" title="First" subtitle={`label=${label}`} actions={actions} quickLook={{ path: notes, name: "notes.txt" }} />
      <List.Item id="second" title="Second" subtitle={`picked=${picked} deep=${deep} undone=${undone}`} actions={actions} quickLook={{ path: notes, name: "notes.txt" }} />
      <List.Item id="third" title="System" subtitle={`front=${front} finder=${finder}`} actions={actions} />
    </List>
  );
}
