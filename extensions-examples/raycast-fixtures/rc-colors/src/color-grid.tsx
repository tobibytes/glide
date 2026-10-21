import { Action, ActionPanel, Cache, Detail, Grid, Icon, useNavigation } from "@raycast/api";
import { useState } from "react";

const COLORS = [
  { name: "Tomato", hex: "#FF6347" },
  { name: "Orange", hex: "#FFA500" },
  { name: "Gold", hex: "#FFD700" },
  { name: "Lime", hex: "#32CD32" },
  { name: "Teal", hex: "#008080" },
  { name: "Sky", hex: "#87CEEB" },
  { name: "Navy", hex: "#000080" },
  { name: "Plum", hex: "#DDA0DD" },
];
const EMOJI = ["🍎", "🍊", "🍋", "🥝", "🫐", "🍇"];
const cache = new Cache();

function ColorDetail({ name, hex }: { name: string; hex: string }) {
  const { pop } = useNavigation();
  return (
    <Detail
      markdown={`# ${name}\n\n\`${hex}\``}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Hex" content={hex} />
          <Action title="Back" onAction={pop} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const [last, setLast] = useState(() => cache.get("last") ?? "none");
  return (
    <Grid columns={4} inset={Grid.Inset.Small} navigationTitle={`Last copied: ${last}`} searchBarPlaceholder="Search colours…">
      <Grid.Section title="Colours">
        {COLORS.map((c) => (
          <Grid.Item
            key={c.hex}
            id={c.name}
            title={c.name}
            subtitle={c.hex}
            content={{ color: c.hex }}
            actions={
              <ActionPanel>
                <Action.Push title="Open Colour" icon={Icon.Eye} target={<ColorDetail name={c.name} hex={c.hex} />} />
                <Action.CopyToClipboard
                  title="Copy Hex"
                  content={c.hex}
                  onCopy={() => {
                    cache.set("last", c.hex);
                    setLast(c.hex);
                  }}
                />
              </ActionPanel>
            }
          />
        ))}
      </Grid.Section>
      <Grid.Section title="Fruit">
        {EMOJI.map((e) => (
          <Grid.Item key={e} title={e} content={e} keywords={["fruit"]} actions={<ActionPanel><Action.Paste title="Paste Emoji" content={e} /></ActionPanel>} />
        ))}
      </Grid.Section>
    </Grid>
  );
}
